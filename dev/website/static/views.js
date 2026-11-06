// Bereiche Repo, Datenbank, Nachrichten und Server der Entwicklerseite.
// Jede render-Funktion bekommt ({ signal }) von app.js. Bricht das Signal ab
// (Bereichswechsel), stoppen Timer, Beobachter und laufende Anfragen. Zusätzlich
// gibt sie eine Aufräumfunktion zurück, die dasselbe tut.

import { h, request, formatDate, formatBytes, renderMarkdown, confirmDialog, errorMessage, describeTime } from "./app.js";

const svgNamespace = "http://www.w3.org/2000/svg";
const checksumPollMs = 1500;
const checksumRetryMs = 5000;
const checksumMaxFailures = 3;
const unusedHint = "Nur Upload-Tool-Dateien, älter als 1 Std.";
const latencyRefreshMs = 60 * 1000;
const ciRefreshMs = 60 * 1000;
const commitPageSize = 50;
const cronVisibleRuns = 6;
const languageSlots = 7;

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
  other: "Sonstige",
};

const integrityChecks = {
  song_without_playback: {
    title: "Song ohne Playback",
    text: "Sichtbar, kein sichtbares Playback.",
  },
  song_without_sheet_music: {
    title: "Song ohne Noten",
  },
  letter_out_of_range: {
    title: "Buchstabe außerhalb des Playbacks",
    text: "Position vor 0:00 oder nach MP3-Ende.",
  },
  letter_count_in_other_song: {
    title: "Einzähler aus anderem Song",
    text: "Buchstabe nutzt Einzähler eines anderen Songs.",
  },
  count_in_unused: {
    title: "Einzähler ohne Buchstaben",
  },
  missing_sha256: {
    title: "Prüfsumme fehlt",
  },
  file_missing: {
    title: "Datei fehlt im Bucket",
  },
  duplicate_file: {
    title: "Datei doppelt",
    text: "Gleiche Prüfsumme in mehreren Zeilen.",
  },
  release_overdue: {
    title: "Freigabe überfällig",
    text: "Über 2 Std. fällig, nicht übernommen.",
  },
  replaces_other_song: {
    title: "Ersetzt Zeile eines anderen Songs",
    text: "replaces_id zeigt auf anderen Song.",
  },
  invalid_duration: {
    title: "Ungültige Länge",
    text: "Länge ≤ 0.",
  },
  display_without_effect: {
    title: "Sichtbarkeit ohne Wirkung",
    text: "Für alle sichtbar, trotzdem Instrument-Einträge.",
  },
  category_empty: {
    title: "Leere Kategorie",
  },
};

const tableNames = {
  song: "Song",
  playback: "Playback",
  count_in: "Einzähler",
  sheet_music: "Noten",
  letter: "Buchstabe",
  display_playback: "Sichtbarkeit",
  category: "Kategorie",
};

const timeFormat = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
const dayYearFormat = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
const shortDayFormat = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit" });
const shortDateFormat = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
const monthFormat = new Intl.DateTimeFormat("de-DE", { month: "short" });
const numberFormat = new Intl.NumberFormat("de-DE");
const percentFormat = new Intl.NumberFormat("de-DE", { style: "percent", maximumFractionDigits: 1 });

let repoTab = "history";

// ---------------------------------------------------------------------------
// Laden und Fehler
// ---------------------------------------------------------------------------

class ViewError extends Error {
  constructor(code, status = null) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function isSessionExpired(error) {
  return error?.name === "SessionExpired" || error?.constructor?.name === "SessionExpired";
}

function normalizeError(error) {
  if (isSessionExpired(error) || error instanceof ViewError || error?.name === "AbortError") return error;
  if (typeof error?.code === "string") return new ViewError(error.code, error.status ?? null);
  if (error instanceof TypeError) return new ViewError("network");
  return new ViewError("unknown");
}

// request() aus app.js liefert die gelesenen Daten. Eine Response wird zur Sicherheit auch verstanden.
async function load(path, life, options = {}) {
  let result;
  try {
    result = await request(path, { ...options, signal: life.signal });
  } catch (error) {
    throw normalizeError(error);
  }
  if (typeof Response !== "undefined" && result instanceof Response) {
    if (result.status === 204) return null;
    let body = null;
    try {
      body = await result.json();
    } catch {
      body = null;
    }
    if (!result.ok) throw new ViewError(body?.error ?? "unknown", result.status);
    return body;
  }
  return result ?? null;
}

function errorText(error) {
  if (isSessionExpired(error)) return errorMessage("unauthorized");
  return errorMessage(error?.code ?? "unknown");
}

function lifecycle(parentSignal = null) {
  const cleanups = [];
  const controller = new AbortController();
  let alive = true;
  const life = {
    get alive() {
      return alive;
    },
    get signal() {
      return controller.signal;
    },
    onCleanup(cleanup) {
      cleanups.push(cleanup);
    },
    dispose() {
      if (!alive) return;
      alive = false;
      controller.abort();
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          cleanup();
        } catch {
          // Aufräumen darf das Verlassen eines Bereichs nie aufhalten
        }
      }
    },
  };
  if (parentSignal) {
    if (parentSignal.aborted) life.dispose();
    else parentSignal.addEventListener("abort", () => life.dispose(), { once: true });
  }
  return life;
}

function fill(element, ...children) {
  element.replaceChildren(...children.flat(Infinity).filter((child) => child != null && child !== false));
}

function loadingView(text = "Lädt …") {
  return h("p", { class: "loading", role: "status" }, text);
}

function errorView(error, retry) {
  return h(
    "div",
    { class: "error-box", role: "alert" },
    h("p", {}, errorText(error)),
    retry ? h("button", { class: "button small", type: "button", onclick: retry }, "Erneut versuchen") : null,
  );
}

function emptyView(title, text, action = null) {
  return h("div", { class: "empty" }, h("p", { class: "view-empty-title" }, title), text ? h("p", { class: "muted" }, text) : null, action);
}

// Lädt in einen Platzhalter. Beim Neuladen bleibt der alte Inhalt gedimmt stehen.
async function loadInto(slot, life, path, render) {
  const hadContent = slot.childElementCount > 0 && !slot.querySelector(":scope > .loading, :scope > .error-box");
  if (hadContent) slot.classList.add("view-refreshing");
  else fill(slot, loadingView());
  slot.setAttribute("aria-busy", "true");
  try {
    const data = await load(path, life);
    if (!life.alive) return null;
    fill(slot, render(data));
    return data;
  } catch (error) {
    if (!life.alive) return null;
    fill(slot, errorView(error, () => loadInto(slot, life, path, render)));
    return null;
  } finally {
    slot.classList.remove("view-refreshing");
    slot.removeAttribute("aria-busy");
  }
}

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

function panel({ title, actions = null, wide = false, className = "" }, ...children) {
  return h(
    "section",
    { class: `panel${wide ? " view-wide" : ""}${className ? ` ${className}` : ""}` },
    h("div", { class: "panel-head" }, h("h2", {}, title), actions ? h("div", { class: "view-panel-actions" }, actions) : null),
    ...children,
  );
}

// Zwei Panels gleicher Breite über die ganze Zeile, damit das Raster nie halb leer bleibt
function pair(...panels) {
  return h("div", { class: "view-pair" }, ...panels);
}

// Höhe eines Panels ohne Streckung: Oberkante bis Ende des letzten Inhalts plus Innenabstand unten
function naturalPanelHeight(element) {
  const last = element.lastElementChild;
  if (!last) return element.getBoundingClientRect().height;
  const style = getComputedStyle(element);
  return last.getBoundingClientRect().bottom - element.getBoundingClientRect().top + parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
}

// Der Bereich steht schon in der Navigation, der Titel ist nur für Screenreader da
function pageTitle(title) {
  return h("h1", { class: "visually-hidden" }, title);
}

function statusChip(kind, label) {
  const symbols = { ok: "✓", error: "✕", warn: "!", muted: "•" };
  return h("span", { class: `chip ${kind}` }, h("span", { class: "view-chip-symbol", "aria-hidden": "true" }, symbols[kind] ?? "•"), label);
}

function table(headers, rows, className = "") {
  return h(
    "div",
    { class: "view-table-scroll" },
    h(
      "table",
      { class: `table${className ? ` ${className}` : ""}` },
      h("thead", {}, h("tr", {}, headers.map((header) => h("th", { scope: "col", class: header.numeric ? "view-numeric" : null }, header.label ?? header)))),
      h("tbody", {}, rows),
    ),
  );
}

function cell(content, { numeric = false, mono = false, className = "" } = {}) {
  const classes = [numeric ? "view-numeric" : "", mono ? "mono" : "", className].filter(Boolean).join(" ");
  return h("td", { class: classes || null }, content);
}

function timeElement(iso, { relative = true } = {}) {
  const date = parseDate(iso);
  if (!date) return h("span", { class: "muted" }, "–");
  return h("time", { datetime: date.toISOString(), title: formatDate(iso) }, relative ? describeTime(iso) : formatDate(iso));
}

function parseDate(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function durationText(startIso, endIso) {
  const start = parseDate(startIso);
  const end = parseDate(endIso);
  if (!start || !end) return "–";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 1) return "< 1 s";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayTitle(date) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(date) === dayKey(today)) return "Heute";
  if (dayKey(date) === dayKey(yesterday)) return "Gestern";
  return (date.getFullYear() === today.getFullYear() ? dayFormat : dayYearFormat).format(date);
}

