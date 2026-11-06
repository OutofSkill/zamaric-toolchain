// Beispieldaten für ?demo in der URL: keine Anfrage verlässt den Browser.
// demoResponse(path, init) bekommt dasselbe init wie fetch (method groß,
// body als JSON-String) und liefert die Daten, die die API liefern würde.
// Board-Änderungen leben nur im Speicher dieses Tabs.

const minute = 60 * 1000;
const hour = 60 * minute;
const day = 24 * hour;
const now = Date.now();

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hexString(next, length) {
  let text = "";
  while (text.length < length) text += Math.floor(next() * 16).toString(16);
  return text;
}

function iso(time) {
  return new Date(time).toISOString();
}

function demoError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function clone(value) {
  return structuredClone(value);
}

function wait() {
  return new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 260));
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

let nextBoardId = 100;
const board = {
  columns: [
    {
      id: 1,
      title: "Player",
      cards: [
        { id: 11, title: "Sprung zum Buchstaben ohne Pause", body: "Beim Wechsel des Buchstabens kurz pausieren **bleibt**, aber der Slider soll nicht zurückspringen.", color: "yellow", updated_at: iso(now - 2 * hour) },
        { id: 12, title: "Tempo-Regler", body: "- 50 % bis 120 %\n- in 5er-Schritten\n- Einzähler mit anpassen", color: "default", updated_at: iso(now - 3 * day) },
        { id: 13, title: "", body: "Lautstärke-Listener auf iOS nochmal prüfen, siehe `_startPlayer()`.", color: "red", updated_at: iso(now - 9 * day) },
      ],
    },
    {
      id: 2,
      title: "Noten-Screen",
      cards: [
        { id: 21, title: "Vorladen nach Instrument", body: "Noten der gewählten Stimme schon beim Öffnen der Bibliothek in den Zwischenspeicher legen.", color: "blue", updated_at: iso(now - 26 * hour) },
        { id: 22, title: "Querformat", body: "Banner verdeckt oben 16 px. Ist das okay?", color: "default", updated_at: iso(now - 5 * day) },
      ],
    },
    {
      id: 3,
      title: "Backend",
      cards: [
        { id: 31, title: "Andere Benachrichtigung statt ntfy", body: "Ideen sammeln. [ntfy-Doku](https://docs.ntfy.sh/)", color: "purple", updated_at: iso(now - 7 * day) },
        { id: 32, title: "Instrumentenliste aufräumen", body: "Doppelte Einträge mit unterschiedlicher Stimmung zusammenführen.", color: "green", updated_at: iso(now - 12 * day) },
      ],
    },
    { id: 4, title: "Design", cards: [{ id: 41, title: "Kontrast der Typ-Chips", body: "Mindestens 4,5 : 1 im Dunkelmodus.", color: "orange", updated_at: iso(now - 15 * day) }] },
    { id: 5, title: "Entscheidungen", cards: [] },
  ],
};

function findColumn(id) {
  const column = board.columns.find((item) => item.id === id);
  if (!column) throw demoError("not_found", 404);
  return column;
}

function findCard(id) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === id);
    if (index >= 0) return { column, index, card: column.cards[index] };
  }
  throw demoError("not_found", 404);
}

function checkText(value, minimum, maximum) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw demoError("invalid_request", 422);
  return value;
}

const cardColors = ["default", "red", "orange", "yellow", "green", "blue", "purple"];

function checkColor(value) {
  if (!cardColors.includes(value)) throw demoError("invalid_request", 422);
  return value;
}

function checkIndex(value) {
  if (!Number.isInteger(value) || value < 0) throw demoError("invalid_request", 422);
  return value;
}

