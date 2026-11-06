// Bereich Übersicht: Startseite der Entwicklerseite mit Statusleiste und Kacheln.
// Holt alles über GET /api/overview. Jeder Teil der Antwort ist {data} oder
// {error}, ein Fehler betrifft also nur seine Kachel. Lädt jede Minute neu,
// solange der Bereich offen und der Tab sichtbar ist. Beim Neuladen bleiben die
// alten Werte stehen, bis die neuen da sind.

import { h, request, formatDate, formatRelative, formatBytes, formatNumber, errorMessage, describeTime } from "./app.js";

const refreshMs = 60 * 1000;
const cronStaleMs = 2 * 60 * 60 * 1000;
const svgNamespace = "http://www.w3.org/2000/svg";

const shortDayFormat = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" });
const timeFormat = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const releaseFormat = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

const commitTypes = {
  feat: "Feature",
  fix: "Fix",
  docs: "Doku",
  refactor: "Umbau",
  chore: "Pflege",
  test: "Tests",
  style: "Stil",
  perf: "Tempo",
  ci: "CI",
  build: "Build",
  revert: "Zurück",
};

// Feste Reihenfolge, damit jeder Bucket immer dieselbe Farbe hat
const buckets = [
  { id: "audio", name: "Audio", slot: 1 },
  { id: "sheet_music", name: "Noten", slot: 2 },
];

const statusSymbols = { ok: "✓", error: "✕", warn: "!", muted: "•" };
const statusWords = { ok: "in Ordnung", error: "Fehler", warn: "Achtung", muted: "unbekannt" };

// ---------------------------------------------------------------------------
// Kleine Helfer
// ---------------------------------------------------------------------------