function groupByDay(items, dateOf) {
  const groups = [];
  for (const item of items) {
    const date = parseDate(dateOf(item));
    const key = date ? dayKey(date) : "unknown";
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      group = { key, title: date ? dayTitle(date) : "Ohne Datum", items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

function plural(count, one, many) {
  return `${numberFormat.format(count)} ${count === 1 ? one : many}`;
}

function safeExternalUrl(url, allowedPrefix) {
  return typeof url === "string" && url.startsWith(allowedPrefix) ? url : null;
}

function subTabs(tabs, current, onSelect, label) {
  const buttons = tabs.map(([id, title]) =>
    h(
      "button",
      {
        class: "tab view-tab",
        type: "button",
        role: "tab",
        id: `view-tab-${id}`,
        "aria-selected": id === current ? "true" : "false",
        tabindex: id === current ? "0" : "-1",
        onclick: () => onSelect(id),
      },
      title,
    ),
  );
  const list = h("div", { class: "tabs view-tabs", role: "tablist", "aria-label": label }, buttons);
  list.addEventListener("keydown", (event) => {
    const index = tabs.findIndex(([id]) => id === current);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (step == null) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length][0];
    onSelect(next);
    list.querySelector(`#view-tab-${next}`)?.focus();
  });
  return list;
}

// ---------------------------------------------------------------------------
// Diagramme (SVG, ohne Bibliothek)
// ---------------------------------------------------------------------------

function svg(tag, attributes = {}, ...children) {
  const element = document.createElementNS(svgNamespace, tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null || value === false) continue;
    element.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function niceTicks(maximum, count = 4) {
  if (!(maximum > 0)) return [0, 1];
  const rough = maximum / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? 10 * magnitude;
  const ticks = [];
  for (let value = 0; value <= maximum + step * 0.001; value += step) ticks.push(Math.round(value * 1000) / 1000);
  if (ticks.at(-1) < maximum) ticks.push(ticks.at(-1) + step);
  return ticks;
}

// Säule mit 4 px runder Oberkante, unten eckig auf der Grundlinie
function columnPath(x, y, width, height) {
  if (height <= 0) return "";
  const radius = Math.min(4, height, width / 2);
  return [
    `M${x},${y + height}`,
    `V${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `H${x + width - radius}`,
    `Q${x + width},${y} ${x + width},${y + radius}`,
    `V${y + height}`,
    "Z",
  ].join(" ");
}

function tooltipLayer(frame) {
  const tooltip = h("div", { class: "viz-tooltip", role: "status", "aria-live": "polite", hidden: true });
  frame.append(tooltip);
  return {
    show(x, y, rows) {
      fill(
        tooltip,
        rows.map((row) =>
          h(
            "div",
            { class: "viz-tooltip-row" },
            row.key ? h("span", { class: `viz-key ${row.key}`, "aria-hidden": "true" }) : null,
            h("strong", {}, row.value),
            row.label ? h("span", { class: "viz-tooltip-label" }, row.label) : null,
          ),
        ),
      );
      tooltip.hidden = false;
      const frameWidth = frame.clientWidth;
      const width = tooltip.offsetWidth;
      // Rechts vom Punkt, wenn Platz ist, sonst links davon
      const left = x + 12 + width <= frameWidth - 8 ? x + 12 : x - width - 12;
      tooltip.style.left = `${Math.max(8, left)}px`;
      tooltip.style.top = `${Math.max(4, y - tooltip.offsetHeight - 8)}px`;
    },
    hide() {
      tooltip.hidden = true;
    },
  };
}

// Ein Tab-Halt pro Diagramm: Zeiger und Pfeiltasten wählen einen Datenpunkt
function indexedPointer(overlay, count, indexAt, onSelect, onLeave) {
  let current = null;
  const select = (index) => {
    current = Math.max(0, Math.min(count - 1, index));
    onSelect(current);
  };
  overlay.addEventListener("pointermove", (event) => {
    const box = overlay.getBoundingClientRect();
    select(indexAt(event.clientX - box.left));
  });
  overlay.addEventListener("pointerleave", () => {
    if (document.activeElement !== overlay) onLeave();
  });
  overlay.addEventListener("focus", () => select(current ?? count - 1));
  overlay.addEventListener("blur", onLeave);
  overlay.addEventListener("keydown", (event) => {
    const steps = { ArrowRight: 1, ArrowLeft: -1, PageUp: -10, PageDown: 10 };
    if (event.key === "Home") select(0);
    else if (event.key === "End") select(count - 1);
    else if (event.key in steps) select((current ?? count - 1) + steps[event.key]);
    else if (event.key === "Escape") return onLeave();
    else return;
    event.preventDefault();
  });
}

// Zeichnet neu, wenn sich die Breite ändert
function responsiveChart(frame, life, draw) {
  let lastWidth = 0;
  let frameRequest = 0;
  const redraw = () => {
    const width = Math.round(frame.clientWidth);
    if (!width || width === lastWidth) return;
    lastWidth = width;
    draw(width);
  };
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frameRequest);
    frameRequest = requestAnimationFrame(redraw);
  });
  observer.observe(frame);
  life.onCleanup(() => {
    observer.disconnect();
    cancelAnimationFrame(frameRequest);
  });
  requestAnimationFrame(redraw);
  return {
    force() {
      lastWidth = 0;
      redraw();
    },
  };
}

function weekChart(allWeeks, life) {
  // Wochen vor dem ersten Commit wären nur leere Fläche
  const firstActive = allWeeks.findIndex((week) => week.commits > 0);
  const weeks = firstActive > 0 ? allWeeks.slice(firstActive) : allWeeks;
  const frame = h("div", { class: "viz-frame" });
  const chartSlot = h("div", {});
  frame.append(chartSlot);
  const tooltip = tooltipLayer(frame);
  const total = weeks.reduce((sum, week) => sum + week.commits, 0);

  responsiveChart(frame, life, (width) => {
    const height = 200;
    const margin = { top: 12, right: 8, bottom: 26, left: 32 };
    const plotWidth = Math.max(10, width - margin.left - margin.right);
    const plotHeight = height - margin.top - margin.bottom;
    const ticks = niceTicks(Math.max(1, ...weeks.map((week) => week.commits)), 4);
    const maximum = ticks.at(-1);
    const band = plotWidth / Math.max(1, weeks.length);
    const barWidth = Math.max(1, Math.min(24, band - 2));
    const y = (value) => margin.top + plotHeight - (value / maximum) * plotHeight;

    const grid = ticks.map((tick) =>
      svg(
        "g",
        {},
        svg("line", { class: tick === 0 ? "viz-baseline" : "viz-grid", x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick) }),
        svg("text", { class: "viz-axis-label", x: margin.left - 6, y: y(tick), "text-anchor": "end", "dominant-baseline": "middle" }, numberFormat.format(tick)),
      ),
    );

    // Monatsnamen nur mit genug Abstand, sonst überlappen sie auf schmalen Bildschirmen
    const monthLabels = [];
    const minimumLabelGap = 34;
    let lastMonth = null;
    let lastLabelX = -Infinity;
    weeks.forEach((week, index) => {
      const date = parseDate(week.week_start);
      if (!date) return;
      const month = date.getMonth();
      if (month !== lastMonth) {
        const x = margin.left + band * index;
        if (lastMonth !== null && x - lastLabelX >= minimumLabelGap && x <= width - margin.right - 20) {
          monthLabels.push(svg("text", { class: "viz-axis-label", x, y: height - 8, "text-anchor": "start" }, monthFormat.format(date)));
          lastLabelX = x;
        }
        lastMonth = month;
      }
    });

    const bars = weeks.map((week, index) => {
      const x = margin.left + band * index + (band - barWidth) / 2;
      const top = y(week.commits);
      return svg("path", { class: "viz-bar", d: columnPath(x, top, barWidth, margin.top + plotHeight - top), "data-index": index });
    });

    const highlight = svg("rect", { class: "viz-band-highlight", x: 0, y: margin.top, width: band, height: plotHeight, visibility: "hidden" });
    const overlay = svg("rect", {
      class: "viz-overlay",
      x: margin.left,
      y: margin.top,
      width: plotWidth,
      height: plotHeight,
      tabindex: "0",
      role: "img",
      "aria-label": `Commits pro Woche, ${weeks.length} Wochen, zusammen ${total}. Pfeiltasten wählen eine Woche.`,
    });
    const chart = svg(
      "svg",
      { class: "viz-svg", width, height, viewBox: `0 0 ${width} ${height}` },
      grid,
      highlight,
      bars,
      monthLabels,
      overlay,
    );
    fill(chartSlot, chart);

    indexedPointer(
      overlay,
      weeks.length,
      (x) => Math.floor(x / band),
      (index) => {
        const week = weeks[index];
        const start = parseDate(week.week_start);
        highlight.setAttribute("x", String(margin.left + band * index));
        highlight.setAttribute("visibility", "visible");
        tooltip.show(margin.left + band * index + band / 2, y(week.commits), [
          { value: plural(week.commits, "Commit", "Commits"), label: start ? `Woche ab ${shortDayFormat.format(start)}` : "" },
        ]);
      },
      () => {
        highlight.setAttribute("visibility", "hidden");
        tooltip.hide();
      },
    );
  });

  const tableView = h(
    "details",
    { class: "viz-table-toggle" },
    h("summary", {}, "Als Tabelle"),
    table(
      ["Woche ab", { label: "Commits", numeric: true }],
      [...weeks].reverse().map((week) =>
        h("tr", {}, cell(parseDate(week.week_start) ? shortDayFormat.format(parseDate(week.week_start)) : "–"), cell(numberFormat.format(week.commits), { numeric: true })),
      ),
    ),
  );
  return [frame, tableView];
}

function languageChart(languages) {
  // "Andere" vom Server landet immer im grauen Rest, nie auf einem Farbplatz
  const sorted = languages.filter((item) => item.language !== "Andere").sort((a, b) => b.lines - a.lines);
  const shown = sorted.slice(0, languageSlots);
  const rest = sorted.slice(languageSlots).concat(languages.filter((item) => item.language === "Andere"));
  if (rest.length) {
    shown.push({
      language: "Andere",
      files: rest.reduce((sum, item) => sum + item.files, 0),
      lines: rest.reduce((sum, item) => sum + item.lines, 0),
      other: true,
    });
  }
  const totalLines = shown.reduce((sum, item) => sum + item.lines, 0);
  const parts = shown.filter((item) => item.lines > 0);
  const slotClass = (item, index) => (item.other ? "viz-series-other" : `viz-series-${index + 1}`);

  const frame = h("div", { class: "viz-frame" });
  const tooltip = tooltipLayer(frame);
  const bar = h(
    "div",
    { class: "viz-segmented", role: "group", "aria-label": "Zeilen pro Sprache" },
    parts.map((item, index) => {
      const share = totalLines ? item.lines / totalLines : 0;
      const label = `${item.language}: ${numberFormat.format(item.lines)} Zeilen, ${percentFormat.format(share)}`;
      const segment = h(
        "div",
        {
          class: `viz-segment ${slotClass(item, index)}`,
          style: `flex-grow: ${item.lines}`,
          tabindex: "0",
          role: "img",
          "aria-label": label,
        },
        share >= 0.09 ? h("span", { class: "viz-segment-label" }, percentFormat.format(share)) : null,
      );
      const show = () => {
        const frameBox = frame.getBoundingClientRect();
        const box = segment.getBoundingClientRect();
        tooltip.show(box.left - frameBox.left + box.width / 2, box.top - frameBox.top, [
          { value: `${numberFormat.format(item.lines)} Zeilen`, label: `${item.language} · ${percentFormat.format(share)}`, key: slotClass(item, index) },
        ]);
      };
      segment.addEventListener("pointerenter", show);
      segment.addEventListener("focus", show);
      segment.addEventListener("pointerleave", () => tooltip.hide());
      segment.addEventListener("blur", () => tooltip.hide());
      return segment;
    }),
  );
  frame.prepend(bar);

  // Die Tabelle mit Farbfeldern ist zugleich die Legende
  const rows = shown.map((item, index) =>
    h(
      "tr",
      {},
      cell(h("span", { class: "viz-legend-cell" }, h("span", { class: `viz-swatch ${slotClass(item, index)}`, "aria-hidden": "true" }), item.language)),
      cell(numberFormat.format(item.files), { numeric: true }),
      cell(numberFormat.format(item.lines), { numeric: true }),
      cell(totalLines ? percentFormat.format(item.lines / totalLines) : "–", { numeric: true }),
    ),
  );
  const legend = table(["Sprache", { label: "Dateien", numeric: true }, { label: "Zeilen", numeric: true }, { label: "Anteil", numeric: true }], rows, "viz-data-table");
  legend.classList.add("view-fill");
  return [frame, legend];
}

// Waagerechte Balkenliste, Wert am Balkenende
function barList(items, { label, value, valueText, mono = false, fill = false, className = "" }) {
  const maximum = Math.max(1, ...items.map(value));
  return h(
    "ol",
    { class: ["viz-barlist", fill ? "view-fill" : "", className].filter(Boolean).join(" ") },
    items.map((item) =>
      h(
        "li",
        {},
        h("span", { class: `viz-barlist-label${mono ? " mono" : ""}`, title: label(item) }, label(item)),
        h(
          "span",
          { class: "viz-barlist-track" },
          h("span", { class: "viz-barlist-bar", style: `width: ${Math.max(2, (value(item) / maximum) * 100)}%` }),
          h("span", { class: "viz-barlist-value" }, valueText(item)),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

export function renderRepo(container, { signal } = {}) {
  const life = lifecycle(signal);
  let subLife = null;
  const body = h("div", { class: "repo-body", role: "tabpanel" });
  const tabs = [
    ["history", "Verlauf"],
    ["stats", "Statistik"],
    ["readme", "README"],
    ["ci", "GitHub"],
  ];
  const tabSlot = h("div", {});

  const show = (id) => {
    repoTab = id;
    subLife?.dispose();
    subLife = lifecycle();
    fill(tabSlot, subTabs(tabs, id, show, "Repo-Bereiche"));
    body.setAttribute("aria-labelledby", `view-tab-${id}`);
    const views = { history: historyView, stats: statsView, readme: readmeView, ci: ciView };
    (views[id] ?? historyView)(body, subLife);
  };

  fill(container, h("div", { class: "page repo-page" }, pageTitle("Repo"), tabSlot, body));
  show(tabs.some(([id]) => id === repoTab) ? repoTab : "history");
  life.onCleanup(() => subLife?.dispose());
  return () => life.dispose();
}

function parseCommitSubject(subject) {
  const match = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.*)$/.exec(subject ?? "");
  if (!match) return { type: null, scope: null, breaking: false, text: subject ?? "" };
  const type = match[1].toLowerCase();
  return { type: commitTypes[type] ? type : null, scope: match[2] || null, breaking: Boolean(match[3]), text: match[4] || subject };
}

function clockElement(iso) {
  const date = parseDate(iso);
  if (!date) return h("span", { class: "muted" }, "–");
  return h("time", { datetime: date.toISOString(), title: formatDate(iso) }, timeFormat.format(date));
}

// showAuthor: nur Autoren, die nicht der häufigste sind, stehen in der Zeile
function commitItem(commit, mainAuthor) {
  const showAuthor = mainAuthor != null && commit.author !== mainAuthor;
  const subject = parseCommitSubject(commit.subject);
  return h(
    "li",
    { class: "repo-commit" },
    h("span", { class: "repo-dot", "aria-hidden": "true" }),
    h(
      "div",
      { class: "repo-commit-main" },
      h(
        "p",
        { class: "repo-commit-subject" },
        subject.type ? h("span", { class: `chip repo-type repo-type-${subject.type}` }, commitTypes[subject.type]) : null,
        subject.scope ? h("span", { class: "repo-scope muted" }, subject.scope) : null,
        subject.breaking ? h("span", { class: "chip warn" }, "Bruch") : null,
        h("span", {}, subject.text),
      ),
      h(
        "p",
        { class: "repo-commit-meta muted" },
        showAuthor ? h("span", { class: "repo-author" }, commit.author) : null,
        h("span", { class: "mono repo-hash", title: commit.hash }, commit.short ?? String(commit.hash ?? "").slice(0, 7)),
        h("span", { class: "repo-clock" }, clockElement(commit.date)),
        h("span", { class: "repo-files" }, commit.files != null ? plural(commit.files, "Datei", "Dateien") : ""),
        h(
          "span",
          { class: "mono repo-diff", "aria-label": `${commit.insertions ?? 0} Zeilen hinzu, ${commit.deletions ?? 0} Zeilen entfernt` },
          h("span", { class: "repo-added" }, `+${numberFormat.format(commit.insertions ?? 0)}`),
          " ",
          h("span", { class: "repo-removed" }, `−${numberFormat.format(commit.deletions ?? 0)}`),
        ),
      ),
      commit.body?.trim() ? h("details", { class: "repo-commit-body" }, h("summary", {}, "Beschreibung"), h("p", {}, commit.body.trim())) : null,
    ),
  );
}

function historyView(body, life) {
  const state = { commits: [], total: 0, head: null, fetchedAt: null, loading: false, error: null };
  const meta = h("p", { class: "muted repo-meta" });
  const list = h("div", { class: "repo-timeline-wrap" });
  const footer = h("div", { class: "repo-more" });
  fill(body, panel({ title: "Commits", actions: meta, wide: true }, list, footer));

  const draw = () => {
    fill(
      meta,
      state.total ? `${plural(state.total, "Commit", "Commits")} · ` : null,
      "gepullt ",
      state.fetchedAt ? timeElement(state.fetchedAt) : h("span", {}, "unbekannt"),
    );
    if (!state.commits.length) {
      fill(list, state.loading ? loadingView() : state.error ? errorView(state.error, () => loadPage(true)) : emptyView("Noch keine Commits", null));
    } else {
      const authorCounts = new Map();
      for (const commit of state.commits) authorCounts.set(commit.author, (authorCounts.get(commit.author) ?? 0) + 1);
      const mainAuthor = authorCounts.size > 1 ? [...authorCounts].sort((a, b) => b[1] - a[1])[0][0] : null;
      fill(
        list,
        h(
          "ol",
          { class: "repo-timeline" },
          groupByDay(state.commits, (commit) => commit.date).map((group) =>
            h(
              "li",
              { class: "repo-day" },
              h("h3", { class: "repo-day-title" }, group.title),
              h("ol", { class: "repo-commits" }, group.items.map((commit) => commitItem(commit, mainAuthor))),
            ),
          ),
        ),
      );
    }
    const more = state.commits.length < state.total;
    fill(
      footer,
      state.commits.length && state.error ? errorView(state.error, () => loadPage(false)) : null,
      more
        ? h(
            "button",
            { class: "button", type: "button", disabled: state.loading, onclick: () => loadPage(false) },
            state.loading ? "Lädt …" : `Mehr laden (${numberFormat.format(state.total - state.commits.length)})`,
          )
        : null,
    );
  };

  const loadPage = async (fresh) => {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    if (fresh) list.classList.add("view-refreshing");
    draw();
    try {
      const skip = fresh ? 0 : state.commits.length;
      const data = await load(`/api/git/commits?skip=${skip}&limit=${commitPageSize}`, life);
      if (!life.alive) return;
      const commits = data?.commits ?? [];
      // Hat sich HEAD zwischendurch geändert, passt die Seite nicht mehr an die alte Liste
      if (!fresh && state.head && data?.head !== state.head) {
        state.loading = false;
        return loadPage(true);
      }
      state.commits = fresh ? commits : state.commits.concat(commits);
      state.total = data?.total ?? state.commits.length;
      state.head = data?.head ?? null;
      state.fetchedAt = data?.fetched_at ?? null;
    } catch (error) {
      if (!life.alive) return;
      state.error = error;
    } finally {
      state.loading = false;
      list.classList.remove("view-refreshing");
    }
    if (life.alive) draw();
  };

  loadPage(true);
}

function statsView(body, life) {
  const slot = h("div", {});
  fill(body, slot);

  const drawStats = (stats) => {
    const totalLines = (stats.languages ?? []).reduce((sum, item) => sum + item.lines, 0);
    const totalFiles = (stats.languages ?? []).reduce((sum, item) => sum + item.files, 0);
    const authors = [...(stats.authors ?? [])].sort((a, b) => b.commits - a.commits);
    const authorText = authors.map((author) => `${author.name} ${numberFormat.format(author.commits)}`).join(" · ");
    // Autoren als sechste Kachel statt eines fast leeren eigenen Panels: 6 Kacheln teilen sich sauber in 6, 3 oder 2 Spalten
    const tiles = tileRow([
      tile("Commits", numberFormat.format(stats.total_commits ?? 0)),
      tile("Zeilen", numberFormat.format(totalLines)),
      tile("Dateien", numberFormat.format(totalFiles)),
      tile("Erster Commit", parseDate(stats.first_commit_at) ? shortDateFormat.format(parseDate(stats.first_commit_at)) : "–"),
      tile("Letzter Commit", describeTime(stats.last_commit_at)),
      tile("Autoren", h("span", { title: authorText }, numberFormat.format(authors.length), authors.length ? h("small", { class: "muted view-tile-detail" }, authorText) : null)),
    ]);
    const weeks = stats.weeks ?? [];
    const types = [...(stats.types ?? [])].sort((a, b) => b.commits - a.commits);
    const hotFiles = stats.hot_files ?? [];
    return h(
      "div",
      { class: "grid" },
      h("div", { class: "view-wide" }, tiles),
      panel(
        { title: "Commits pro Woche", wide: true },
        weeks.some((week) => week.commits > 0) ? weekChart(weeks, life) : emptyView("Keine Commits im letzten Jahr", null),
      ),
      // Ähnlich hohe Panels nebeneinander, die Liste füllt die Höhe ihres Panels
      pair(
        panel({ title: "Zeilen nach Sprache" }, stats.languages?.length ? languageChart(stats.languages) : emptyView("Keine Dateien", null)),
        panel(
          { title: "Commit-Arten" },
          types.length
            ? barList(types, { label: (item) => commitTypes[item.type] ?? item.type, value: (item) => item.commits, valueText: (item) => numberFormat.format(item.commits), fill: true })
            : emptyView("Keine Commits", null),
        ),
      ),
      panel(
        { title: "Meistgeändert (90 Tage)", wide: true },
        hotFiles.length
          ? barList(hotFiles, { label: (item) => item.path, value: (item) => item.changes, valueText: (item) => numberFormat.format(item.changes), mono: true, className: "viz-barlist-paths" })
          : emptyView("Keine Änderungen", null),
      ),
    );
  };

  loadInto(slot, life, "/api/git/stats", drawStats);
}

function tile(label, value) {
  return h("div", { class: "view-tile" }, h("dt", {}, label), h("dd", {}, value));
}

// Kachelreihe ohne halb leere letzte Reihe: die Spaltenzahl teilt die Kachelzahl (über Container-Abfragen in views.css)
function tileRow(tiles) {
  return h("div", { class: "view-tiles-host" }, h("dl", { class: `view-tiles view-tiles-${tiles.length}` }, tiles));
}

function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function readmeView(body, life) {
  const slot = h("div", {});
  fill(body, slot);
  loadInto(slot, life, "/api/readme", (data) => {
    // renderMarkdown filtert über DOMPurify und liefert ein DocumentFragment
    const article = h("article", { class: "markdown repo-readme" }, renderMarkdown(data?.markdown ?? ""));

    // Überschriften bekommen Anker wie auf GitHub, mit Präfix gegen Kollisionen mit der Seite
    const used = new Map();
    const headings = [...article.querySelectorAll("h1, h2, h3, h4")];
    for (const heading of headings) {
      const base = slugify(heading.textContent ?? "");
      const count = used.get(base) ?? 0;
      used.set(base, count + 1);
      heading.id = `readme-${count ? `${base}-${count}` : base}`;
      heading.tabIndex = -1;
    }
    for (const link of article.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        // Sonst würde der Hash-Router der Seite den Bereich wechseln
        link.addEventListener("click", (event) => {
          event.preventDefault();
          let target = null;
          try {
            target = article.querySelector(`#readme-${CSS.escape(decodeURIComponent(href.slice(1)).toLowerCase())}`);
          } catch {
            target = null;
          }
          if (target) {
            target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
            target.focus({ preventScroll: true });
          }
        });
      } else if (/^https?:\/\//i.test(href)) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      } else {
        // Relative Links zeigen auf Dateien im Repo, die die Seite nicht ausliefert
        link.removeAttribute("href");
        link.classList.add("repo-readme-file");
        link.title = `Datei im Repo: ${href}`;
      }
    }

    // Das eigene Inhaltsverzeichnis der README doppelt sonst diese Liste
    const toc = headings.filter((heading) => heading.tagName === "H2" && heading.textContent?.trim().toLowerCase() !== "inhalt");
    const nav = toc.length
      ? h(
          "nav",
          { class: "panel repo-readme-toc", "aria-label": "Inhalt der README" },
          h(
            "ol",
            {},
            toc.map((heading) =>
              h(
                "li",
                {},
                h(
                  "a",
                  {
                    href: `#${heading.id}`,
                    onclick: (event) => {
                      event.preventDefault();
                      heading.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
                      heading.focus({ preventScroll: true });
                    },
                  },
                  heading.textContent,
                ),
              ),
            ),
          ),
        )
      : null;

    return h(
      "div",
      { class: "repo-readme-layout" },
      nav,
      h("div", { class: "panel repo-readme-panel" }, article),
    );
  });
}