function boardResponse(method, parts, body) {
  if (parts.length === 0 && method === "GET") return clone(board);
  if (parts[0] === "columns") {
    if (parts.length === 1 && method === "POST") {
      const column = { id: nextBoardId++, title: checkText(body.title, 1, 200).trim() || "Spalte", cards: [] };
      board.columns.push(column);
      return clone(column);
    }
    const column = findColumn(Number(parts[1]));
    if (parts.length === 2 && method === "PATCH") {
      column.title = checkText(body.title, 1, 200);
      return { id: column.id, title: column.title };
    }
    if (parts.length === 2 && method === "DELETE") {
      board.columns.splice(board.columns.indexOf(column), 1);
      return null;
    }
    if (parts[2] === "move" && method === "POST") {
      const index = Math.min(checkIndex(body.index), board.columns.length - 1);
      board.columns.splice(board.columns.indexOf(column), 1);
      board.columns.splice(index, 0, column);
      return null;
    }
  }
  if (parts[0] === "cards") {
    if (parts.length === 1 && method === "POST") {
      const column = findColumn(Number(body.column_id));
      const card = {
        id: nextBoardId++,
        title: checkText(body.title ?? "", 0, 200),
        body: checkText(body.body ?? "", 0, 20000),
        color: checkColor(body.color ?? "default"),
        updated_at: iso(Date.now()),
      };
      column.cards.push(card);
      return clone(card);
    }
    const found = findCard(Number(parts[1]));
    if (parts.length === 2 && method === "PATCH") {
      found.card.title = checkText(body.title ?? found.card.title, 0, 200);
      found.card.body = checkText(body.body ?? found.card.body, 0, 20000);
      found.card.color = checkColor(body.color ?? found.card.color);
      found.card.updated_at = iso(Date.now());
      return clone(found.card);
    }
    if (parts.length === 2 && method === "DELETE") {
      found.column.cards.splice(found.index, 1);
      return null;
    }
    if (parts[2] === "move" && method === "POST") {
      const target = findColumn(Number(body.column_id));
      found.column.cards.splice(found.index, 1);
      target.cards.splice(Math.min(checkIndex(body.index), target.cards.length), 0, found.card);
      return null;
    }
  }
  throw demoError(method === "GET" ? "not_found" : "method_not_allowed", method === "GET" ? 404 : 405);
}

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

const commitSubjects = [
  ["feat: basic sheet_music caching sheets that have already been opened", "Noten werden nach dem ersten Öffnen im Zwischenspeicher abgelegt, LRU bis 50 MB."],
  ["docs: updated README", ""],
  ["feat: connection banner to indicate when device is offline or has a slow connection", ""],
  ["feat: changed player loading", "Metadaten sofort aus der lokalen DB, Eingaben während des Ladens werden gemerkt."],
  ["fix: sheet music download waited on itself", "whenComplete mit Pfeil gab die eigene Future zurück."],
  ["feat(player): count-in cache for the current song", ""],
  ["refactor: standardized log format", "logfmt mit Konsolen-Layout, LogTiming für alles Messbare."],
  ["fix: letter jump inside clipped count-in source", ""],
  ["feat(library): segment Noten + Playback in pill switcher", ""],
  ["chore: removed skeletonizer", ""],
  ["test: player controller pending inputs", ""],
  ["fix(upload): reject manifest with duplicate letters", ""],
  ["feat(upload): update existing songs", ""],
  ["perf: batch signed audio urls", ""],
  ["style: dart format", ""],
  ["ci: run flutter test in analyze workflow", ""],
  ["feat: notes drawing with apple pencil", ""],
  ["fix: rotation delayed swap on iPad", ""],
  ["Merge branch 'main' of github.com:OutofSkill/zamaric", ""],
  ["build: android gradle 9.3.1", ""],
];

const commits = (() => {
  const next = random(7);
  const list = [];
  let time = now - 40 * minute;
  for (let index = 0; index < 184; index += 1) {
    const [subject, body] = index < commitSubjects.length ? commitSubjects[index] : commitSubjects[Math.floor(next() * commitSubjects.length)];
    const hash = hexString(next, 40);
    const files = 1 + Math.floor(next() * 9);
    list.push({
      hash,
      short: hash.slice(0, 7),
      author: next() < 0.93 ? "Phil Pereira Schultz" : "Claude",
      date: iso(time),
      subject,
      body,
      files,
      insertions: Math.floor(next() * 40 * files),
      deletions: Math.floor(next() * 22 * files),
    });
    time -= (next() < 0.25 ? 3 + next() * 4 : 0.2 + next() * 1.6) * day * (next() < 0.1 ? 3 : 1) * 0.55;
  }
  return list;
})();