function plural(count, one, many) {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

function parseDate(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timeElement(iso) {
  const date = parseDate(iso);
  if (!date) return h("span", { class: "muted" }, "–");
  return h("time", { datetime: date.toISOString(), title: formatDate(iso) }, describeTime(iso));
}

function symbol(kind) {
  return h(
    "span",
    { class: `ov-symbol ov-${kind}` },
    h("span", { "aria-hidden": "true" }, statusSymbols[kind] ?? "•"),
    h("span", { class: "ov-hidden" }, statusWords[kind] ?? ""),
  );
}

function partError(part) {
  return part && typeof part === "object" && typeof part.error === "string" ? part.error : null;
}

function partData(part) {
  return part && typeof part === "object" && part.data && typeof part.data === "object" ? part.data : null;
}

function parseCommitSubject(subject) {
  const match = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.*)$/.exec(subject ?? "");
  if (!match) return { type: null, text: subject ?? "" };
  const type = match[1].toLowerCase();
  return { type: commitTypes[type] ? type : null, text: match[4] || subject };
}

function runState(run) {
  if (!run) return { kind: "muted", label: "noch kein Lauf" };
  if (run.status && run.status !== "completed") {
    return { kind: "warn", label: ["queued", "waiting", "pending", "requested"].includes(run.status) ? "wartet" : "läuft" };
  }
  const conclusions = {
    success: { kind: "ok", label: "bestanden" },
    failure: { kind: "error", label: "fehlgeschlagen" },
    timed_out: { kind: "error", label: "Zeit überschritten" },
    startup_failure: { kind: "error", label: "Start fehlgeschlagen" },
    cancelled: { kind: "muted", label: "abgebrochen" },
    skipped: { kind: "muted", label: "übersprungen" },
    action_required: { kind: "warn", label: "Aktion nötig" },
  };
  return conclusions[run.conclusion] ?? { kind: "muted", label: run.conclusion ?? "unbekannt" };
}

function cronState(run) {
  if (!run) return { kind: "muted", label: "noch kein Lauf" };
  if (run.status === "succeeded") return { kind: "ok", label: "ok" };
  if (run.status === "failed") return { kind: "error", label: "fehlgeschlagen" };
  if (run.status === "running" || run.status === "starting") return { kind: "warn", label: "läuft" };
  return { kind: "muted", label: run.status ?? "unbekannt" };
}

function svgElement(tag, attributes = {}, ...children) {
  const element = document.createElementNS(svgNamespace, tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value != null) element.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

// ---------------------------------------------------------------------------
// Statusleiste
// ---------------------------------------------------------------------------

function statusItem({ key, href, label, kind, value, detail }) {
  return h(
    "li",
    { class: "ov-status-item" },
    h(
      "a",
      { class: `ov-status-link ov-${kind}`, href, "data-focus-key": `status-${key}` },
      h("span", { class: "ov-light", "aria-hidden": "true" }, statusSymbols[kind] ?? "•"),
      h(
        "span",
        { class: "ov-status-text" },
        h("span", { class: "ov-status-label" }, label, h("span", { class: "ov-hidden" }, `: ${statusWords[kind] ?? ""}`)),
        h("span", { class: "ov-status-value" }, value),
        detail ? h("span", { class: "ov-status-detail muted", title: key === "supabase" ? `${detail} (letzte 24 h)` : detail }, detail) : null,
      ),
    ),
  );
}

function supabaseStatus(part) {
  const base = { key: "supabase", href: "#server", label: "Supabase" };
  const error = partError(part);
  if (error) return { ...base, kind: "muted", value: "unbekannt", detail: errorMessage(error) };
  const data = partData(part);
  const last = data?.last;
  const failures = data?.failures ?? 0;
  if (!last) return { ...base, kind: "muted", value: "noch keine Messung", detail: null };
  const failureText = failures ? `${plural(failures, "Fehlmessung", "Fehlmessungen")} in 24 h` : null;
  if (!last.ok) {
    const downSince = parseDate(data?.down_since);
    const since = downSince ? `seit ${timeFormat.format(downSince)} Uhr` : `geprüft ${timeFormat.format(parseDate(last.at) ?? new Date())} Uhr`;
    return { ...base, kind: "error", value: "nicht erreichbar", detail: [since, failureText].filter(Boolean).join(" · ") };
  }
  // Beides passt bei 1200 px nicht in eine Zeile: Fehlmessungen haben Vorrang, der Median rückt dann zum Wert
  const median = data?.median_ms != null ? `Median ${formatNumber(data.median_ms)} ms` : null;
  if (failureText) {
    const value = median ? `${formatNumber(last.ms)} ms · ${median.replace(" ms", "")}` : `${formatNumber(last.ms)} ms`;
    return { ...base, kind: "ok", value, detail: failureText };
  }
  return { ...base, kind: "ok", value: `${formatNumber(last.ms)} ms`, detail: median };
}

function githubStatus(part) {
  const base = { key: "github", href: "#repo", label: "GitHub" };
  const error = partError(part);
  if (error) return { ...base, kind: "muted", value: "unbekannt", detail: errorMessage(error) };
  const data = partData(part);
  if (!data?.configured) return { ...base, kind: "muted", value: "nicht eingerichtet", detail: "GITHUB_TOKEN fehlt" };
  const run = data.latest;
  const state = runState(run);
  if (!run) return { ...base, kind: state.kind, value: state.label, detail: null };
  const short = String(run.commit ?? "").slice(0, 7);
  return { ...base, kind: state.kind, value: state.label, detail: [short, describeTime(run.updated_at ?? run.started_at)].filter(Boolean).join(" · ") };
}

function integrityStatus(part) {
  const base = { key: "integrity", href: "#database", label: "Integrität" };
  const error = partError(part);
  if (error) return { ...base, kind: "muted", value: "unbekannt", detail: errorMessage(error) };
  const data = partData(part);
  const errors = data?.errors ?? 0;
  const warnings = data?.warnings ?? 0;
  if (!errors && !warnings) return { ...base, kind: "ok", value: "keine Funde", detail: null };
  const warningText = warnings ? plural(warnings, "Warnung", "Warnungen") : null;
  if (!errors) return { ...base, kind: "warn", value: warningText, detail: null };
  return { ...base, kind: "error", value: plural(errors, "Fehler", "Fehler"), detail: warningText };
}

function cronStatus(part) {
  const base = { key: "cron", href: "#database", label: "Cron" };
  const error = partError(part);
  if (error) return { ...base, kind: "muted", value: "unbekannt", detail: errorMessage(error) };
  const data = partData(part);
  const run = data?.latest;
  const state = cronState(run);
  const failed = data?.failed_24h ?? 0;
  const failedText = failed ? `${plural(failed, "Fehlschlag", "Fehlschläge")} in 24 h` : null;
  if (!run) return { ...base, kind: state.kind, value: state.label, detail: null };
  // Der Job läuft stündlich. Kam seit 2 Stunden keiner, hängt der Cron.
  const started = parseDate(run.started_at);
  if (started && Date.now() - started.getTime() > cronStaleMs && state.kind !== "error") {
    return { ...base, kind: "warn", value: `kein Lauf seit ${formatRelative(run.started_at).replace(/^vor /, "")}`, detail: failedText };
  }
  return { ...base, kind: state.kind, value: `${state.label} · ${describeTime(run.started_at)}`, detail: failedText };
}

function statusStrip(data) {
  return h(
    "ul",
    { class: "ov-status", "aria-label": "Status" },
    [supabaseStatus(data.latency), githubStatus(data.ci), integrityStatus(data.integrity), cronStatus(data.cron)].map(statusItem),
  );
}

// ---------------------------------------------------------------------------
// Kacheln
// ---------------------------------------------------------------------------

// Die ganze Kachel ist anklickbar: Der Link sitzt in der Überschrift und
// spannt per CSS über die Kachel. So bleibt der Name des Links kurz.
function tile({ key, title, href }, part, render, meta) {
  const error = partError(part);
  const data = partData(part);
  let body;
  if (error) {
    body = h("p", { class: "ov-error", role: "status" }, symbol("error"), errorMessage(error));
  } else if (!data) {
    body = h("p", { class: "muted" }, "Keine Daten");
  } else {
    body = render(data);
  }
  const metaContent = !error && data && meta ? meta(data) : null;
  // Klick irgendwo auf die Kachel öffnet den Bereich, außer beim Markieren von Text.
  // Die Tastatur nimmt den Link in der Überschrift.
  // Ohne href (Inhalt) gibt es keinen Bereich mit mehr Details, die Kachel ist dann nur Anzeige.
  const open = (event) => {
    if (event.target.closest?.("a")) return;
    if (String(window.getSelection?.() ?? "")) return;
    location.hash = href;
  };
  return h(
    "section",
    { class: `panel ov-tile ov-tile-${key}${href ? " ov-tile-linked" : ""}`, "aria-labelledby": `ov-title-${key}`, onclick: href ? open : null },
    h(
      "div",
      { class: "ov-tile-head" },
      h("h2", { id: `ov-title-${key}` }, href ? h("a", { class: "ov-tile-link", href, "data-focus-key": `tile-${key}` }, title) : title),
      metaContent ? h("span", { class: "ov-tile-meta muted" }, metaContent) : null,
    ),
    h("div", { class: "ov-tile-body" }, body),
  );
}

function contentTile(data) {
  const songs = data.songs ?? 0;
  const pending = Math.min(data.pending_songs ?? 0, songs);
  const rows = [
    { label: "Songs", value: songs, pending },
    { label: "Playbacks", value: data.playbacks ?? 0 },
    { label: "Noten", value: data.sheet_music ?? 0 },
    { label: "Einzähler", value: data.count_ins ?? 0 },
  ];
  const maximum = Math.max(1, ...rows.map((row) => row.value));
  return h(
    "div",
    { class: "ov-content" },
    h(
      "ul",
      { class: "ov-bars", "aria-label": "Inhalt" },
      rows.map((row) => {
        const visible = row.value - (row.pending ?? 0);
        const tooltip = row.pending ? `${row.label}: ${formatNumber(row.value)}, davon ${formatNumber(row.pending)} wartend` : `${row.label}: ${formatNumber(row.value)}`;
        return h(
          "li",
          { class: "ov-bar-row", title: tooltip },
          h("span", { class: "ov-bar-label" }, row.label),
          h(
            "span",
            { class: "ov-bar-track", "aria-hidden": "true" },
            visible > 0 ? h("span", { class: "ov-bar", style: `width: ${(visible / maximum) * 100}%` }) : null,
            row.pending ? h("span", { class: "ov-bar ov-bar-pending", style: `width: ${(row.pending / maximum) * 100}%` }) : null,
          ),
          h("span", { class: "ov-bar-value" }, formatNumber(row.value), row.pending ? h("span", { class: "ov-hidden" }, `, davon ${formatNumber(row.pending)} wartend`) : null),
        );
      }),
    ),
    pending
      ? h(
          "p",
          { class: "ov-legend muted" },
          h("span", { class: "ov-swatch", "aria-hidden": "true" }),
          "sichtbar",
          h("span", { class: "ov-swatch ov-swatch-pending", "aria-hidden": "true" }),
          `${formatNumber(pending)} wartend`,
        )
      : null,
  );
}

function contentMeta(data) {
  return plural(data.categories ?? 0, "Kategorie", "Kategorien");
}

// Ring mit 2 px Lücke zwischen den Teilen, Gesamtgröße in der Mitte
function storageRing(parts, total) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const gap = parts.filter((part) => part.bytes > 0).length > 1 ? 2 : 0;
  let offset = 0;
  const segments = parts.map((part) => {
    const length = total > 0 ? (part.bytes / total) * circumference : 0;
    const visible = Math.max(0, length - gap);
    const segment =
      visible > 0
        ? svgElement(
            "circle",
            {
              class: `ov-ring-part ov-slot-${part.slot}`,
              cx: 50,
              cy: 50,
              r: radius,
              "stroke-dasharray": `${visible} ${circumference - visible}`,
              "stroke-dashoffset": -offset,
            },
            svgElement("title", {}, `${part.name}: ${formatBytes(part.bytes)}`),
          )
        : null;
    offset += length;
    return segment;
  });
  return h(
    "div",
    { class: "ov-ring" },
    svgElement(
      "svg",
      { viewBox: "0 0 100 100", role: "img", "aria-label": `Speicher: ${parts.map((part) => `${part.name} ${formatBytes(part.bytes)}`).join(", ")}` },
      svgElement("circle", { class: "ov-ring-track", cx: 50, cy: 50, r: radius }),
      svgElement("g", { transform: "rotate(-90 50 50)" }, segments),
    ),
    h("span", { class: "ov-ring-total" }, formatBytes(total)),
  );
}

function storageTile(data) {
  const rows = Array.isArray(data.buckets) ? data.buckets : [];
  const parts = buckets.map((bucket) => {
    const row = rows.find((candidate) => candidate.bucket === bucket.id);
    return { ...bucket, bytes: row?.total_bytes ?? 0, files: row?.file_count ?? 0 };
  });
  const total = data.total_bytes ?? parts.reduce((sum, part) => sum + part.bytes, 0);
  if (!total) return h("p", { class: "muted" }, "Keine Dateien");
  return h(
    "div",
    { class: "ov-storage" },
    storageRing(parts, total),
    h(
      "ul",
      { class: "ov-storage-list" },
      parts.map((part) =>
        h(
          "li",
          {},
          h("span", { class: "ov-storage-name" }, h("span", { class: `ov-swatch ov-slot-${part.slot}`, "aria-hidden": "true" }), part.name),
          h("span", { class: "ov-storage-size" }, formatBytes(part.bytes)),
          h("span", { class: "ov-storage-files muted" }, plural(part.files, "Datei", "Dateien")),
        ),
      ),
    ),
  );
}

function releaseContents(release) {
  const parts = [];
  if (release.playbacks) parts.push(plural(release.playbacks, "Playback", "Playbacks"));
  if (release.sheet_music) parts.push(plural(release.sheet_music, "Note", "Noten"));
  if (release.count_ins) parts.push(plural(release.count_ins, "Einzähler", "Einzähler"));
  return parts.join(" · ");
}

function releasesTile(data) {
  const next = data.next;
  if (!next) return h("p", { class: "ov-quiet" }, "Nichts wartet");
  const contents = releaseContents(next);
  const date = parseDate(next.release_at);
  const due = (date?.getTime() ?? Infinity) <= Date.now();
  return h(
    "div",
    { class: "ov-release" },
    h("p", { class: "ov-big" }, due ? "fällig" : timeElement(next.release_at)),
    h("p", { class: "muted" }, due ? "beim nächsten Cron-Lauf" : date ? `${releaseFormat.format(date)} Uhr` : "–"),
    h(
      "p",
      { class: "ov-release-song" },
      h("strong", {}, next.song_name ?? "Unbekannter Song"),
      next.category_name ? h("span", { class: "muted" }, ` · ${next.category_name}`) : null,
    ),
    h(
      "p",
      { class: "ov-release-kind" },
      h("span", { class: `chip ${next.is_new_song ? "warn" : "muted"}` }, next.is_new_song ? "Neuer Song" : "Änderung"),
      contents ? h("span", { class: "muted" }, contents) : null,
    ),
  );
}

function releasesMeta(data) {
  return data.more ? `+${formatNumber(data.more)} weitere` : null;
}

function weekColumns(weeks) {
  const maximum = Math.max(1, ...weeks.map((week) => week.commits ?? 0));
  const total = weeks.reduce((sum, week) => sum + (week.commits ?? 0), 0);
  return h(
    "ol",
    { class: "ov-weeks", "aria-label": `Commits pro Woche, letzte ${weeks.length} Wochen, zusammen ${total}` },
    weeks.map((week, index) => {
      const commits = week.commits ?? 0;
      const start = parseDate(week.week_start);
      const current = index === weeks.length - 1;
      const label = `${start ? `ab ${shortDayFormat.format(start)}` : "Woche"}: ${plural(commits, "Commit", "Commits")}${current ? " (laufend)" : ""}`;
      return h(
        "li",
        { class: `ov-week${current ? " ov-week-current" : ""}`, title: label },
        h("span", { class: "ov-hidden" }, label),
        commits > 0 ? h("span", { class: "ov-week-bar", style: `height: ${(commits / maximum) * 100}%`, "aria-hidden": "true" }) : null,
      );
    }),
  );
}

function repoTile(data) {
  const latest = data.latest;
  const subject = parseCommitSubject(latest?.subject);
  const thisWeek = data.this_week ?? 0;
  const lastWeek = data.last_week ?? 0;
  const weeks = Array.isArray(data.weeks) ? data.weeks : [];
  return h(
    "div",
    { class: "ov-repo" },
    h(
      "div",
      { class: "ov-repo-facts" },
      latest
        ? h(
            "p",
            { class: "ov-commit", title: latest.subject ?? "" },
            subject.type ? h("span", { class: `chip repo-type repo-type-${subject.type}` }, commitTypes[subject.type]) : null,
            h("span", { class: "ov-commit-text" }, subject.text),
          )
        : h("p", { class: "muted" }, "Noch keine Commits"),
      latest
        ? h(
            "p",
            { class: "ov-commit-meta muted" },
            h("span", { class: "mono", title: latest.hash ?? "" }, latest.short ?? String(latest.hash ?? "").slice(0, 7)),
            " · ",
            timeElement(latest.date),
          )
        : null,
      h(
        "p",
        { class: "ov-week-compare" },
        h("span", { class: "ov-big" }, formatNumber(thisWeek)),
        h("span", {}, " diese Woche"),
        h("span", { class: "muted" }, ` · ${formatNumber(lastWeek)} Vorwoche`),
      ),
    ),
    weeks.length ? weekColumns(weeks) : null,
    weeks.length
      ? h(
          "p",
          { class: "ov-weeks-axis muted", "aria-hidden": "true" },
          h("span", {}, parseDate(weeks[0].week_start) ? shortDayFormat.format(parseDate(weeks[0].week_start)) : ""),
          h("span", {}, "diese Woche"),
        )
      : null,
  );
}

function repoMeta(data) {
  return data.fetched_at ? ["gepullt ", timeElement(data.fetched_at)] : null;
}

function deliveryKind(statusCode) {
  if (statusCode == null) return { kind: "muted", label: "Zustellung unbekannt" };
  if (statusCode >= 200 && statusCode < 300) return { kind: "ok", label: "zugestellt" };
  return { kind: "error", label: `Fehler ${statusCode}` };
}

function notificationsTile(data) {
  const latest = Array.isArray(data.latest) ? data.latest.slice(0, 3) : [];
  if (!latest.length) return h("p", { class: "ov-quiet" }, "Noch keine Nachrichten");
  return h(
    "ol",
    { class: "ov-messages" },
    latest.map((message) => {
      const delivery = deliveryKind(message.status_code);
      return h(
        "li",
        { class: "ov-message" },
        h(
          "span",
          { class: `ov-symbol ov-${delivery.kind}`, title: delivery.label },
          h("span", { "aria-hidden": "true" }, statusSymbols[delivery.kind]),
          h("span", { class: "ov-hidden" }, `${delivery.label}: `),
        ),
        h("strong", { class: "ov-message-title" }, message.title ?? "Nachricht"),
        h("span", { class: "ov-message-text muted" }, String(message.message ?? "").split("\n")[0]),
        h("span", { class: "ov-message-time muted" }, timeElement(message.sent_at)),
      );
    }),
  );
}

function tiles(data) {
  return h(
    "div",
    { class: "ov-grid" },
    tile({ key: "content", title: "Inhalt", href: null }, data.content, contentTile, contentMeta),
    tile({ key: "storage", title: "Speicher", href: "#database" }, data.storage, storageTile),
    tile({ key: "releases", title: "Nächste Freigabe", href: "#database" }, data.releases, releasesTile, releasesMeta),
    tile({ key: "repo", title: "Repo", href: "#repo" }, data.repo, repoTile, repoMeta),
    tile({ key: "notifications", title: "Nachrichten", href: "#messages" }, data.notifications, notificationsTile),
  );
}

// ---------------------------------------------------------------------------
// Bereich
// ---------------------------------------------------------------------------

function isSessionExpired(error) {
  return error?.name === "SessionExpired" || error?.constructor?.name === "SessionExpired" || error?.code === "unauthorized";
}

export function renderOverview(container, { signal } = {}) {
  const controller = new AbortController();
  const notice = h("p", { class: "ov-notice", role: "status", "aria-live": "polite" });
  const body = h("div", { class: "ov-body", "aria-busy": "true" }, h("p", { class: "loading", role: "status" }, "Lädt …"));
  let timer = null;
  let loading = false;
  let hasData = false;
  let alive = true;
  let shownKey = null;

  const dispose = () => {
    if (!alive) return;
    alive = false;
    clearTimeout(timer);
    controller.abort();
    document.removeEventListener("visibilitychange", onVisibility);
  };
  if (signal) {
    if (signal.aborted) dispose();
    else signal.addEventListener("abort", dispose, { once: true });
  }

  function schedule() {
    clearTimeout(timer);
    if (!alive || document.visibilityState !== "visible") return;
    timer = setTimeout(refresh, refreshMs);
  }

  function onVisibility() {
    if (document.visibilityState === "visible") refresh();
    else clearTimeout(timer);
  }

  // Ersetzt den Inhalt in einem Rutsch und gibt den Fokus an dasselbe Element zurück.
  // Sieht der neue Inhalt genauso aus wie der alte, bleibt der alte stehen:
  // Textauswahl, Tooltips und die Leseposition des Screenreaders gehen dann
  // nicht verloren. Verglichen wird das Ergebnis, nicht die Antwort, damit
  // relative Zeiten wie "vor 5 Min." und die Cron-Ampel trotzdem mitlaufen.
  function show(data) {
    const content = [statusStrip(data), tiles(data)];
    const key = content.map((element) => element.outerHTML).join("");
    if (key === shownKey) return;
    shownKey = key;
    const focusKey = document.activeElement?.closest?.("[data-focus-key]")?.dataset.focusKey ?? null;
    body.replaceChildren(...content);
    if (focusKey) body.querySelector(`[data-focus-key="${focusKey}"]`)?.focus({ preventScroll: true });
  }

  async function refresh() {
    if (loading || !alive) return;
    loading = true;
    clearTimeout(timer);
    body.setAttribute("aria-busy", "true");
    try {
      const data = await request("/api/overview", { signal: controller.signal });
      if (!alive) return;
      show(data ?? {});
      hasData = true;
      notice.textContent = "";
      notice.removeAttribute("title");
    } catch (error) {
      if (!alive || error?.name === "AbortError") return;
      if (isSessionExpired(error)) {
        dispose();
        return;
      }
      const text = errorMessage(error?.code);
      if (hasData) {
        notice.textContent = `Nicht aktuell: ${text}`;
      } else {
        body.replaceChildren(h("div", { class: "error-box", role: "alert" }, h("p", {}, text)));
        shownKey = null;
      }
    } finally {
      loading = false;
      if (alive) {
        body.removeAttribute("aria-busy");
        schedule();
      }
    }
  }

  if (alive) document.addEventListener("visibilitychange", onVisibility);

  container.replaceChildren(
    h("div", { class: "page ov-page" }, h("h1", { class: "visually-hidden" }, "Übersicht"), notice, body),
  );

  refresh();
  return dispose;
}