function runState(run) {
  if (!run) return { kind: "muted", label: "Unbekannt" };
  if (run.status && run.status !== "completed") {
    return { kind: "warn", label: run.status === "queued" || run.status === "waiting" || run.status === "pending" || run.status === "requested" ? "Wartet" : "Läuft" };
  }
  const conclusions = {
    success: { kind: "ok", label: "Bestanden" },
    failure: { kind: "error", label: "Fehlgeschlagen" },
    timed_out: { kind: "error", label: "Zeit überschritten" },
    startup_failure: { kind: "error", label: "Start fehlgeschlagen" },
    cancelled: { kind: "muted", label: "Abgebrochen" },
    skipped: { kind: "muted", label: "Übersprungen" },
    neutral: { kind: "muted", label: "Neutral" },
    stale: { kind: "muted", label: "Veraltet" },
    action_required: { kind: "warn", label: "Aktion nötig" },
  };
  return conclusions[run.conclusion] ?? { kind: "muted", label: run.conclusion ?? "Unbekannt" };
}

function ciView(body, life) {
  const slot = h("div", {});
  let timer = null;
  life.onCleanup(() => clearTimeout(timer));
  let running = false;
  const schedule = () => {
    timer = setTimeout(() => {
      if (document.visibilityState === "visible") refresh();
      else schedule();
    }, ciRefreshMs);
  };
  const refresh = async () => {
    clearTimeout(timer);
    const data = await loadInto(slot, life, "/api/ci", drawCi);
    if (!life.alive) return;
    // Erneut versuchen im Fehlerfall soll auch das Nachsehen wieder starten
    const retry = slot.querySelector(":scope > .error-box button");
    if (retry) {
      retry.onclick = null;
      retry.replaceWith(h("button", { class: "button small", type: "button", onclick: refresh }, "Erneut versuchen"));
    }
    // Solange ein Lauf nicht fertig ist, jede Minute nachsehen, auch nach einem Fehler beim Abruf
    if (data) running = Boolean(data.runs?.[0] && data.runs[0].status !== "completed");
    if (running) schedule();
  };
  fill(body, slot);

  function drawCi(data) {
    if (!data?.configured) {
      return panel(
        { title: "GitHub Actions", wide: true },
        emptyView(
          "Nicht verbunden",
          h("span", {}, h("code", {}, "GITHUB_TOKEN"), " in Backend/dev/.env setzen (fine-grained, nur zamaric, Actions + Metadata lesen)."),
        ),
      );
    }
    const runs = data.runs ?? [];
    if (!runs.length) return panel({ title: "GitHub Actions", wide: true }, emptyView("Noch keine Läufe", null));
    const [latest, ...older] = runs;
    const state = runState(latest);
    const latestUrl = safeExternalUrl(latest.url, "https://github.com/");
    return h(
      "div",
      { class: "grid" },
      panel(
        { title: "Letzter Lauf", wide: true, className: `repo-ci-latest repo-ci-${state.kind}` },
        h(
          "div",
          { class: "repo-ci-hero" },
          statusChip(state.kind, state.label),
          h("p", { class: "repo-ci-title" }, latest.title ?? "Ohne Titel"),
          h(
            "p",
            { class: "muted repo-commit-meta" },
            latest.branch && latest.branch !== "main" ? h("span", {}, latest.branch) : null,
            h("span", { class: "mono" }, String(latest.commit ?? "").slice(0, 7) || "–"),
            timeElement(latest.started_at),
            h("span", {}, durationText(latest.started_at, latest.updated_at)),
            latestUrl ? h("a", { href: latestUrl, target: "_blank", rel: "noopener noreferrer" }, "GitHub ↗") : null,
          ),
        ),
        (data.latest_jobs ?? []).map((job) => {
          const jobState = runState(job);
          return h(
            "div",
            { class: "repo-ci-job" },
            // Status am Job nur, wenn er vom Lauf abweicht
            h("h3", {}, jobState.label !== state.label ? statusChip(jobState.kind, jobState.label) : null, h("span", {}, job.name)),
            h(
              "ol",
              { class: "repo-ci-steps" },
              (job.steps ?? []).map((step) => {
                const stepState = runState(step);
                return h(
                  "li",
                  { class: `repo-ci-step repo-ci-step-${stepState.kind}` },
                  h("span", { class: "view-chip-symbol", role: "img", "aria-label": stepState.label }, { ok: "✓", error: "✕", warn: "…", muted: "–" }[stepState.kind]),
                  h("span", {}, step.name),
                  stepState.kind === "ok" ? null : h("span", { class: "muted" }, stepState.label),
                );
              }),
            ),
          );
        }),
      ),
      older.length
        ? panel(
            { title: "Frühere Läufe", wide: true },
            table(
              ["Status", "Titel", "Commit", "Start", "Dauer"],
              older.map((run) => {
                const runStatus = runState(run);
                const url = safeExternalUrl(run.url, "https://github.com/");
                return h(
                  "tr",
                  {},
                  cell(statusChip(runStatus.kind, runStatus.label)),
                  cell(url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, run.title ?? "Ohne Titel") : (run.title ?? "Ohne Titel")),
                  cell(String(run.commit ?? "").slice(0, 7) || "–", { mono: true }),
                  cell(timeElement(run.started_at)),
                  cell(durationText(run.started_at, run.updated_at), { numeric: true }),
                );
              }),
            ),
          )
        : null,
    );
  }

  refresh();
}