function weekStart(time) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getTime();
}

function gitStats() {
  const weeks = [];
  const current = weekStart(now);
  for (let index = 51; index >= 0; index -= 1) {
    const start = new Date(current);
    start.setDate(start.getDate() - index * 7);
    weeks.push({ week_start: iso(start.getTime()), commits: 0 });
  }
  const types = new Map();
  for (const commit of commits) {
    const week = weeks.find((item) => {
      const start = new Date(item.week_start).getTime();
      const time = new Date(commit.date).getTime();
      return time >= start && time < start + 7 * day;
    });
    if (week) week.commits += 1;
    const match = /^(\w+)(?:\([^)]*\))?!?:/.exec(commit.subject);
    const type = match ? match[1] : "other";
    types.set(type, (types.get(type) ?? 0) + 1);
  }
  return {
    head: commits[0].hash,
    total_commits: commits.length,
    first_commit_at: commits.at(-1).date,
    last_commit_at: commits[0].date,
    authors: [
      { name: "Phil Pereira Schultz", commits: commits.filter((commit) => commit.author === "Phil Pereira Schultz").length },
      { name: "Claude", commits: commits.filter((commit) => commit.author === "Claude").length },
    ],
    weeks,
    types: [...types].map(([type, count]) => ({ type, commits: count })),
    languages: [
      { language: "Dart", files: 96, lines: 41820 },
      { language: "JavaScript", files: 9, lines: 7480 },
      { language: "Python", files: 22, lines: 5210 },
      { language: "CSS", files: 3, lines: 3950 },
      { language: "SQL", files: 16, lines: 2870 },
      { language: "Markdown", files: 6, lines: 2410 },
      { language: "Swift", files: 7, lines: 1260 },
      { language: "Kotlin", files: 5, lines: 840 },
      { language: "Konfiguration", files: 31, lines: 1180 },
      { language: "Bilder", files: 42, lines: 0 },
      { language: "Schriften", files: 2, lines: 0 },
      { language: "Andere", files: 11, lines: 310 },
    ],
    hot_files: [
      { path: "zamaric/lib/controller/player_controller.dart", changes: 38 },
      { path: "README.md", changes: 31 },
      { path: "zamaric/lib/screens/player_expanded.dart", changes: 17 },
      { path: "Backend/upload/website/static/app.js", changes: 15 },
      { path: "zamaric/lib/controller/sheet_music_controller.dart", changes: 12 },
      { path: "zamaric/lib/services/sync_service.dart", changes: 9 },
      { path: "zamaric/lib/utils/logger.dart", changes: 8 },
      { path: "Backend/upload/api/upload.py", changes: 7 },
      { path: "zamaric/lib/screens/library_screen.dart", changes: 6 },
      { path: "Backend/supabase/migrations/20261101130000_song_update.sql", changes: 5 },
    ],
  };
}

const readme = `# Zamaric

Musikapp für Bläserensembles: Noten (PDF) und Playbacks (MP3) mit Buchstaben-Navigation und Einzählern.

## Inhalt

1. [TODO](#todo)
2. [App](#app)
3. [Supabase](#supabase)

## TODO

- [ ] Noten nach Instrument vorladen
- [x] Zwischenspeicher für Noten
- [ ] „Log teilen“-Knopf

## App

Starten mit \`tool/run_logged.sh\`, die Ausgabe landet in \`zamaric/logs/\`.

| Bereich | Datei |
|---|---|
| Player | \`lib/controller/player_controller.dart\` |
| Noten | \`lib/controller/sheet_music_controller.dart\` |

\`\`\`sh
cd zamaric
flutter analyze
\`\`\`

## Supabase

> Projekt in Frankfurt. Migrationen liegen in [Backend/supabase/migrations](Backend/supabase/migrations).

Mehr unter [supabase.com](https://supabase.com/docs).
`;