// ---------------------------------------------------------------------------
// Datenbank
// ---------------------------------------------------------------------------

export function renderDatabase(container, { signal } = {}) {
  const life = lifecycle(signal);
  const slots = {
    integrity: h("div", {}),
    files: h("div", {}),
    checksums: h("div", { class: "db-checksums" }),
    storage: h("div", {}),
    releases: h("div", {}),
    cron: h("div", {}),
  };
  const checksumState = { progress: null, timer: null, starting: false, failures: 0, pollError: null };
  life.onCleanup(() => clearTimeout(checksumState.timer));

  const loadAll = () => {
    loadInto(slots.integrity, life, "/api/integrity", drawIntegrity);
    loadFiles();
    loadInto(slots.storage, life, "/api/storage", drawStorage);
    loadInto(slots.releases, life, "/api/releases", drawReleases);
    loadInto(slots.cron, life, "/api/cron", drawCron);
    pollChecksums();
  };

  const loadFiles = () => loadInto(slots.files, life, "/api/files", drawFiles);
  const leftColumn = h(
    "div",
    { class: "db-stack" },
    panel({ title: "Wartende Freigaben" }, slots.releases),
    panel({ title: "Speicher" }, slots.storage),
    panel({ title: "Unbenutzte Dateien" }, slots.files),
  );
  const cronPanel = panel({ title: "Cron-Läufe", className: "db-cron" }, slots.cron);

  fill(
    container,
    h(
      "div",
      { class: "page db-page" },
      pageTitle("Datenbank"),
      h(
        "div",
        { class: "grid" },
        // Prüfsummen als Aktion im Kopf der Integrität statt eines fast leeren eigenen Panels
        panel({ title: "Integrität", wide: true, actions: slots.checksums }, slots.integrity),
        // Links drei kleine Panels übereinander, rechts die Cron-Läufe. Die Zahl der sichtbaren
        // Läufe richtet sich nach der Höhe links, so enden beide Spalten bündig.
        h(
          "div",
          { class: "db-columns" },
          leftColumn,
          cronPanel,
        ),
      ),
    ),
  );

  let cronRuns = [];
  let cronVisible = cronVisibleRuns;
  const balance = new ResizeObserver(() => balanceCron());
  for (const slot of [slots.releases, slots.storage, slots.files]) balance.observe(slot);
  life.onCleanup(() => balance.disconnect());

  // Zeigt so viele Cron-Läufe, wie neben die linke Spalte passen (mindestens 3)
  function balanceCron(depth = 0) {
    if (!life.alive || !cronRuns.length) return;
    const sideBySide = getComputedStyle(leftColumn.parentElement).gridTemplateColumns.split(" ").length > 1;
    let wanted = cronVisibleRuns;
    if (sideBySide) {
      const rows = slots.cron.querySelectorAll(".db-cron-table tbody tr");
      const rowHeight = rows.length ? rows[0].getBoundingClientRect().height : 0;
      if (rowHeight > 0) {
        // Beide Spalten sind auf die Zeilenhöhe gestreckt, verglichen werden die natürlichen Höhen
        const leftPanels = [...leftColumn.children];
        const gap = parseFloat(getComputedStyle(leftColumn).rowGap) || 0;
        const leftNatural = leftPanels.reduce((sum, element) => sum + naturalPanelHeight(element), 0) + gap * Math.max(0, leftPanels.length - 1);
        const spare = leftNatural - naturalPanelHeight(cronPanel);
        // Gerundet: der Rest von höchstens einer halben Zeile landet in der längeren Spalte unten
        wanted = Math.max(3, Math.min(cronRuns.length, cronVisible + Math.round(spare / rowHeight)));
      }
    }
    // Höchstens ein paar Durchgänge, damit unterschiedlich hohe Zeilen nicht hin und her springen
    if (wanted !== cronVisible && depth < 4) {
      cronVisible = wanted;
      fill(slots.cron, drawCron({ runs: cronRuns }, true));
      // Nach dem Neuzeichnen kann der Toggle für ältere Läufe wegfallen oder dazukommen
      requestAnimationFrame(() => balanceCron(depth + 1));
    }
  }

  function drawIntegrity(data) {
    const findings = data?.findings ?? [];
    const groups = new Map();
    for (const finding of findings) {
      const group = groups.get(finding.check_name) ?? { name: finding.check_name, severity: finding.severity, rows: [] };
      if (finding.severity === "error") group.severity = "error";
      group.rows.push(finding);
      groups.set(finding.check_name, group);
    }
    const ordered = [...groups.values()].sort((a, b) => (a.severity === b.severity ? b.rows.length - a.rows.length : a.severity === "error" ? -1 : 1));
    const errors = findings.filter((finding) => finding.severity === "error").length;
    const warnings = findings.length - errors;
    const summary = h(
      "p",
      { class: "db-summary" },
      errors ? statusChip("error", plural(errors, "Fehler", "Fehler")) : statusChip("ok", "Keine Fehler"),
      warnings ? statusChip("warn", plural(warnings, "Warnung", "Warnungen")) : null,
    );
    if (!findings.length) return summary;
    const groupView = (group) => {
      const info = integrityChecks[group.name] ?? { title: group.name, text: "" };
      return h(
        "details",
        { class: `db-finding db-finding-${group.severity}`, open: group.severity === "error" },
        h(
          "summary",
          {},
          h(
            "span",
            { class: `chip ${group.severity === "error" ? "error" : "warn"}`, role: "img", "aria-label": group.severity === "error" ? "Fehler" : "Warnung" },
            group.severity === "error" ? "✕" : "!",
          ),
          h("span", { class: "db-finding-title" }, info.title),
          h("span", { class: "chip muted" }, numberFormat.format(group.rows.length)),
          info.text ? h("span", { class: "muted db-finding-text" }, info.text) : null,
        ),
        table(
          ["Song", "Tabelle", { label: "ID", numeric: true }, "Detail"],
          group.rows.map((row) =>
            h(
              "tr",
              {},
              cell(row.song_name ?? (row.song_id != null ? `Song ${row.song_id}` : "–")),
              cell(tableNames[row.table_name] ?? row.table_name ?? "–"),
              cell(row.row_id != null ? String(row.row_id) : "–", { numeric: true, mono: true }),
              cell(row.detail ?? "", { className: "db-detail" }),
            ),
          ),
          "db-finding-table",
        ),
      );
    };
    // Fehler offen über die volle Breite, Warnungen eingeklappt im zweispaltigen Raster
    const errorGroups = ordered.filter((group) => group.severity === "error");
    const warningGroups = ordered.filter((group) => group.severity !== "error");
    return [
      summary,
      errorGroups.length ? h("div", { class: "db-findings" }, errorGroups.map(groupView)) : null,
      warningGroups.length ? h("div", { class: "db-findings db-findings-warnings" }, warningGroups.map(groupView)) : null,
    ];
  }

  function drawFiles(data) {
    const unused = data?.unused ?? [];
    const cleanup = h(
      "button",
      {
        class: "button danger small",
        type: "button",
        title: unusedHint,
        disabled: unused.length === 0,
        onclick: async () => {
          const confirmed = await confirmDialog({
            title: "Unbenutzte Dateien löschen?",
            message: `${plural(unused.length, "Datei", "Dateien")} endgültig löschen.`,
            confirmLabel: "Löschen",
            danger: true,
          });
          if (!confirmed || !life.alive) return;
          cleanup.disabled = true;
          cleanup.textContent = "Löscht …";
          try {
            const result = await load("/api/files/cleanup", life, { method: "POST" });
            if (!life.alive) return;
            loadInto(slots.storage, life, "/api/storage", drawStorage);
            loadInto(slots.integrity, life, "/api/integrity", drawIntegrity);
            await loadFiles();
            slots.files.prepend(h("p", { class: "db-notice", role: "status" }, `${plural(result?.removed ?? 0, "Datei", "Dateien")} gelöscht.`));
          } catch (error) {
            if (!life.alive) return;
            cleanup.disabled = false;
            cleanup.textContent = "Löschen";
            // Bei wiederholtem Fehler den alten Kasten ersetzen statt zu stapeln
            slots.files.querySelector(":scope > .error-box")?.remove();
            slots.files.prepend(errorView(error));
          }
        },
      },
      "Löschen",
    );
    // Fehlende Dateien stehen schon in der Integrität ("Datei fehlt im Bucket")
    if (!unused.length) return h("p", { class: "muted", title: unusedHint }, "Keine");
    return h(
      "div",
      { class: "db-files" },
      h("div", { class: "db-subhead" }, h("span", { class: "muted", title: unusedHint }, plural(unused.length, "Datei", "Dateien")), cleanup),
      table(
        ["Bucket", "Datei"],
        unused.map((file) => h("tr", {}, cell(file.bucket), cell(file.name, { mono: true, className: "db-path" }))),
      ),
    );
  }

  function drawChecksums() {
    const progress = checksumState.progress;
    const running = Boolean(progress?.running) || checksumState.starting;
    let status = null;
    if (progress?.error) {
      status = errorView(progress.error);
    } else if (checksumState.pollError) {
      // Stand nicht mehr abrufbar: Fehler mit Ausweg statt eines ewig gesperrten Knopfs
      status = h(
        "p",
        { class: "muted", role: "status" },
        `${errorText(checksumState.pollError)} `,
        h("button", { class: "button small", type: "button", onclick: retryChecksums }, "Erneut versuchen"),
      );
    } else if (running) {
      const percent = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;
      status = [
        h(
          "div",
          { class: "progress", role: "progressbar", "aria-label": "Prüfsummen", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) },
          h("span", { style: `width: ${percent}%` }),
        ),
        h("p", { class: "muted", role: "status" }, progress?.total ? `${progress.done} / ${progress.total}` : "Sucht …"),
      ];
    } else if (progress?.finished) {
      const added = progress.done - progress.failed;
      status = h(
        "p",
        { class: "muted", role: "status" },
        progress.total === 0
          ? "Alle vorhanden."
          : `${added} nachgetragen${progress.failed ? `, ${progress.failed} fehlgeschlagen` : ""}.`,
      );
    }
    fill(
      slots.checksums,
      status,
      checksumState.pollError
        ? null
        : h(
            "button",
            { class: "button small", type: "button", disabled: running, onclick: startChecksums },
            running ? "Läuft …" : "Prüfsummen nachtragen",
          ),
    );
  }

  function retryChecksums() {
    checksumState.failures = 0;
    checksumState.pollError = null;
    drawChecksums();
    pollChecksums();
  }

  function applyChecksumProgress(progress) {
    const wasRunning = checksumState.progress?.running ?? false;
    checksumState.progress = { ...progress, finished: !progress.running && (wasRunning || checksumState.progress?.finished) };
    drawChecksums();
    // Nach dem Durchgang stimmen Integrität und Dateien nicht mehr
    if (wasRunning && !progress.running && !checksumState.starting) {
      loadInto(slots.integrity, life, "/api/integrity", drawIntegrity);
      loadFiles();
    }
    clearTimeout(checksumState.timer);
    if (progress.running) checksumState.timer = setTimeout(pollChecksums, checksumPollMs);
  }

  async function pollChecksums() {
    if (!life.alive) return;
    try {
      const progress = await load("/api/checksums", life);
      if (!life.alive) return;
      checksumState.failures = 0;
      checksumState.pollError = null;
      applyChecksumProgress(progress ?? { running: false, total: 0, done: 0, failed: 0 });
    } catch (error) {
      if (!life.alive) return;
      clearTimeout(checksumState.timer);
      if (isSessionExpired(error)) return;
      if (!checksumState.progress) {
        checksumState.progress = { running: false, error };
        drawChecksums();
        return;
      }
      if (!checksumState.progress.running) return;
      // Ein einzelner Netzfehler während eines Durchgangs: später erneut fragen
      checksumState.failures += 1;
      if (checksumState.failures >= checksumMaxFailures) {
        checksumState.pollError = error;
        drawChecksums();
        return;
      }
      checksumState.timer = setTimeout(pollChecksums, checksumRetryMs);
    }
  }

  async function startChecksums() {
    checksumState.starting = true;
    checksumState.progress = { running: true, total: 0, done: 0, failed: 0, finished: false };
    drawChecksums();
    try {
      const progress = await load("/api/checksums", life, { method: "POST" });
      if (!life.alive) return;
      checksumState.starting = false;
      applyChecksumProgress(progress ?? { running: false, total: 0, done: 0, failed: 0 });
    } catch (error) {
      if (!life.alive) return;
      checksumState.starting = false;
      checksumState.progress = { running: false, error };
      drawChecksums();
    }
  }

  function drawStorage(data) {
    const buckets = data?.buckets ?? [];
    const largest = data?.largest ?? [];
    const bucketNames = { audio: "Audio", sheet_music: "Noten" };
    return [
      buckets.length
        ? tileRow(
            buckets.map((bucket) => tile(bucketNames[bucket.bucket] ?? bucket.bucket, h("span", {}, formatBytes(bucket.total_bytes), h("small", { class: "muted" }, plural(bucket.file_count, "Datei", "Dateien"))))),
          )
        : emptyView("Keine Dateien", null),
      largest.length
        ? h(
            "details",
            { class: "db-largest" },
            h("summary", {}, `${largest.length} größte Dateien`),
            table(
              ["Datei", "Song", { label: "Größe", numeric: true }],
              largest.map((file) =>
                h(
                  "tr",
                  {},
                  cell(h("span", { title: `${file.bucket}/${file.name}` }, file.name), { mono: true, className: "db-path" }),
                  cell(file.song_name ? `${file.song_name}${file.table_name ? ` · ${tableNames[file.table_name] ?? file.table_name}` : ""}` : h("span", { class: "muted" }, "ohne Zeile")),
                  cell(formatBytes(file.bytes), { numeric: true }),
                ),
              ),
            ),
          )
        : null,
    ];
  }

  function drawReleases(data) {
    const pending = [...(data?.pending ?? [])].sort((a, b) => String(a.release_at).localeCompare(String(b.release_at)));
    if (!pending.length) return h("p", { class: "muted" }, "Nichts wartet.");
    // Neue Songs mit Chip am Namen, Kategorie und Umfang als zweite Zeile: so passt die Tabelle in eine halbe Zeile
    const contents = (row) =>
      [
        [row.playbacks, "Playback", "Playbacks"],
        [row.sheet_music, "Noten", "Noten"],
        [row.count_ins, "Einzähler", "Einzähler"],
      ]
        .filter(([count]) => count)
        .map(([count, one, many]) => plural(count, one, many))
        .join(" · ");
    return table(
      ["Song", "Freigabe"],
      pending.map((row) => {
        const overdue = parseDate(row.release_at) && parseDate(row.release_at) < new Date();
        const details = [row.category_name, contents(row)].filter(Boolean).join(" · ");
        return h(
          "tr",
          {},
          cell(
            h(
              "span",
              {},
              h("span", { class: "db-nowrap" }, row.song_name ?? `Song ${row.song_id}`, row.is_new_song ? h("span", { class: "chip db-new" }, "Neu") : null),
              details ? h("small", { class: "muted db-category" }, details) : null,
            ),
          ),
          cell(h("span", { class: "db-nowrap" }, timeElement(row.release_at), overdue ? h("span", { class: "db-overdue" }, statusChip("warn", "fällig")) : null)),
        );
      }),
    );
  }

  function drawCron(data, fromBalance = false) {
    const runs = data?.runs ?? [];
    cronRuns = runs;
    if (!fromBalance) requestAnimationFrame(() => balanceCron());
    if (!runs.length) return h("p", { class: "muted" }, "Noch keine Läufe.");
    const severalJobs = new Set(runs.map((run) => run.job_name)).size > 1;
    const cronState = (status) =>
      ({
        succeeded: ["ok", "OK"],
        failed: ["error", "Fehlgeschlagen"],
        running: ["warn", "Läuft"],
        starting: ["warn", "Startet"],
        sending: ["warn", "Läuft"],
        connecting: ["warn", "Verbindet"],
      })[status] ?? ["muted", status ?? "Unbekannt"];
    const latest = runs[0];
    const latestStart = parseDate(latest?.started_at);
    const stale = latestStart && Date.now() - latestStart.getTime() > 2 * 3600 * 1000;
    const failures = runs.filter((run) => run.status === "failed").length;
    return [
      h(
        "p",
        { class: "db-summary" },
        stale ? statusChip("warn", "Kein Lauf seit über 2 Std.") : statusChip("ok", "Aktiv"),
        failures ? statusChip("error", `${plural(failures, "Fehlschlag", "Fehlschläge")} / ${runs.length}`) : null,
      ),
      cronTable(runs.slice(0, cronVisible)),
      runs.length > cronVisible
        ? h("details", { class: "viz-table-toggle" }, h("summary", {}, `Ältere (${runs.length - cronVisible})`), cronTable(runs.slice(cronVisible)))
        : null,
    ];

    // Job nur bei mehreren Jobs, Meldung nur bei Fehlschlag als zweite Zeile unter dem Status
    function cronTable(rows) {
      return table(
        [...(severalJobs ? ["Job"] : []), "Status", "Start", { label: "Dauer", numeric: true }],
        rows.map((run) => {
          const [kind, label] = cronState(run.status);
          const message = run.status === "failed" && run.message ? h("small", { class: "db-detail db-cron-message mono" }, run.message) : null;
          return h(
            "tr",
            {},
            severalJobs ? cell(run.job_name ?? "–", { mono: true }) : null,
            cell([statusChip(kind, label), message]),
            cell(h("span", { class: "db-nowrap" }, timeElement(run.started_at))),
            cell(durationText(run.started_at, run.finished_at), { numeric: true }),
          );
        }),
        "db-cron-table",
      );
    }
  }

  drawChecksums();
  loadAll();
  return () => life.dispose();
}

// ---------------------------------------------------------------------------
// Nachrichten
// ---------------------------------------------------------------------------

export function renderMessages(container, { signal } = {}) {
  const life = lifecycle(signal);
  const slot = h("div", {});
  let notifications = [];
  let query = "";
  const list = h("div", { class: "msg-list" });
  const search = h("input", {
    class: "input msg-search",
    type: "search",
    placeholder: "Suchen",
    "aria-label": "Nachrichten durchsuchen",
    oninput: (event) => {
      query = event.target.value.trim().toLowerCase();
      drawList();
    },
  });
  const reload = () => loadInto(slot, life, "/api/notifications", (data) => {
    notifications = data?.notifications ?? [];
    drawList();
    return list;
  });

  fill(
    container,
    h(
      "div",
      { class: "page msg-page" },
      pageTitle("Nachrichten"),
      search,
      slot,
    ),
  );

  function drawList() {
    const visible = query
      ? notifications.filter((item) => `${item.title ?? ""} ${item.message ?? ""}`.toLowerCase().includes(query))
      : notifications;
    if (!notifications.length) {
      fill(list, emptyView("Noch keine Nachrichten", null));
      return;
    }
    if (!visible.length) {
      fill(list, emptyView("Nichts gefunden", null));
      return;
    }
    const sorted = [...visible].sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)));
    fill(
      list,
      groupByDay(sorted, (item) => item.sent_at).map((group) =>
        h(
          "section",
          { class: "msg-day" },
          h("h2", { class: "msg-day-title" }, group.title),
          h(
            "ol",
            { class: "panel msg-items" },
            group.items.map((item) => {
              const date = parseDate(item.sent_at);
              // Eine Zeile pro Nachricht: Uhrzeit, Titel, Text (Zeilen mit · verbunden), Zustellung
              return h(
                "li",
                { class: "msg-item" },
                h("time", { class: "muted mono msg-time", datetime: date?.toISOString() ?? "", title: formatDate(item.sent_at) }, date ? timeFormat.format(date) : "–"),
                h("h3", { class: "msg-title" }, item.title ?? "Ohne Titel"),
                h("p", { class: "msg-text" }, (item.message ?? "").split("\n").map((line) => line.trim()).filter(Boolean).join(" · ")),
                h("span", { class: "msg-delivery" }, deliveryChip(item.status_code)),
              );
            }),
          ),
        ),
      ),
    );
  }

  reload();
  return () => life.dispose();
}