function ciResponse() {
  const next = random(11);
  const titles = commits.slice(0, 8).map((commit) => commit.subject);
  const runs = titles.map((title, index) => {
    const started = now - (index * 7 + 1) * hour - next() * hour;
    const failed = index === 2;
    return {
      id: 9100 - index,
      status: "completed",
      conclusion: failed ? "failure" : index === 5 ? "cancelled" : "success",
      branch: "main",
      commit: commits[index].hash,
      title,
      event: "push",
      started_at: iso(started),
      updated_at: iso(started + (2 + next() * 3) * minute),
      url: `https://github.com/OutofSkill/zamaric/actions/runs/${9100 - index}`,
    };
  });
  const steps = ["Set up job", "Run actions/checkout@v5", "Run subosito/flutter-action@v2", "Run flutter pub get", "Run dart format --output=none --set-exit-if-changed lib test", "Run flutter analyze", "Run flutter test", "Complete job"];
  return {
    configured: true,
    runs,
    latest_jobs: [{ name: "analyze", status: "completed", conclusion: "success", steps: steps.map((name) => ({ name, status: "completed", conclusion: "success" })) }],
  };
}

// ---------------------------------------------------------------------------
// Datenbank
// ---------------------------------------------------------------------------

const songs = ["Alba", "Tequila", "Sonnenaufgang", "Marsch der Freunde", "Bolero Brass", "Abendrot", "Polka Nr. 3"];

function integrity() {
  return {
    checked_at: iso(Date.now()),
    findings: [
      { check_name: "file_missing", severity: "error", table_name: "playback", row_id: 412, song_id: 31, song_name: "Abendrot", detail: "audio/5b1c0e2a-8f8e-4d1f-9b2e-0c6a7d3e1f90.mp3" },
      { check_name: "letter_out_of_range", severity: "error", table_name: "letter", row_id: 3318, song_id: 12, song_name: "Tequila", detail: "Buchstabe F bei 3:41,200, Playback endet bei 3:38,000" },
      { check_name: "missing_sha256", severity: "warning", table_name: "sheet_music", row_id: 801, song_id: 4, song_name: "Alba", detail: "Trompete 1 in B, Normal" },
      { check_name: "missing_sha256", severity: "warning", table_name: "sheet_music", row_id: 802, song_id: 4, song_name: "Alba", detail: "Trompete 2 in B, Normal" },
      { check_name: "missing_sha256", severity: "warning", table_name: "count_in", row_id: 77, song_id: 4, song_name: "Alba", detail: "Einzähler C" },
      { check_name: "count_in_unused", severity: "warning", table_name: "count_in", row_id: 91, song_id: 18, song_name: "Bolero Brass", detail: "Einzähler H" },
      { check_name: "song_without_sheet_music", severity: "warning", table_name: "song", row_id: 27, song_id: 27, song_name: "Polka Nr. 3", detail: "Kategorie Konzert" },
      { check_name: "category_empty", severity: "warning", table_name: "category", row_id: 6, song_id: null, song_name: null, detail: "Weihnachten" },
    ],
  };
}

const unusedFiles = [
  { bucket: "audio", name: "0f3c2b9e-1d7a-4c55-8e2f-6a1b9d0c4e77.mp3" },
  { bucket: "audio", name: "7a6e1c02-93b4-4f0e-a8d1-2c5b7e9f1a33.mp3" },
  { bucket: "sheet_music", name: "c41d8e5f-2a7b-4e19-b6c3-9d0e1f2a3b44.pdf" },
];

function filesResponse() {
  return {
    unused: clone(unusedFiles),
    missing: [{ table_name: "playback", row_id: 412, song_id: 31, song_name: "Abendrot", bucket: "audio", path: "5b1c0e2a-8f8e-4d1f-9b2e-0c6a7d3e1f90.mp3" }],
  };
}

const checksums = { running: false, total: 0, done: 0, failed: 0 };

function advanceChecksums() {
  if (!checksums.running) return;
  checksums.done = Math.min(checksums.total, checksums.done + 2 + Math.floor(Math.random() * 3));
  if (checksums.done >= 9 && checksums.failed === 0) checksums.failed = 1;
  if (checksums.done >= checksums.total) checksums.running = false;
}