function deliveryChip(statusCode) {
  if (statusCode == null) return null;
  if (statusCode >= 200 && statusCode < 300) return statusChip("ok", "Zugestellt");
  return statusChip("error", `Fehler ${statusCode}`);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// Aufeinanderfolgende Fehlmessungen als ein Ausfall, neueste zuerst
function outageRanges(failures, intervalSeconds) {
  const dates = failures
    .map((sample) => parseDate(sample.at))
    .filter(Boolean)
    .sort((a, b) => a - b);
  const gap = intervalSeconds * 1000 * 1.5;
  const ranges = [];
  for (const date of dates) {
    const last = ranges.at(-1);
    if (last && date - last.end <= gap) {
      last.end = date;
      last.count += 1;
    } else {
      ranges.push({ start: date, end: date, count: 1 });
    }
  }
  for (const range of ranges) range.minutes = Math.max(1, Math.round((range.count * intervalSeconds) / 60));
  return ranges.reverse();
}

function percentile(sortedValues, fraction) {
  if (!sortedValues.length) return null;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(fraction * sortedValues.length) - 1));
  return sortedValues[index];
}

function latencyChart(samples, intervalSeconds, life) {
  const frame = h("div", { class: "viz-frame" });
  const chartSlot = h("div", {});
  frame.append(chartSlot);
  const tooltip = tooltipLayer(frame);
  const points = samples
    .map((sample) => ({ ...sample, date: parseDate(sample.at) }))
    .filter((sample) => sample.date)
    .sort((a, b) => a.date - b.date);
  const end = points.length ? Math.max(Date.now(), points.at(-1).date.getTime()) : Date.now();
  const start = end - 24 * 3600 * 1000;
  const gapMs = intervalSeconds * 1000 * 2.5;

  const chart = responsiveChart(frame, life, (width) => {
    const height = 240;
    const margin = { top: 14, right: 12, bottom: 28, left: 48 };
    const plotWidth = Math.max(10, width - margin.left - margin.right);
    const plotHeight = height - margin.top - margin.bottom;
    const okValues = points.filter((point) => point.ok && point.ms != null).map((point) => point.ms);
    const ticks = niceTicks(Math.max(50, ...okValues), 4);
    const maximum = ticks.at(-1);
    const x = (time) => margin.left + ((time - start) / (end - start)) * plotWidth;
    const y = (ms) => margin.top + plotHeight - (Math.min(ms, maximum) / maximum) * plotHeight;

    const grid = ticks.map((tick) =>
      svg(
        "g",
        {},
        svg("line", { class: tick === 0 ? "viz-baseline" : "viz-grid", x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick) }),
        svg("text", { class: "viz-axis-label", x: margin.left - 6, y: y(tick), "text-anchor": "end", "dominant-baseline": "middle" }, `${numberFormat.format(tick)} ms`),
      ),
    );

    const hourLabels = [];
    const firstHour = new Date(start);
    firstHour.setMinutes(0, 0, 0);
    const labelStep = plotWidth < 480 ? 6 : 3;
    for (let time = firstHour.getTime() + 3600 * 1000; time <= end; time += 3600 * 1000) {
      const date = new Date(time);
      if (date.getHours() % labelStep !== 0) continue;
      hourLabels.push(svg("text", { class: "viz-axis-label", x: x(time), y: height - 8, "text-anchor": "middle" }, `${String(date.getHours()).padStart(2, "0")}:00`));
    }

    // Linie und Fläche brechen bei Ausfällen und Messlücken ab
    const segments = [];
    let current = [];
    let previous = null;
    for (const point of points) {
      const broken = !point.ok || point.ms == null || (previous && point.date - previous.date > gapMs);
      if (broken && current.length) {
        segments.push(current);
        current = [];
      }
      if (point.ok && point.ms != null) current.push(point);
      previous = point;
    }
    if (current.length) segments.push(current);
    const linePaths = segments.map((segment) =>
      segment.length === 1
        ? svg("circle", { class: "viz-line-dot", cx: x(segment[0].date.getTime()), cy: y(segment[0].ms), r: 2 })
        : svg("path", { class: "viz-line", d: segment.map((point, index) => `${index ? "L" : "M"}${x(point.date.getTime()).toFixed(1)},${y(point.ms).toFixed(1)}`).join(" ") }),
    );
    const areaPaths = segments
      .filter((segment) => segment.length > 1)
      .map((segment) => {
        const first = x(segment[0].date.getTime()).toFixed(1);
        const last = x(segment.at(-1).date.getTime()).toFixed(1);
        const line = segment.map((point) => `L${x(point.date.getTime()).toFixed(1)},${y(point.ms).toFixed(1)}`).join(" ");
        return svg("path", { class: "viz-area", d: `M${first},${margin.top + plotHeight} ${line} L${last},${margin.top + plotHeight} Z` });
      });

    // Zusammenhängende Ausfälle als ein roter Bereich, unten ein kräftiger Streifen
    const outages = [];
    for (const point of points) {
      if (point.ok) continue;
      const last = outages.at(-1);
      const time = point.date.getTime();
      if (last && time - last.end <= gapMs) last.end = time;
      else outages.push({ start: time, end: time });
    }
    const outageMarks = outages.map((outage) => {
      const left = x(outage.start - (intervalSeconds * 1000) / 2);
      const right = x(outage.end + (intervalSeconds * 1000) / 2);
      const widthPx = Math.max(3, right - left);
      return svg(
        "g",
        {},
        svg("rect", { class: "viz-outage", x: left, y: margin.top, width: widthPx, height: plotHeight }),
        svg("rect", { class: "viz-outage-strip", x: left, y: margin.top + plotHeight - 4, width: widthPx, height: 4 }),
      );
    });

    const crosshair = svg("line", { class: "viz-crosshair", x1: 0, x2: 0, y1: margin.top, y2: margin.top + plotHeight, visibility: "hidden" });
    const marker = svg("circle", { class: "viz-marker", r: 4, cx: 0, cy: 0, visibility: "hidden" });
    const overlay = svg("rect", {
      class: "viz-overlay",
      x: margin.left,
      y: margin.top,
      width: plotWidth,
      height: plotHeight,
      tabindex: "0",
      role: "img",
      "aria-label": `Antwortzeit von Supabase der letzten 24 Stunden, ${points.length} Messungen, ${outages.length} Ausfälle. Pfeiltasten wählen eine Messung.`,
    });
    fill(
      chartSlot,
      svg("svg", { class: "viz-svg", width, height, viewBox: `0 0 ${width} ${height}` }, grid, outageMarks, areaPaths, linePaths, hourLabels, crosshair, marker, overlay),
    );

    if (!points.length) return;
    const times = points.map((point) => point.date.getTime());
    const nearest = (offsetX) => {
      const time = start + ((offsetX - margin.left) / plotWidth) * (end - start);
      let low = 0;
      let high = times.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (times[middle] < time) low = middle + 1;
        else high = middle;
      }
      return low > 0 && Math.abs(times[low - 1] - time) < Math.abs(times[low] - time) ? low - 1 : low;
    };
    indexedPointer(
      overlay,
      points.length,
      (offsetX) => nearest(offsetX + margin.left),
      (index) => {
        const point = points[index];
        const px = x(point.date.getTime());
        crosshair.setAttribute("x1", String(px));
        crosshair.setAttribute("x2", String(px));
        crosshair.setAttribute("visibility", "visible");
        if (point.ok && point.ms != null) {
          marker.setAttribute("cx", String(px));
          marker.setAttribute("cy", String(y(point.ms)));
          marker.setAttribute("visibility", "visible");
        } else {
          marker.setAttribute("visibility", "hidden");
        }
        tooltip.show(px, point.ok && point.ms != null ? y(point.ms) : margin.top + plotHeight / 2, [
          point.ok && point.ms != null
            ? { value: `${numberFormat.format(Math.round(point.ms))} ms`, label: timeFormat.format(point.date), key: "viz-key-line" }
            : { value: "Ausfall", label: timeFormat.format(point.date), key: "viz-key-outage" },
        ]);
      },
      () => {
        crosshair.setAttribute("visibility", "hidden");
        marker.setAttribute("visibility", "hidden");
        tooltip.hide();
      },
    );
  });

  const legend = h(
    "ul",
    { class: "viz-legend" },
    h("li", {}, h("span", { class: "viz-key viz-key-line", "aria-hidden": "true" }), "Antwortzeit"),
    h("li", {}, h("span", { class: "viz-swatch viz-swatch-outage", "aria-hidden": "true" }), "Ausfall"),
  );
  return { element: [frame, legend], redraw: () => chart.force() };
}