function storageResponse() {
  const next = random(23);
  return {
    buckets: [
      { bucket: "audio", file_count: 412, total_bytes: 1_930_000_000 },
      { bucket: "sheet_music", file_count: 1630, total_bytes: 214_000_000 },
    ],
    largest: Array.from({ length: 20 }, (_, index) => ({
      bucket: index < 17 ? "audio" : "sheet_music",
      name: `${hexString(next, 8)}-${hexString(next, 4)}-4${hexString(next, 3)}-a${hexString(next, 3)}-${hexString(next, 12)}.${index < 17 ? "mp3" : "pdf"}`,
      bytes: Math.round(14_800_000 - index * 520_000 - next() * 200_000),
      created_at: iso(now - next() * 40 * day),
      table_name: index === 9 ? null : index < 17 ? "playback" : "sheet_music",
      song_name: index === 9 ? null : songs[index % songs.length],
    })),
  };
}

function releasesResponse() {
  return {
    pending: [
      { song_id: 44, song_name: "Sonnenaufgang", category_name: "Konzert", release_at: iso(now + 5 * hour), is_new_song: true, count_ins: 6, playbacks: 3, sheet_music: 18 },
      { song_id: 12, song_name: "Tequila", category_name: "Party", release_at: iso(now + 26 * hour), is_new_song: false, count_ins: 0, playbacks: 1, sheet_music: 2 },
      { song_id: 39, song_name: "Marsch der Freunde", category_name: "Marsch", release_at: iso(now + 3 * day), is_new_song: true, count_ins: 4, playbacks: 2, sheet_music: 14 },
    ],
  };
}

function cronResponse() {
  const lastHour = new Date(now);
  lastHour.setMinutes(0, 0, 0);
  return {
    runs: Array.from({ length: 50 }, (_, index) => {
      const started = lastHour.getTime() - index * hour + 120;
      const failed = index === 17;
      return {
        job_name: "apply_song_changes",
        status: failed ? "failed" : "succeeded",
        started_at: iso(started),
        finished_at: iso(started + 40 + (index % 5) * 30),
        message: failed ? "ERROR: canceling statement due to statement timeout" : "1 row",
      };
    }),
  };
}

function notificationsResponse() {
  const next = random(31);
  return {
    notifications: Array.from({ length: 24 }, (_, index) => {
      const sent = now - index * 14 * hour - next() * 6 * hour - 20 * minute;
      const song = songs[index % songs.length];
      const isNew = index % 3 !== 1;
      const release = new Date(sent + 2 * day);
      const releaseText = `${String(release.getDate()).padStart(2, "0")}.${String(release.getMonth() + 1).padStart(2, "0")}.${release.getFullYear()} 18:00`;
      return {
        id: 500 - index,
        title: isNew ? "Neuer Song wartet auf Freigabe" : "Song geändert",
        message: isNew
          ? `${song} (Konzert)\nHochgeladen: ${new Date(sent).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" })}\nFreigabe: ${releaseText}`
          : `${song}: 1 neues Playback, 2 geänderte Noten\nFreigabe: ${releaseText}`,
        sent_at: iso(sent),
        status_code: now - sent < 6 * hour ? (index === 0 ? 200 : 200) : index === 4 ? 429 : null,
      };
    }),
  };
}

function latencyResponse() {
  const next = random(Math.floor(now / minute));
  const samples = [];
  const end = Math.floor(now / minute) * minute;
  for (let index = 1439; index >= 0; index -= 1) {
    const time = end - index * minute;
    const hourOfDay = new Date(time).getHours();
    const outage = index >= 410 && index < 416;
    const single = index === 1100 || index === 87;
    const ok = !(outage || single);
    const busy = hourOfDay >= 18 && hourOfDay <= 22 ? 30 : 0;
    const spike = next() < 0.02 ? 300 + next() * 900 : 0;
    samples.push({ at: iso(time), ms: ok ? Math.round(78 + busy + next() * 45 + spike) : null, ok });
  }
  return { interval_seconds: 60, samples };
}

// ---------------------------------------------------------------------------
// Übersicht: setzt sich aus den Antworten der einzelnen Bereiche zusammen
// ---------------------------------------------------------------------------

function overviewResponse() {
  const samples = latencyResponse().samples;
  const okValues = samples.filter((sample) => sample.ok).map((sample) => sample.ms).sort((a, b) => a - b);
  const ci = ciResponse();
  const findings = integrity().findings;
  const cronRuns = cronResponse().runs;
  const weeks = gitStats().weeks.slice(-12);
  const pending = [...releasesResponse().pending].sort((a, b) => a.release_at.localeCompare(b.release_at));
  const storage = storageResponse().buckets;
  const dayAgo = now - day;
  return {
    generated_at: iso(Date.now()),
    latency: {
      data: {
        last: samples.at(-1) ?? null,
        median_ms: okValues.length ? okValues[Math.ceil(okValues.length / 2) - 1] : null,
        failures: samples.filter((sample) => !sample.ok).length,
        samples: samples.length,
        down_since: null,
      },
    },
    ci: { data: { configured: ci.configured, workflow: "analyze.yml", latest: ci.runs[0] ?? null } },
    integrity: {
      data: {
        errors: findings.filter((finding) => finding.severity === "error").length,
        warnings: findings.filter((finding) => finding.severity === "warning").length,
      },
    },
    cron: {
      data: {
        latest: cronRuns[0] ?? null,
        failed_24h: cronRuns.filter((run) => run.status === "failed" && new Date(run.started_at).getTime() >= dayAgo).length,
      },
    },
    content: { data: { songs: 142, pending_songs: 2, playbacks: 410, sheet_music: 1630, count_ins: 388, categories: 7 } },
    repo: {
      data: {
        head: commits[0].hash,
        fetched_at: iso(now - 3 * minute),
        latest: clone(commits[0]),
        this_week: weeks.at(-1)?.commits ?? 0,
        last_week: weeks.at(-2)?.commits ?? 0,
        weeks,
      },
    },
    releases: { data: { next: pending[0] ?? null, more: Math.max(0, pending.length - 1) } },
    storage: { data: { buckets: storage, total_bytes: storage.reduce((sum, bucket) => sum + bucket.total_bytes, 0) } },
    notifications: { data: { latest: notificationsResponse().notifications.slice(0, 3) } },
  };
}

// ---------------------------------------------------------------------------
// Einstieg
// ---------------------------------------------------------------------------

export async function demoResponse(path, init = {}) {
  await wait();
  const url = new URL(path, "http://demo.invalid");
  const method = (init.method ?? "GET").toUpperCase();
  let body = {};
  if (typeof init.body === "string" && init.body) {
    try {
      body = JSON.parse(init.body);
    } catch {
      throw demoError("invalid_request", 422);
    }
  } else if (init.body && typeof init.body === "object") {
    body = init.body;
  }
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const route = `${method} /${parts.join("/")}`;

  if (parts[0] === "board") return boardResponse(method, parts.slice(1), body);

  switch (route) {
    case "POST /login":
    case "POST /logout":
    case "GET /session":
      return null;
    case "GET /git/commits": {
      const skip = Math.max(0, Number(url.searchParams.get("skip") ?? 0) || 0);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      return { head: commits[0].hash, fetched_at: iso(now - 3 * minute), total: commits.length, commits: clone(commits.slice(skip, skip + limit)) };
    }
    case "GET /git/stats":
      return gitStats();
    case "GET /readme":
      return { head: commits[0].hash, markdown: readme };
    case "GET /ci":
      return ciResponse();
    case "GET /integrity":
      return integrity();
    case "GET /files":
      return filesResponse();
    case "POST /files/cleanup": {
      const removed = unusedFiles.length;
      unusedFiles.splice(0);
      return { removed };
    }
    case "GET /checksums":
      advanceChecksums();
      return { ...checksums };
    case "POST /checksums":
      if (!checksums.running) Object.assign(checksums, { running: true, total: 24, done: 0, failed: 0 });
      return { ...checksums };
    case "GET /storage":
      return storageResponse();
    case "GET /releases":
      return releasesResponse();
    case "GET /cron":
      return cronResponse();
    case "GET /notifications":
      return notificationsResponse();
    case "GET /latency":
      return latencyResponse();
    case "GET /overview":
      return overviewResponse();
    default:
      throw demoError("not_found", 404);
  }
}