export function renderServer(container, { signal } = {}) {
  const life = lifecycle(signal);
  const slot = h("div", {});
  let timer = null;
  let loading = false;

  const refresh = async () => {
    if (loading || !life.alive) return;
    loading = true;
    clearTimeout(timer);
    await loadInto(slot, life, "/api/latency", drawLatency);
    loading = false;
    schedule();
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!life.alive || document.visibilityState !== "visible") return;
    timer = setTimeout(refresh, latencyRefreshMs);
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") refresh();
    else clearTimeout(timer);
  };
  document.addEventListener("visibilitychange", onVisibility);
  life.onCleanup(() => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  });

  fill(
    container,
    h(
      "div",
      { class: "page srv-page" },
      pageTitle("Server"),
      slot,
    ),
  );

  let chartLife = null;
  life.onCleanup(() => chartLife?.dispose());

  function drawLatency(data) {
    chartLife?.dispose();
    chartLife = lifecycle();
    const samples = data?.samples ?? [];
    const interval = data?.interval_seconds ?? 60;
    if (!samples.length) {
      return emptyView("Noch keine Messungen", null);
    }
    const okValues = samples.filter((sample) => sample.ok && sample.ms != null).map((sample) => sample.ms).sort((a, b) => a - b);
    const failures = samples.filter((sample) => !sample.ok);
    const latest = [...samples].sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    const median = percentile(okValues, 0.5);
    const p95 = percentile(okValues, 0.95);
    const failureRate = failures.length / samples.length;
    const msText = (value) => (value == null ? "–" : `${numberFormat.format(Math.round(value))} ms`);

    const tiles = tileRow([
      tile("Aktuell", latest?.ok ? msText(latest.ms) : h("span", {}, statusChip("error", "Ausfall"))),
      tile("Median", msText(median)),
      tile("P95", msText(p95)),
      tile("Fehlmessungen", h("span", {}, numberFormat.format(failures.length), h("small", { class: "muted" }, percentFormat.format(failureRate)))),
    ]);
    const outages = outageRanges(failures, interval);
    const chart = latencyChart(samples, interval, chartLife);

    // Stundenweise Zusammenfassung als Tabellenansicht des Diagramms
    const hours = new Map();
    for (const sample of samples) {
      const date = parseDate(sample.at);
      if (!date) continue;
      const hour = new Date(date);
      hour.setMinutes(0, 0, 0);
      const key = hour.getTime();
      const entry = hours.get(key) ?? { hour, values: [], failures: 0 };
      if (sample.ok && sample.ms != null) entry.values.push(sample.ms);
      else entry.failures += 1;
      hours.set(key, entry);
    }
    const hourRows = [...hours.values()]
      .sort((a, b) => b.hour - a.hour)
      .map((entry) => {
        const sorted = entry.values.sort((a, b) => a - b);
        return h(
          "tr",
          {},
          cell(`${timeFormat.format(entry.hour)} Uhr`, { mono: true }),
          cell(msText(percentile(sorted, 0.5)), { numeric: true }),
          cell(msText(sorted.at(-1) ?? null), { numeric: true }),
          cell(entry.failures ? h("span", { class: "srv-failures" }, numberFormat.format(entry.failures)) : "0", { numeric: true }),
        );
      });

    return h(
      "div",
      { class: "grid" },
      h("div", { class: "view-wide" }, tiles),
      panel(
        { title: "Antwortzeit (24 h)", wide: true },
        chart.element,
        h(
          "details",
          { class: "viz-table-toggle" },
          h("summary", {}, "Pro Stunde"),
          table(["Stunde", { label: "Median", numeric: true }, { label: "Max", numeric: true }, { label: "Fehlmessungen", numeric: true }], hourRows),
        ),
      ),
      outages.length
        ? panel(
            { title: "Ausfälle", wide: true },
            h(
              "ol",
              { class: "srv-outages" },
              outages.slice(0, 50).map((range) =>
                h(
                  "li",
                  {},
                  h(
                    "time",
                    { datetime: range.start.toISOString(), title: formatDate(range.start.toISOString()) },
                    `${shortDayFormat.format(range.start)} ${timeFormat.format(range.start)}${range.count > 1 ? `–${timeFormat.format(range.end)}` : ""}`,
                  ),
                  h("span", { class: "muted" }, `${range.minutes} Min.`),
                ),
              ),
            ),
          )
        : null,
    );
  }

  refresh();
  return () => life.dispose();
}
