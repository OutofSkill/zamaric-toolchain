import { checkSong, formatPosition, groupableWarnings, instrumentLabel, isIgnoredName, warningOrder } from "./check.js";
import { demoReference } from "./demo.js";

const demo = new URLSearchParams(location.search).has("demo");
const root = document.getElementById("app");

const steps = [
  { id: "folder", title: "Ordner" },
  { id: "category", title: "Kategorie" },
  { id: "sheetMusic", title: "Noten" },
  { id: "playbacks", title: "Playbacks" },
  { id: "overview", title: "Überblick" },
];

const uploadErrors = {
  unauthorized: "Anmeldung abgelaufen. Bitte neu anmelden.",
  forbidden: "Dieser Account darf nicht hochladen.",
  song_exists: "Song gibt es in dieser Kategorie schon.",
  too_large: "Dateien zusammen zu groß.",
  invalid_manifest: "Upload fehlerhaft. Ordner neu einlesen und erneut versuchen.",
  missing_file: "Datei fehlte. Ordner neu einlesen und erneut versuchen.",
  unexpected_file: "Datei zu viel. Ordner neu einlesen und erneut versuchen.",
  invalid_file_content: "Eine Datei ist beschädigt.",
  storage_failed: "Speichern fehlgeschlagen. Später erneut versuchen.",
  database_failed: "Eintragen fehlgeschlagen. Später erneut versuchen.",
};

const groupMinimum = 4;

const groupTitles = {
  unexpected_entry: "Datei oder Ordner an falscher Stelle",
  unexpected_folder: "Unerlaubter Unterordner",
  wrong_file_type: "Falscher Dateityp",
  invalid_file_content: "Datei lässt sich nicht lesen",
  file_too_large: "Datei größer als 50 MB",
  whitespace_issue: "Überflüssige Leerzeichen",
  invisible_character: "Unsichtbares Zeichen im Namen",
  invisible_character_text: "Unsichtbares Zeichen in der TXT",
  invalid_name_pattern: "Dateiname unvollständig oder doppelt",
  prefix_mismatch: "Dateiname beginnt nicht mit dem Songnamen",
  missing_separator: "„ - “ nach dem Songnamen fehlt",
  unknown_level: "Level unbekannt",
  missing_default_level: "Level „Normal“ fehlt in der Datenbank",
  unknown_part: "Stimme unbekannt",
  part_without_viewers: "Noten sieht in der App niemand",
  ambiguous_part: "Stimmung fehlt im Dateinamen",
  duplicate_sheet_music: "Noten doppelt",
  orphan_timestamps: "TXT ohne MP3",
  invalid_encoding: "TXT nicht als UTF-8 gespeichert",
  empty_timestamps: "TXT ist leer",
  invalid_timestamp_line: "Zeile in der TXT fehlerhaft",
  invalid_frames: "Zeit in der TXT fehlerhaft",
  invalid_letter: "Ungültiger Buchstabe",
  duplicate_letter: "Buchstabe doppelt",
  duplicate_position: "Zwei Buchstaben an derselben Stelle",
  letters_not_ascending: "Buchstaben nicht in zeitlicher Reihenfolge",
  letter_after_end: "Buchstabe nach MP3-Ende",
  unknown_count_in: "Einzähler fehlt",
  unused_count_in: "Einzähler wird nicht benutzt",
  unknown_type_instrument: "Tippfehler im Zusatz",
  letter_time_differs_between_variants: "Buchstabe zeitlich verschoben",
  letters_differ_between_variants: "Buchstaben anders als im Vergleichs-Playback",
  first_letter_not_at_start: "Erster Buchstabe nicht bei 0:00",
};

const loginErrors = {
  invalid_credentials: "Passwort falsch.",
  forbidden: "Dieser Account darf nicht hochladen.",
  too_many_attempts: "Zu viele Versuche. In ein paar Minuten erneut versuchen.",
};

const state = {
  step: 0,
  reference: null,
  categoryId: null,
  songName: null,
  files: [],
  directories: null,
  renames: {},
  result: null,
  confirmed: new Set(),
  cardIndex: new Map(),
  cardMotion: null,
  release: { mode: "earliest", date: "", month: "" },
  excluded: new Set(),
  withCountIn: true,
  openPickers: new Set(),
  listFilter: new Map(),
  settings: new Map(),
  checking: false,
  folderError: null,
  checkError: null,
  upload: null,
  showAllSongs: false,
  songSearch: "",
  songCategoryFilter: null,
};

const inspectionCache = new Map();
const sessionCheckIntervalMs = 60 * 1000;
let sharedAudioContext = null;
let signedIn = false;
let loginDialog = null;
let referenceRefreshRunning = false;

class SessionExpired extends Error {}

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "style") element.style.cssText = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (typeof value !== "string" && key in element) element[key] = value;
    else element.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function ownValue(object, key) {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function basename(path) {
  return path.split("/").pop();
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.round(milliseconds / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function warningKey(message) {
  return `${message.code}|${message.path}|${message.text}`;
}

const textFileCodes = new Set([
  "orphan_timestamps",
  "empty_timestamps",
  "invalid_encoding",
  "invalid_timestamp_line",
  "invisible_character_text",
  "invalid_frames",
  "invalid_letter",
  "duplicate_letter",
  "duplicate_position",
  "letters_not_ascending",
  "letter_after_end",
  "unknown_count_in",
]);

const fileCodes = new Set(["wrong_file_type", "invalid_file_content", "file_too_large", "invalid_name_pattern"]);

function isExcluded(path) {
  for (const excluded of state.excluded) {
    if (path === excluded || path.startsWith(`${excluded}/`)) return true;
  }
  return false;
}

function activeFiles() {
  return state.files.filter((entry) => !isExcluded(entry.path));
}

function checkDirectories() {
  if (!state.directories) return state.directories;
  return new Set(
    [...state.directories].filter(
      (folder) => !state.files.some((entry) => entry.path.startsWith(`${folder}/`) && !isIgnoredName(basename(entry.path))),
    ),
  );
}

function isFolder(path) {
  return state.files.some((entry) => entry.path.startsWith(`${path}/`));
}

function exclusionsFor(message) {
  if (!message.path || message.severity !== "error") return [];
  if (message.related) {
    return [
      { label: "Diese behalten", paths: [message.related] },
      { label: "Andere behalten", paths: [message.path] },
    ];
  }
  if (
    message.code === "unexpected_entry" ||
    message.code === "unexpected_folder" ||
    fileCodes.has(message.code) ||
    textFileCodes.has(message.code) ||
    message.code === "unused_count_in"
  ) {
    return [{ label: "Auslassen", paths: [message.path] }];
  }
  return [];
}

function excludePaths(paths) {
  for (const path of paths) state.excluded.add(path);
  runCheck();
}

function includePath(path) {
  state.excluded.delete(path);
  runCheck();
}

function exclusionButtons(message, small) {
  return exclusionsFor(message).map((exclusion) =>
    h("button", { class: `button${small ? " small" : ""}`, type: "button", onclick: () => excludePaths(exclusion.paths) }, exclusion.label),
  );
}

const replaceableCodes = new Set([...textFileCodes, "invalid_file_content", "file_too_large"]);

function pickFiles({ directory, accept }, onPicked) {
  const input = h("input", {
    type: "file",
    class: "visually-hidden",
    webkitdirectory: directory,
    multiple: directory,
    accept,
    onchange: (event) => {
      onPicked(event.target.files);
      input.remove();
    },
  });
  document.body.append(input);
  input.click();
}

function reloadFolder() {
  pickFiles({ directory: true }, (fileList) => {
    const selection = filesFromInput(fileList);
    if (!selection) return;
    if (selection.error) {
      window.alert(selection.error);
      return;
    }
    if (
      selection.songName !== state.songName &&
      !window.confirm(`Ordner heißt „${selection.songName}“ statt „${state.songName}“. Trotzdem übernehmen?`)
    ) {
      return;
    }
    stopPlayer();
    state.files = selection.files;
    state.directories = selection.directories;
    runCheck();
  });
}

function replaceFile(path) {
  const extension = path.slice(path.lastIndexOf("."));
  pickFiles({ directory: false, accept: extension }, (fileList) => {
    const file = fileList[0];
    if (!file) return;
    stopPlayer();
    state.files = state.files.map((entry) => (entry.path === path ? { path, size: file.size, file } : entry));
    runCheck();
  });
}

function replaceButton(message, small) {
  if (message.severity !== "error" || !message.path || !replaceableCodes.has(message.code)) return null;
  return h("button", { class: `button${small ? " small" : ""}`, type: "button", onclick: () => replaceFile(message.path) }, "Datei ersetzen");
}

function reloadFolderButton() {
  return h("button", { class: "button small", type: "button", onclick: reloadFolder }, "Ordner neu einlesen");
}

function pageTitle(title, subtitle, reload = true) {
  return h(
    "div",
    { class: "page-title" },
    h("div", {}, h("h1", {}, title), subtitle ? h("p", { class: "muted" }, subtitle) : null),
    reload && state.result ? reloadFolderButton() : null,
  );
}

function rowGroup(rowPath, status, cells, columnCount) {
  const messages = inlineMessages(rowPath);
  return h(
    "tbody",
    { class: `row-group ${status}` },
    cells,
    messages ? h("tr", { class: "row-messages" }, h("td", { colspan: String(columnCount) }, messages)) : null,
  );
}

function effectivePath(original) {
  return Object.hasOwn(state.renames, original) ? state.renames[original] : original;
}

function messageArea(message) {
  if (!message.path) return "overview";
  if (message.path === "Noten" || message.path.startsWith("Noten/")) return "sheetMusic";
  if (message.path === "Playbacks" || message.path.startsWith("Playbacks/")) return "playbacks";
  return "overview";
}

function messagesFor(area) {
  return (state.result?.messages ?? []).filter((message) => messageArea(message) === area);
}

function warningRank(message) {
  const index = warningOrder.indexOf(message.code);
  return index < 0 ? warningOrder.length : index;
}

function orderedMessages(messages) {
  const errors = messages.filter((message) => message.severity === "error");
  const warnings = messages
    .filter((message) => message.severity === "warning")
    .map((message, index) => ({ message, index }))
    .sort((left, right) => warningRank(left.message) - warningRank(right.message) || left.index - right.index)
    .map((entry) => entry.message);
  return [...errors, ...warnings];
}

function buildCards(messages) {
  const ordered = orderedMessages(messages);
  const counts = new Map();
  for (const message of ordered) {
    const key = `${message.severity}|${message.code}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const cards = [];
  const groups = new Map();
  for (const message of ordered) {
    const key = `${message.severity}|${message.code}`;
    const groupable = message.severity === "error" || groupableWarnings.has(message.code);
    if (groupable && counts.get(key) >= groupMinimum) {
      if (!groups.has(key)) {
        const group = { severity: message.severity, code: message.code, messages: [] };
        groups.set(key, group);
        cards.push(group);
      }
      groups.get(key).messages.push(message);
    } else {
      cards.push({ severity: message.severity, code: message.code, messages: [message] });
    }
  }
  return cards;
}

function cardDone(card) {
  return card.severity === "warning" && card.messages.every((message) => state.confirmed.has(warningKey(message)));
}

function messagesForPath(path) {
  return (state.result?.messages ?? []).filter((message) => message.path === path);
}

function areaStatus(area) {
  const messages = messagesFor(area);
  return {
    errors: messages.filter((message) => message.severity === "error").length,
    openWarnings: messages.filter(
      (message) => message.severity === "warning" && !state.confirmed.has(warningKey(message)),
    ).length,
  };
}

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  if (response.status === 401 && path !== "/api/login") {
    renderLogin("Anmeldung abgelaufen. Bitte neu anmelden.");
    throw new SessionExpired();
  }
  return response;
}

async function checkSession() {
  if (demo || !signedIn) return;
  await request("/api/session").catch(() => null);
}

function referenceRefreshAllowed() {
  const status = state.upload?.status;
  return !demo && signedIn && !state.checking && status !== "running" && status !== "done";
}

async function refreshReference() {
  if (!referenceRefreshAllowed() || referenceRefreshRunning) return;
  referenceRefreshRunning = true;
  const reference = await loadReference().catch(() => null);
  referenceRefreshRunning = false;
  if (!reference || !referenceRefreshAllowed()) return;
  if (JSON.stringify(reference) === JSON.stringify(state.reference)) return;
  state.reference = reference;
  if (state.result) {
    await runCheck();
  } else {
    render();
  }
}

async function readError(response) {
  try {
    const body = await response.json();
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

async function loadReference() {
  if (demo) return structuredClone(demoReference);
  const response = await request("/api/reference");
  if (!response.ok) throw new Error("reference");
  return response.json();
}

function audioContext() {
  if (!sharedAudioContext) {
    const Context = window.AudioContext ?? window.webkitAudioContext;
    sharedAudioContext = new Context();
  }
  return sharedAudioContext;
}

function cached(entry, kind, compute) {
  const key = `${kind}:${entry.original}:${entry.size}:${entry.file.lastModified}`;
  if (!inspectionCache.has(key)) inspectionCache.set(key, compute());
  return inspectionCache.get(key);
}

const inspect = {
  pdf: (entry) =>
    cached(entry, "pdf", async () => {
      const head = new Uint8Array(await entry.file.slice(0, 1024).arrayBuffer());
      return new TextDecoder("windows-1252").decode(head).includes("%PDF");
    }),
  audio: (entry) =>
    cached(entry, "audio", async () => {
      const buffer = await entry.file.arrayBuffer();
      const head = new Uint8Array(buffer.slice(0, 3));
      const id3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
      const frameSync = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
      if (!id3 && !frameSync) return null;
      try {
        const decoded = await audioContext().decodeAudioData(buffer);
        return Math.round(decoded.duration * 1000);
      } catch {
        return null;
      }
    }),
  text: (entry) =>
    cached(entry, "text", async () => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(await entry.file.arrayBuffer());
      } catch {
        return null;
      }
    }),
};

function filesFromInput(fileList) {
  const files = [...fileList];
  if (files.length === 0) return null;
  const roots = new Set(files.map((file) => file.webkitRelativePath.split("/")[0]));
  if (roots.size !== 1) return { error: "Genau einen Song-Ordner wählen." };
  return {
    songName: [...roots][0].normalize("NFC"),
    directories: null,
    files: files.map((file) => ({
      path: file.webkitRelativePath.split("/").slice(1).join("/").normalize("NFC"),
      size: file.size,
      file,
    })),
  };
}

function readEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function filesFromDirectoryEntry(directoryEntry) {
  const files = [];
  const directories = new Set();
  const walk = async (entry, prefix) => {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await readEntries(reader);
      for (const child of batch) {
        const path = prefix ? `${prefix}/${child.name}` : child.name;
        if (child.isDirectory) {
          directories.add(path.normalize("NFC"));
          await walk(child, path);
        } else {
          const file = await entryFile(child);
          files.push({ path: path.normalize("NFC"), size: file.size, file });
        }
      }
    } while (batch.length > 0);
  };
  await walk(directoryEntry, "");
  return { songName: directoryEntry.name.normalize("NFC"), directories, files };
}

const draftKey = "zamaric-upload-draft";
const draftMaximumAge = 7 * 24 * 60 * 60 * 1000;

function saveDraft() {
  if (!state.songName || !state.result || state.upload?.status === "done") return;
  const draft = {
    songName: state.songName,
    categoryId: state.categoryId,
    step: state.step,
    renames: state.renames,
    excluded: [...state.excluded],
    confirmed: [...state.confirmed],
    settings: [...state.settings].map(([path, settings]) => [path, { mode: settings.mode, ids: [...settings.ids], source: settings.source }]),
    release: state.release,
    savedAt: Date.now(),
  };
  try {
    localStorage.setItem(draftKey, JSON.stringify(draft));
  } catch {}
}

function readDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey));
    if (!draft || Date.now() - draft.savedAt > draftMaximumAge) return null;
    return draft;
  } catch {
    return null;
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(draftKey);
  } catch {}
}

function resumeDraft(draft) {
  pickFiles({ directory: true }, (fileList) => {
    const selection = filesFromInput(fileList);
    if (!selection) return;
    if (selection.error || selection.songName !== draft.songName) {
      state.folderError = selection.error ?? `Falscher Ordner: „${draft.songName}“ erwartet, „${selection.songName}“ gewählt.`;
      render();
      return;
    }
    selectFolder(selection, false);
    state.categoryId = draft.categoryId;
    state.renames = draft.renames ?? {};
    state.excluded = new Set(draft.excluded ?? []);
    state.confirmed = new Set(draft.confirmed ?? []);
    state.settings = new Map(
      (draft.settings ?? []).map(([path, settings]) => [path, { mode: settings.mode, ids: new Set(settings.ids), source: settings.source }]),
    );
    state.release = draft.release ?? state.release;
    runCheck().then(() => {
      if (state.result) goTo(stepAvailable(draft.step) ? draft.step : 2);
    });
  });
}

function draftCard() {
  const draft = readDraft();
  if (!draft || state.songName) return null;
  const category = state.reference?.categories.find((entry) => entry.id === draft.categoryId);
  const savedAt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(draft.savedAt));
  return h(
    "section",
    { class: "card draft" },
    h("h2", {}, "Angefangener Upload"),
    h("p", {}, h("strong", {}, draft.songName), category ? ` · ${category.name}` : "", h("span", { class: "muted" }, ` · ${savedAt} Uhr`)),
    h("p", { class: "muted small" }, "Zum Fortsetzen den Ordner erneut wählen."),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "button primary", type: "button", onclick: () => resumeDraft(draft) }, "Fortsetzen"),
      h(
        "button",
        {
          class: "button",
          type: "button",
          onclick: () => {
            clearDraft();
            render();
          },
        },
        "Verwerfen",
      ),
    ),
  );
}

function goTo(step) {
  if (step !== 3 && player.path) stopPlayer();
  state.step = step;
  render();
  window.scrollTo({ top: 0 });
  refreshReference();
}

function stepAvailable(index) {
  if (index <= 0) return true;
  if (index === 1) return state.songName != null;
  return state.result != null;
}

function selectFolder(selection, advance = true) {
  if (!selection) return;
  if (selection.error) {
    state.folderError = selection.error;
    render();
    return;
  }
  state.folderError = null;
  state.songName = selection.songName;
  state.files = selection.files;
  state.directories = selection.directories;
  state.renames = {};
  state.result = null;
  state.confirmed = new Set();
  state.cardIndex = new Map();
  state.release = { mode: "earliest", date: "", month: "" };
  state.excluded = new Set();
  state.openPickers = new Set();
  state.listFilter = new Map();
  state.settings = new Map();
  state.upload = null;
  inspectionCache.clear();
  stopPlayer();
  if (advance) goTo(1);
}

async function runCheck() {
  if (!state.songName || state.categoryId == null) return;
  state.checking = true;
  state.checkError = null;
  state.upload = null;
  render();
  let referenceLoaded = false;
  try {
    state.reference = await loadReference();
    referenceLoaded = true;
    state.result = await checkSong({
      songName: state.songName,
      categoryId: state.categoryId,
      files: activeFiles(),
      directories: checkDirectories(),
      renames: state.renames,
      reference: state.reference,
      inspect,
    });
    for (const playback of state.result.playbacks) {
      if (state.settings.get(playback.path)?.source === "user") continue;
      const suggested = playback.suggested_instrument_ids ?? [];
      state.settings.set(
        playback.path,
        suggested.length > 0
          ? { mode: "only", ids: new Set(suggested), source: "type" }
          : { mode: "all", ids: new Set(), source: "default" },
      );
    }
  } catch (error) {
    if (error instanceof SessionExpired) return;
    state.result = null;
    state.checkError = referenceLoaded ? "Prüfung unerwartet abgebrochen." : "Kategorien und Instrumente nicht geladen.";
  } finally {
    state.checking = false;
  }
  render();
}

function acceptSuggestions(messages) {
  for (const message of messages) {
    if (message.suggestion) state.renames[message.path] = message.suggestion;
  }
  runCheck();
}

function undoRename(original) {
  delete state.renames[original];
  runCheck();
}

function playbackSettingsValid(playback) {
  const settings = state.settings.get(playback.path);
  return settings && (settings.mode === "all" || settings.ids.size > 0);
}

function blockingReasons() {
  const result = state.result;
  if (!result) return [{ text: "Noch nicht geprüft", step: 1 }];
  const reasons = [];
  for (const [area, step, title] of [
    ["sheetMusic", 2, "Noten"],
    ["playbacks", 3, "Playbacks"],
    ["overview", 4, "Allgemein"],
  ]) {
    const status = areaStatus(area);
    if (status.errors > 0) reasons.push({ text: `${title}: ${plural(status.errors, "Fehler", "Fehler")}`, step });
    if (status.openWarnings > 0) reasons.push({ text: `${title}: ${plural(status.openWarnings, "Warnung", "Warnungen")} offen`, step });
  }
  const invalidPlaybacks = result.playbacks.filter((playback) => !playbackSettingsValid(playback)).length;
  if (invalidPlaybacks > 0) {
    reasons.push({ text: `Instrument wählen bei ${plural(invalidPlaybacks, "Playback", "Playbacks")}`, step: 3 });
  }
  if (!releaseDateValid()) {
    reasons.push({ text: "Freigabe: Tag wählen", step: 4 });
  }
  if (result.playbacks.length === 0 && result.sheet_music.length === 0) {
    reasons.push({ text: "Nichts zum Hochladen", step: 0 });
  }
  return reasons;
}

const berlinZone = "Europe/Berlin";
const releaseHour = 4;

function berlinParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: berlinZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function dayString(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10);
}

function berlinTime(day, hour) {
  const [year, month, date] = day.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, date, hour);
  const parts = berlinParts(new Date(guess));
  const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return new Date(guess - (shown - guess));
}

function earliestReleaseDay(uploadedAt = new Date()) {
  return releaseDayAtOrAfter(new Date(uploadedAt.getTime() + 24 * 60 * 60 * 1000));
}

function releaseDayAtOrAfter(earliest) {
  const parts = berlinParts(earliest);
  const sameDay = dayString(parts.year, parts.month, parts.day);
  if (berlinTime(sameDay, releaseHour) >= earliest) return sameDay;
  return dayString(parts.year, parts.month, parts.day + 1);
}

function expectedReleaseDay(song) {
  const afterWaiting = earliestReleaseDay(new Date(song.created_at));
  if (!song.release_at) return afterWaiting;
  const planned = releaseDayAtOrAfter(new Date(song.release_at));
  return planned > afterWaiting ? planned : afterWaiting;
}

function formatReleaseDay(day) {
  const text = new Intl.DateTimeFormat("de-DE", {
    timeZone: berlinZone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(berlinTime(day, releaseHour));
  return `${text} um ${releaseHour} Uhr`;
}

function releaseDay() {
  return state.release.mode === "date" ? state.release.date : earliestReleaseDay();
}

function releaseDateValid() {
  return state.release.mode === "earliest" || (state.release.date !== "" && state.release.date >= earliestReleaseDay());
}

function buildManifest() {
  const result = state.result;
  return {
    category_id: state.categoryId,
    song_name: result.song_name,
    release_at: state.release.mode === "date" ? berlinTime(state.release.date, releaseHour).toISOString() : null,
    count_ins: result.count_ins.map(({ path, name, duration_ms }) => ({ path, name, duration_ms })),
    playbacks: result.playbacks.map((playback) => {
      const settings = state.settings.get(playback.path);
      return {
        path: playback.path,
        type: playback.type,
        duration_ms: playback.duration_ms,
        instrument_mode: settings.mode,
        instrument_ids: settings.mode === "all" ? [] : [...settings.ids].sort((left, right) => left - right),
        letters: playback.letters,
      };
    }),
    sheet_music: result.sheet_music.map(({ path, part_id, level_id }) => ({ path, part_id, level_id })),
  };
}

function manifestPaths(manifest) {
  return [
    ...manifest.count_ins.map((entry) => entry.path),
    ...manifest.playbacks.map((entry) => entry.path),
    ...manifest.sheet_music.map((entry) => entry.path),
  ];
}

function startUpload() {
  const manifest = buildManifest();
  const paths = manifestPaths(manifest);
  if (demo) {
    state.upload = { status: "demo", manifest, paths };
    render();
    return;
  }
  const filesByPath = new Map(state.files.map((entry) => [entry.path, entry.file]));
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  form.append("paths", JSON.stringify(paths));
  for (const path of paths) form.append("files", filesByPath.get(path), basename(path));

  state.upload = { status: "running", progress: 0 };
  render();

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  xhr.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) return;
    state.upload.progress = event.loaded / event.total;
    updateProgress();
  });
  xhr.addEventListener("load", () => {
    if (xhr.status === 201) {
      state.upload = { status: "done", releaseDay: releaseDay() };
      clearDraft();
    } else if (xhr.status === 401) {
      state.upload = { status: "failed", text: "Nicht hochgeladen, weil die Anmeldung abgelaufen war. Bitte erneut hochladen." };
      render();
      renderLogin("Anmeldung abgelaufen. Bitte neu anmelden.");
      return;
    } else {
      let code = null;
      try {
        code = JSON.parse(xhr.responseText).error;
      } catch {
        code = null;
      }
      state.upload = {
        status: "failed",
        text: ownValue(uploadErrors, code) ?? `Upload fehlgeschlagen (${xhr.status}).`,
      };
    }
    render();
  });
  xhr.addEventListener("error", () => {
    state.upload = { status: "failed", text: "Keine Verbindung zum Server." };
    render();
  });
  xhr.send(form);
}

function updateProgress() {
  const bar = document.querySelector(".progress-bar");
  const label = document.querySelector(".progress-label");
  if (!bar || !label) return;
  const percent = Math.round(state.upload.progress * 100);
  bar.style.width = `${percent}%`;
  bar.parentElement.setAttribute("aria-valuenow", String(percent));
  label.textContent = `${percent} %`;
}

function resetSong() {
  state.songName = null;
  state.files = [];
  state.directories = null;
  state.renames = {};
  state.result = null;
  state.confirmed = new Set();
  state.cardIndex = new Map();
  state.release = { mode: "earliest", date: "", month: "" };
  state.excluded = new Set();
  state.openPickers = new Set();
  state.listFilter = new Map();
  state.settings = new Map();
  state.upload = null;
  state.folderError = null;
  state.checkError = null;
  inspectionCache.clear();
  goTo(0);
}

async function logout() {
  try {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  } finally {
    renderLogin();
  }
}

function header(withSteps = false) {
  const category = state.reference?.categories.find((entry) => entry.id === state.categoryId);
  return h(
    "header",
    { class: "topbar" },
    h(
      "div",
      { class: "topbar-inner" },
      h(
        "div",
        { class: "brand" },
        h("span", { class: "brand-name" }, "Zamaric Upload", demo ? h("span", { class: "tag" }, "Testmodus") : null),
        withSteps && state.songName && state.step > 0
          ? h("span", { class: "brand-context" }, state.songName, category && state.step > 1 ? ` · ${category.name}` : "")
          : null,
      ),
      withSteps ? stepper() : null,
      h("div", { class: "topbar-end" }, demo ? null : h("button", { class: "link", type: "button", onclick: logout }, "Abmelden")),
    ),
  );
}

function renderLogin(notice = null) {
  signedIn = false;
  if (loginDialog?.open) {
    loginDialog.querySelector(".form-error").textContent = notice ?? "";
    return;
  }
  if (!state.reference) render();
  const passwordInput = h("input", {
    id: "password",
    type: "password",
    autocomplete: "current-password",
    autofocus: true,
    required: true,
  });
  const errorBox = h("p", { class: "form-error", role: "alert" }, notice ?? "");
  const submit = h("button", { class: "button primary", type: "submit" }, "Anmelden");
  const form = h(
    "form",
    {
      class: "card login",
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        errorBox.textContent = "";
        try {
          const response = await request("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: passwordInput.value }),
          });
          if (response.ok) {
            dialog.close();
            dialog.remove();
            loginDialog = null;
            await start();
            return;
          }
          const code = await readError(response);
          errorBox.textContent = ownValue(loginErrors, code) ?? "Anmeldung fehlgeschlagen.";
        } catch {
          errorBox.textContent = "Keine Verbindung zum Server.";
        }
        submit.disabled = false;
        passwordInput.select();
      },
    },
    h("p", { class: "brand-name muted" }, "Zamaric Upload"),
    h("h1", { id: "login-title" }, "Anmelden"),
    h("label", { for: "password" }, "Passwort"),
    passwordInput,
    errorBox,
    submit,
  );
  const dialog = h(
    "dialog",
    { class: "login-dialog", "aria-labelledby": "login-title", oncancel: (event) => event.preventDefault() },
    form,
  );
  loginDialog = dialog;
  document.body.append(dialog);
  dialog.showModal();
  passwordInput.focus();
}

function stepper() {
  return h(
    "nav",
    { class: "stepper", "aria-label": "Schritte" },
    h(
      "ol",
      {},
      steps.map((step, index) => {
        let note = null;
        if (state.result && (step.id === "sheetMusic" || step.id === "playbacks" || step.id === "overview")) {
          const status = areaStatus(step.id);
          if (status.errors > 0) note = h("span", { class: "step-note error" }, plural(status.errors, "Fehler", "Fehler"));
          else if (status.openWarnings > 0) note = h("span", { class: "step-note warning" }, plural(status.openWarnings, "Warnung", "Warnungen"));
        }
        const position = index < state.step ? "done" : index === state.step ? "current" : "upcoming";
        return h(
          "li",
          { class: position },
          h(
            "button",
            {
              type: "button",
              class: "step",
              disabled: !stepAvailable(index) || state.checking,
              "aria-current": index === state.step ? "step" : null,
              onclick: () => goTo(index),
            },
            h("span", { class: "step-dot", "aria-hidden": "true" }, position === "done" ? "✓" : String(index + 1)),
            h("span", { class: "step-title" }, step.title),
            note,
          ),
        );
      }),
    ),
  );
}

function statusNote(areas, extra = [], doneText = "Alles erledigt") {
  let errors = 0;
  let warnings = 0;
  for (const area of areas) {
    const status = areaStatus(area);
    errors += status.errors;
    warnings += status.openWarnings;
  }
  const parts = [
    errors > 0 ? plural(errors, "Fehler", "Fehler") : null,
    warnings > 0 ? `${plural(warnings, "Warnung", "Warnungen")} offen` : null,
    ...extra,
  ].filter(Boolean);
  if (parts.length === 0) return h("p", { class: "page-nav-note ok" }, doneText);
  return h("p", { class: `page-nav-note ${errors > 0 ? "error" : "warning"}` }, parts.join(" · "));
}

function invalidPlaybackNote() {
  const invalid = state.result?.playbacks.filter((playback) => !playbackSettingsValid(playback)).length ?? 0;
  return invalid > 0 ? `Instrument wählen bei ${plural(invalid, "Playback", "Playbacks")}` : null;
}

function stepNote() {
  if (state.step === 0) return state.songName ? null : h("p", { class: "page-nav-note" }, "Ordner wählen");
  if (state.step === 1) return state.categoryId == null ? h("p", { class: "page-nav-note" }, "Kategorie wählen") : null;
  if (!state.result) return null;
  if (state.step === 2) return statusNote(["sheetMusic"]);
  if (state.step === 3) return statusNote(["playbacks"], [invalidPlaybackNote()]);
  return statusNote(
    ["overview", "sheetMusic", "playbacks"],
    [invalidPlaybackNote(), releaseDateValid() ? null : "Freigabe-Tag wählen"],
    "Bereit zum Hochladen",
  );
}

function pageNavigation({ back = true, next = null }) {
  return h(
    "div",
    { class: "page-nav" },
    back && state.step > 0
      ? h("button", { class: "button", type: "button", onclick: () => goTo(state.step - 1) }, "Zurück")
      : h("span"),
    stepNote() ?? h("span"),
    next ?? h("span"),
  );
}

function filterBar(rows) {
  const counts = {
    all: rows.length,
    error: rows.filter((row) => row.status === "error").length,
    warning: rows.filter((row) => row.status === "warning").length,
  };
  const current = state.listFilter.get(state.step) ?? "all";
  if (counts.error === 0 && counts.warning === 0 && current === "all") return null;
  return h(
    "div",
    { class: "filter", role: "group", "aria-label": "Dateien filtern" },
    [
      ["all", "Alle"],
      ["error", "Fehler"],
      ["warning", "Warnungen"],
    ].map(([value, label]) =>
      h(
        "button",
        {
          type: "button",
          class: `filter-option ${value}`,
          "aria-pressed": String(current === value),
          disabled: counts[value] === 0 && current !== value,
          onclick: () => {
            state.listFilter.set(state.step, value);
            render();
          },
        },
        label,
        h("span", { class: "filter-count" }, String(counts[value])),
      ),
    ),
  );
}

function filterRows(rows) {
  const current = state.listFilter.get(state.step) ?? "all";
  return current === "all" ? rows : rows.filter((row) => row.status === current);
}

function filterEmpty(rows) {
  if (rows.length > 0 || (state.listFilter.get(state.step) ?? "all") === "all") return null;
  return h(
    "p",
    { class: "filter-empty muted" },
    "Keine Dateien in diesem Filter. ",
    h(
      "button",
      {
        class: "link",
        type: "button",
        onclick: () => {
          state.listFilter.set(state.step, "all");
          render();
        },
      },
      "Alle zeigen",
    ),
  );
}

function nextButton(label = "Weiter") {
  return h(
    "button",
    {
      class: "button primary",
      type: "button",
      disabled: !stepAvailable(state.step + 1) || state.checking,
      onclick: () => goTo(state.step + 1),
    },
    label,
  );
}

function suggestionButton(message) {
  if (!message.suggestion) return null;
  return h(
    "button",
    { class: "button small suggestion", type: "button", title: basename(message.suggestion), onclick: () => acceptSuggestions([message]) },
    message.suggestion_label ? `→ ${message.suggestion_label}` : "Übernehmen",
  );
}

function confirmButton(message) {
  if (message.severity !== "warning") return null;
  const key = warningKey(message);
  const done = state.confirmed.has(key);
  return h(
    "button",
    {
      class: done ? "button small quiet" : "button small",
      type: "button",
      onclick: () => {
        if (done) state.confirmed.delete(key);
        else state.confirmed.add(key);
        render();
      },
    },
    done ? "Rückgängig" : "So lassen",
  );
}

function messageRow(message, { rowPath = null, showPath = false } = {}) {
  const done = message.severity === "warning" && state.confirmed.has(warningKey(message));
  const fromTimestamps = rowPath && message.path !== rowPath;
  const where = [fromTimestamps ? "TXT" : null, message.line ? `Z. ${message.line}` : null].filter(Boolean).join(" · ");
  return h(
    "li",
    { class: `message ${message.severity}${done ? " done" : ""}` },
    h("span", { class: "message-icon", "aria-hidden": "true" }, done ? "✓" : message.severity === "warning" ? "!" : "×"),
    h(
      "div",
      { class: "message-body" },
      h("p", { class: "message-text" }, where ? h("span", { class: "message-where" }, where) : null, message.text),
      showPath && message.path ? h("p", { class: "path muted" }, basename(message.path)) : null,
    ),
    h(
      "div",
      { class: "message-actions" },
      suggestionButton(message),
      exclusionButtons(message, true),
      replaceButton(message, true),
      confirmButton(message),
    ),
  );
}

function messagesBlock(area, messages) {
  if (messages.length === 0) return null;
  return h("section", { class: "card" }, h("h2", {}, "Allgemein"), cardStack(area, buildCards(messages)));
}

function moveCard(area, cards, target, motion) {
  state.cardIndex.set(area, Math.max(0, Math.min(cards.length - 1, target)));
  state.cardMotion = motion;
  render();
  root.querySelector(".stack-card [data-primary]")?.focus();
}

function nextOpenIndex(cards, from) {
  for (let offset = 1; offset <= cards.length; offset++) {
    const index = (from + offset) % cards.length;
    if (!cardDone(cards[index])) return index;
  }
  return from;
}

function confirmCard(area, cards, index) {
  for (const message of cards[index].messages) state.confirmed.add(warningKey(message));
  moveCard(area, cards, nextOpenIndex(cards, index), "forward");
}

function unconfirmCard(card) {
  for (const message of card.messages) state.confirmed.delete(warningKey(message));
  render();
}

function cardStack(area, cards) {
  const index = Math.min(state.cardIndex.get(area) ?? 0, cards.length - 1);
  state.cardIndex.set(area, index);
  const motion = state.cardMotion;
  state.cardMotion = null;
  const openCount = cards.filter((card) => !cardDone(card)).length;
  if (openCount === 0) {
    return h(
      "div",
      { class: "stack-done" },
      h("p", { class: "all-good" }, "Alles erledigt"),
      h("button", { class: "link", type: "button", onclick: () => moveCard(area, cards, 0, "back") }, "Bestätigte ansehen"),
    );
  }
  const behind = Math.min(2, cards.length - index - 1);
  return h(
    "div",
    {
      class: "stack",
      onkeydown: (event) => {
        if (event.target.closest("input, details")) return;
        if (event.key === "ArrowRight" && index < cards.length - 1) moveCard(area, cards, index + 1, "forward");
        if (event.key === "ArrowLeft" && index > 0) moveCard(area, cards, index - 1, "back");
      },
    },
    h("div", { class: `stack-pile behind-${behind}` }, stackCard(area, cards, index, motion, openCount)),
  );
}

function stackCard(area, cards, index, motion, openCount) {
  const card = cards[index];
  const done = cardDone(card);
  const isGroup = card.messages.length > 1;
  const first = card.messages[0];
  const withSuggestion = card.messages.filter((message) => message.suggestion);
  const severityLabel = card.severity === "error" ? "Fehler" : "Warnung";

  let primary = null;
  if (withSuggestion.length > 0) {
    primary = h(
      "button",
      {
        class: "button primary",
        type: "button",
        "data-primary": true,
        title: isGroup ? null : basename(first.suggestion),
        onclick: () => acceptSuggestions(withSuggestion),
      },
      isGroup ? `Alle ${withSuggestion.length} übernehmen` : first.suggestion_label ? `→ ${first.suggestion_label}` : "Übernehmen",
    );
  }
  let exclude = null;
  if (isGroup) {
    const exclusions = card.messages.map(exclusionsFor);
    if (exclusions.every((options) => options.length === 1)) {
      const paths = [...new Set(exclusions.flatMap((options) => options[0].paths))];
      exclude = h("button", { class: "button", type: "button", onclick: () => excludePaths(paths) }, `Alle ${paths.length} auslassen`);
    }
  } else {
    exclude = [exclusionButtons(first, false), replaceButton(first, false)];
  }
  let confirm = null;
  if (card.severity === "warning") {
    confirm = done
      ? h("button", { class: "button", type: "button", onclick: () => unconfirmCard(card) }, "Rückgängig")
      : h(
          "button",
          { class: primary ? "button" : "button primary", type: "button", "data-primary": primary ? null : true, onclick: () => confirmCard(area, cards, index) },
          isGroup ? `Alle ${card.messages.length} so lassen` : "So lassen",
        );
  }

  return h(
    "article",
    { class: `stack-card ${card.severity}${done ? " done" : ""}${motion ? ` enter-${motion}` : ""}`, tabindex: "-1" },
    h(
      "header",
      { class: "stack-card-head" },
      h("span", { class: `stack-severity ${card.severity}` }, done ? `${severityLabel} · bestätigt` : severityLabel),
      h("span", { class: "muted" }, `${index + 1}/${cards.length} · ${openCount} offen`),
    ),
    isGroup
      ? [
          h("h3", { class: "stack-title" }, ownValue(groupTitles, card.code) ?? first.text, h("span", { class: "count" }, String(card.messages.length))),
          h(
            "details",
            { class: "stack-group" },
            h("summary", {}, "Dateien anzeigen"),
            h("ul", { class: "messages" }, card.messages.map((message) => messageRow(message, { showPath: true }))),
          ),
        ]
      : [
          h("h3", { class: "stack-title" }, first.text),
          first.path
            ? h("p", { class: "path muted" }, basename(first.path), first.line ? ` · Z. ${first.line}` : "")
            : null,
        ],
    h(
      "footer",
      { class: "stack-card-actions" },
      h(
        "button",
        { class: "arrow-button", type: "button", "aria-label": "Vorherige", disabled: index === 0, onclick: () => moveCard(area, cards, index - 1, "back") },
        "‹",
      ),
      h("span", { class: "stack-card-main" }, primary, confirm, exclude),
      h(
        "button",
        {
          class: "arrow-button",
          type: "button",
          "aria-label": "Nächste",
          disabled: index === cards.length - 1,
          "data-primary": !primary && !confirm ? true : null,
          onclick: () => moveCard(area, cards, index + 1, "forward"),
        },
        "›",
      ),
    ),
  );
}

function pairedTimestamps(audioPath) {
  return state.result?.timestamp_pairs.find((pair) => pair.audio_path === audioPath)?.timestamps_path ?? null;
}

function listedRowPaths() {
  const files = activeFiles().filter((entry) => !isIgnoredName(basename(entry.path)));
  return files
    .filter((entry) => {
      const parts = entry.path.split("/");
      return parts[0] === "Noten" || (parts[0] === "Playbacks" && parts.length === 2) || (parts[1] === "Einzaehler" && parts.length === 3);
    })
    .map((entry) => entry.path);
}

function inlineRowPath(message) {
  if (!message.path) return null;
  const pair = state.result?.timestamp_pairs.find((candidate) => candidate.timestamps_path === message.path);
  if (pair) return pair.audio_path;
  return listedRowPaths().includes(message.path) ? message.path : null;
}

function rowMessages(rowPath) {
  const timestamps = pairedTimestamps(rowPath);
  return (state.result?.messages ?? []).filter((message) => message.path === rowPath || (timestamps && message.path === timestamps));
}

function stackMessagesFor(area) {
  return messagesFor(area).filter((message) => !inlineRowPath(message));
}

function inlineMessages(rowPath) {
  const messages = orderedMessages(rowMessages(rowPath));
  if (messages.length === 0) return null;
  return h("ul", { class: "messages inline-messages" }, messages.map((message) => messageRow(message, { rowPath })));
}

function bulkBar(rowPaths) {
  const messages = rowPaths.flatMap(rowMessages);
  const withSuggestion = messages.filter((message) => message.suggestion);
  const minorWarnings = messages.filter(
    (message) => message.severity === "warning" && groupableWarnings.has(message.code) && !state.confirmed.has(warningKey(message)),
  );
  if (withSuggestion.length < 2 && minorWarnings.length < 2) return null;
  return h(
    "div",
    { class: "actions" },
    withSuggestion.length > 1
      ? h("button", { class: "button small", type: "button", onclick: () => acceptSuggestions(withSuggestion) }, `Alle ${withSuggestion.length} Vorschläge übernehmen`)
      : null,
    minorWarnings.length > 1
      ? h(
          "button",
          {
            class: "button small",
            type: "button",
            onclick: () => {
              for (const message of minorWarnings) state.confirmed.add(warningKey(message));
              render();
            },
          },
          `Alle ${minorWarnings.length} kleinen Warnungen so lassen`,
        )
      : null,
  );
}

function fileStatus(path) {
  const messages = [
    ...rowMessages(path),
    ...(state.result?.messages ?? []).filter((message) => message.path && path.startsWith(`${message.path}/`)),
  ];
  if (messages.some((message) => message.severity === "error")) return "error";
  if (messages.some((message) => message.severity === "warning" && !state.confirmed.has(warningKey(message)))) return "warning";
  return "ok";
}

function statusIcon(status) {
  const labels = { error: "Fehler", warning: "Warnung", ok: "In Ordnung" };
  const symbols = { error: "×", warning: "!", ok: "✓" };
  return h("span", { class: `status-icon ${status}`, title: labels[status], "aria-label": labels[status] }, symbols[status]);
}

function nameLabel(name) {
  const prefix = `${state.songName} - `;
  if (!state.songName || !name.startsWith(prefix) || name.length === prefix.length) return name;
  return [h("span", { class: "name-prefix" }, prefix), name.slice(prefix.length)];
}

function fileName(original) {
  const corrected = effectivePath(original);
  if (corrected === original) return h("span", { class: "path" }, nameLabel(basename(original)));
  return h(
    "span",
    { class: "file-name" },
    h("span", { class: "path" }, nameLabel(basename(corrected))),
    h(
      "span",
      { class: "renamed" },
      "statt ",
      basename(original),
      " · ",
      h("button", { class: "link", type: "button", onclick: () => undoRename(original) }, "rückgängig"),
    ),
  );
}

function sortByName(rows) {
  const stem = (path) => basename(path).replace(/\.[^.]+$/, "");
  return rows.sort((left, right) => stem(left.path).localeCompare(stem(right.path), "de"));
}

function renderFolderStep() {
  const input = h("input", {
    type: "file",
    class: "visually-hidden",
    id: "folder",
    webkitdirectory: true,
    multiple: true,
    onchange: (event) => selectFolder(filesFromInput(event.target.files)),
  });
  const zone = h(
    "label",
    {
      class: "dropzone",
      for: "folder",
      ondragover: (event) => {
        event.preventDefault();
        zone.classList.add("active");
      },
      ondragleave: () => zone.classList.remove("active"),
      ondrop: (event) => {
        event.preventDefault();
        zone.classList.remove("active");
        const entries = [...event.dataTransfer.items]
          .map((item) => item.webkitGetAsEntry?.())
          .filter(Boolean);
        if (entries.length !== 1 || !entries[0].isDirectory) {
          selectFolder({ error: "Genau einen Song-Ordner hierher ziehen." });
          return;
        }
        filesFromDirectoryEntry(entries[0]).then(selectFolder, () =>
          selectFolder({ error: "Ordner nicht lesbar." }),
        );
      },
    },
    state.songName
      ? [
          h("span", { class: "dropzone-title" }, state.songName),
          h("span", { class: "folder-summary" }, folderSummary()),
          h("span", { class: "muted" }, "Anderen Ordner hierher ziehen oder klicken"),
        ]
      : [h("span", { class: "dropzone-title" }, "Song-Ordner hierher ziehen"), h("span", { class: "muted" }, "oder klicken")],
  );
  if (state.songName) zone.classList.add("chosen");
  return [
    draftCard(),
    pageTitle("Song-Ordner wählen", "Ein Ordner pro Song, darin „Noten“ und „Playbacks“.", false),
    zone,
    input,
    state.folderError ? h("p", { class: "form-error", role: "alert" }, state.folderError) : null,
    pageNavigation({ next: nextButton() }),
    recentUploadsCard(),
  ];
}

const recentUploadCount = 5;

function parseTimestamp(text) {
  return new Date(text.replace(/(\.\d{3})\d+/, "$1"));
}

const uploadedFormat = new Intl.DateTimeFormat("de-DE", {
  timeZone: berlinZone,
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const approvedFormat = new Intl.DateTimeFormat("de-DE", { timeZone: berlinZone, day: "2-digit", month: "2-digit", year: "numeric" });

function uploadedSongs() {
  return (state.reference?.songs ?? [])
    .filter((song) => song.created_at)
    .map((song) => ({
      ...song,
      created_at: parseTimestamp(song.created_at),
      approved_at: song.approved_at ? parseTimestamp(song.approved_at) : null,
      release_at: song.release_at ? parseTimestamp(song.release_at) : null,
    }));
}

function songTable(songs, categoryNames) {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h("tr", {}, h("th", {}, "Song"), categoryNames ? h("th", {}, "Kategorie") : null, h("th", {}, "Hochgeladen"), h("th", {}, "Freigabe")),
      ),
      h(
        "tbody",
        {},
        songs.map((song) =>
          h(
            "tr",
            {},
            h("td", {}, song.name),
            categoryNames ? h("td", {}, categoryNames.get(song.category_id) ?? "–") : null,
            h("td", {}, `${uploadedFormat.format(song.created_at)} Uhr`),
            h(
              "td",
              { class: song.approved_at ? "" : "muted" },
              song.approved_at
                ? `freigegeben am ${approvedFormat.format(song.approved_at)}`
                : `wartet, frühestens ${formatReleaseDay(expectedReleaseDay(song))}`,
            ),
          ),
        ),
      ),
    ),
  );
}

function recentUploadsCard() {
  const songs = uploadedSongs();
  if (songs.length === 0) return null;
  const categories = state.reference.categories ?? [];
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  const recent = [...songs].sort((left, right) => right.created_at - left.created_at).slice(0, recentUploadCount);
  const toggle = () => {
    state.showAllSongs = !state.showAllSongs;
    render();
  };
  return h(
    "section",
    { class: "card" },
    h("div", { class: "section-head" }, h("h2", {}, "Zuletzt hochgeladen")),
    songTable(recent, categoryNames),
    songs.length > recentUploadCount || state.showAllSongs
      ? h(
          "button",
          { class: "button small song-toggle", type: "button", "aria-expanded": String(state.showAllSongs), onclick: toggle },
          state.showAllSongs ? "Alle Songs ausblenden" : `Alle Songs anzeigen (${songs.length})`,
        )
      : null,
    state.showAllSongs ? allSongsSection(songs, categories) : null,
  );
}

function searchKey(text) {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function allSongsSection(songs, categories) {
  const list = h("div", { class: "song-groups" });
  const fillList = () => list.replaceChildren(...songGroups(songs, categories));
  const search = h("input", {
    type: "search",
    placeholder: "Song suchen",
    "aria-label": "Song suchen",
    value: state.songSearch,
    oninput: (event) => {
      state.songSearch = event.target.value;
      fillList();
    },
  });
  const categorySelect = h(
    "select",
    {
      "aria-label": "Kategorie",
      onchange: (event) => {
        state.songCategoryFilter = event.target.value === "" ? null : Number(event.target.value);
        fillList();
      },
    },
    h("option", { value: "" }, "Alle Kategorien"),
    categories.map((category) =>
      h("option", { value: String(category.id), selected: category.id === state.songCategoryFilter }, category.name),
    ),
  );
  fillList();
  return [h("div", { class: "song-filters" }, search, categorySelect), list];
}

function songGroups(songs, categories) {
  const query = searchKey(state.songSearch.trim());
  const groups = categories
    .filter((category) => state.songCategoryFilter == null || category.id === state.songCategoryFilter)
    .map((category) => {
      const matching = songs
        .filter((song) => song.category_id === category.id && searchKey(song.name).includes(query))
        .sort((left, right) => left.name.localeCompare(right.name, "de"));
      if (matching.length === 0) return null;
      return h(
        "div",
        { class: "song-group" },
        h("h3", {}, category.name, h("span", { class: "count" }, String(matching.length))),
        songTable(matching, null),
      );
    })
    .filter(Boolean);
  return groups.length > 0 ? groups : [h("p", { class: "muted" }, "Keine Songs gefunden")];
}

function folderSummary() {
  const visibleFiles = activeFiles().filter((entry) => !isIgnoredName(basename(entry.path)));
  const countIn = (test) => visibleFiles.filter((entry) => test(entry.path.split("/"))).length;
  return [
    plural(countIn((parts) => parts[0] === "Noten" && parts.length === 2), "Noten", "Noten"),
    plural(countIn((parts) => parts[0] === "Playbacks" && parts.length === 2), "Playback", "Playbacks"),
    plural(countIn((parts) => parts[0] === "Playbacks" && parts[1] === "Einzaehler" && parts.length === 3), "Einzähler", "Einzähler"),
    formatBytes(visibleFiles.reduce((sum, entry) => sum + entry.size, 0)),
  ].join(" · ");
}

function renderCategoryStep() {
  const categories = state.reference?.categories ?? [];
  const choose = (id) => {
    if (state.categoryId !== id) {
      state.categoryId = id;
      state.result = null;
      state.checkError = null;
    }
    render();
  };
  const proceed = () => {
    if (state.result) {
      goTo(2);
      return;
    }
    runCheck().then(() => {
      if (state.result) goTo(2);
    });
  };
  const songs = state.reference?.songs ?? [];
  return [
    pageTitle("Kategorie wählen", `In welche Kategorie gehört „${state.songName}“?`, false),
    h(
      "div",
      { class: "category-grid", role: "radiogroup", "aria-label": "Kategorie" },
      categories.map((category) => {
        const selected = category.id === state.categoryId;
        const inCategory = songs.filter((song) => song.category_id === category.id);
        const exists = inCategory.some((song) => song.name.normalize("NFC").toLowerCase() === state.songName.toLowerCase());
        return h(
          "button",
          {
            type: "button",
            role: "radio",
            "aria-checked": selected ? "true" : "false",
            class: `category-tile${selected ? " selected" : ""}`,
            disabled: state.checking,
            onclick: () => choose(category.id),
          },
          h("span", { class: "category-name" }, category.name),
          h("span", { class: "muted" }, plural(inCategory.length, "Song", "Songs")),
          exists ? h("span", { class: "category-exists" }, `„${state.songName}“ gibt es hier schon`) : null,
          selected ? h("span", { class: "category-check", "aria-hidden": "true" }, "✓") : null,
        );
      }),
    ),
    state.checkError
      ? h("p", { class: "form-error", role: "alert" }, state.checkError, " ", h("button", { class: "link", type: "button", onclick: runCheck }, "Erneut versuchen"))
      : null,
    pageNavigation({
      next: h(
        "button",
        {
          class: "button primary",
          type: "button",
          disabled: state.categoryId == null || state.checking,
          onclick: proceed,
        },
        state.checking ? "Prüfe …" : "Weiter",
      ),
    }),
  ];
}

const viewerPreview = 3;

function viewerList(viewers) {
  if (viewers.length <= viewerPreview + 1) return viewers.join(", ");
  return h(
    "details",
    { class: "viewers" },
    h("summary", {}, viewers.slice(0, viewerPreview).join(", "), h("span", { class: "tag" }, `+${viewers.length - viewerPreview}`)),
    h("p", {}, viewers.slice(viewerPreview).join(", ")),
  );
}

function renderSheetMusicStep() {
  const result = state.result;
  const partsById = new Map(state.reference.parts.map((part) => [part.id, part]));
  const instrumentsById = new Map(state.reference.instruments.map((instrument) => [instrument.id, instrument]));
  const viewersByPart = new Map();
  for (const { part_id, instrument_id } of state.reference.instrument_parts) {
    if (!viewersByPart.has(part_id)) viewersByPart.set(part_id, []);
    const instrument = instrumentsById.get(instrument_id);
    if (instrument) viewersByPart.get(part_id).push(instrumentLabel(instrument));
  }
  const sheetByPath = new Map(result.sheet_music.map((entry) => [entry.path, entry]));
  const files = activeFiles().filter(
    (entry) => entry.path.startsWith("Noten/") && !isIgnoredName(basename(entry.path)),
  );
  const allRows = sortByName(files.map((entry) => ({ path: entry.path, status: fileStatus(entry.path) })));
  const rows = filterRows(allRows);
  return [
    pageTitle("Noten", `${result.sheet_music.length} von ${files.length} werden hochgeladen`),
    messagesBlock("sheetMusic", stackMessagesFor("sheetMusic")),
    files.length === 0
      ? h("section", { class: "card" }, h("p", { class: "muted" }, "Keine Noten"))
      : h(
          "section",
          { class: "card" },
          h(
            "div",
            { class: "section-head" },
            h("h2", {}, "Dateien", h("span", { class: "count" }, String(files.length))),
            filterBar(allRows),
          ),
          bulkBar(files.map((entry) => entry.path)),
          filterEmpty(rows),
          h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              { class: "file-table" },
              h(
                "thead",
                {},
                h("tr", {}, h("th", {}, ""), h("th", {}, "Datei"), h("th", {}, "Stimme"), h("th", {}, "Stimmung"), h("th", {}, "Level"), h("th", {}, "Sichtbar für")),
              ),
              rows.map((row) => {
                const sheet = sheetByPath.get(row.path);
                const part = sheet ? partsById.get(sheet.part_id) : null;
                const viewers = sheet ? (viewersByPart.get(sheet.part_id) ?? []).sort((left, right) => left.localeCompare(right, "de")) : [];
                return rowGroup(
                  row.path,
                  row.status,
                  h(
                    "tr",
                    { class: sheet ? "" : "unmatched" },
                    h("td", {}, statusIcon(row.status)),
                    h("td", {}, fileName(row.path)),
                    h("td", {}, part?.name ?? "–"),
                    h("td", {}, part ? part.transposition || "–" : "–"),
                    h("td", {}, sheet?.level_name ?? "–"),
                    h(
                      "td",
                      { class: viewers.length === 0 && sheet ? "form-error" : "viewers-cell" },
                      sheet ? (viewers.length > 0 ? viewerList(viewers) : "niemand") : "–",
                    ),
                  ),
                  6,
                );
              }),
            ),
          ),
        ),
    pageNavigation({ next: nextButton() }),
  ];
}

const player = { audio: new Audio(), countInAudio: new Audio(), path: null, countIn: null, urls: new Map() };

function audioUrl(path) {
  const entry = state.files.find((candidate) => candidate.path === path);
  if (!entry) return null;
  const known = player.urls.get(path);
  if (known && known.file === entry.file) return known.url;
  if (known) URL.revokeObjectURL(known.url);
  const url = URL.createObjectURL(entry.file);
  player.urls.set(path, { file: entry.file, url });
  return url;
}

function loadPlayer(path) {
  if (player.path === path) return true;
  const url = audioUrl(path);
  if (!url) return false;
  player.audio.src = url;
  player.path = path;
  return true;
}

function cancelCountIn() {
  if (!player.countIn) return;
  player.countIn = null;
  player.countInAudio.pause();
}

function togglePlayer(path) {
  if (player.path === path && (player.countIn || !player.audio.paused)) {
    cancelCountIn();
    player.audio.pause();
    updatePlayer();
    return;
  }
  cancelCountIn();
  if (loadPlayer(path)) player.audio.play().catch(() => {});
}

function playFrom(path, milliseconds) {
  cancelCountIn();
  if (!loadPlayer(path)) return;
  player.audio.currentTime = milliseconds / 1000;
  player.audio.play().catch(() => {});
}

function playLetter(path, letter) {
  const countIn = state.withCountIn ? state.result?.count_ins.find((candidate) => candidate.name === letter.count_in) : null;
  const countInUrl = countIn ? audioUrl(countIn.path) : null;
  if (!countIn || !countInUrl || letter.position_ms <= countIn.duration_ms) {
    playFrom(path, letter.position_ms);
    return;
  }
  cancelCountIn();
  if (!loadPlayer(path)) return;
  player.audio.pause();
  player.audio.currentTime = letter.position_ms / 1000;
  player.countIn = { name: countIn.name, position: letter.position_ms };
  player.countInAudio.src = countInUrl;
  player.countInAudio.currentTime = 0;
  player.countInAudio.play().catch(() => {});
  updatePlayer();
}

player.countInAudio.addEventListener("ended", () => {
  if (!player.countIn) return;
  player.countIn = null;
  player.audio.play().catch(() => {});
});

function stopPlayer() {
  cancelCountIn();
  player.audio.pause();
  player.audio.removeAttribute("src");
  player.audio.load();
  player.path = null;
  updatePlayer();
}

function updatePlayer() {
  const position = player.countIn ? player.countIn.position : player.audio.currentTime * 1000;
  for (const element of root.querySelectorAll("[data-player]")) {
    const active = element.dataset.player === player.path;
    const playing = active && (Boolean(player.countIn) || !player.audio.paused);
    if (element.classList.contains("play-button")) {
      element.textContent = playing ? "❚❚" : "▶";
      element.setAttribute("aria-label", playing ? "Pause" : "Abspielen");
    } else if (element.classList.contains("player-time")) {
      element.textContent =
        active && player.countIn
          ? `Einzähler ${player.countIn.name} …`
          : `${formatDuration(active ? position : 0)} / ${formatDuration(Number(element.dataset.duration))}`;
    } else if (element.classList.contains("timeline")) {
      const duration = Number(element.dataset.duration);
      const playhead = element.querySelector(".timeline-playhead");
      const progress = element.querySelector(".timeline-progress");
      const fraction = `${Math.min(position / duration, 1) * 100}%`;
      playhead.hidden = !active;
      progress.hidden = !active;
      if (active) {
        playhead.style.left = fraction;
        progress.style.width = fraction;
      }
      const marks = [...element.querySelectorAll(".timeline-mark")];
      let current = -1;
      marks.forEach((mark, index) => {
        if (active && Number(mark.dataset.position) <= position) current = index;
      });
      marks.forEach((mark, index) => mark.classList.toggle("playing", index === current));
    }
  }
}

for (const type of ["play", "pause", "ended", "timeupdate", "seeked"]) {
  player.audio.addEventListener(type, updatePlayer);
}

function playerControls(path, duration) {
  return h(
    "div",
    { class: "player-controls" },
    h("button", { class: "play-button", type: "button", "data-player": path, "aria-label": "Abspielen", onclick: () => togglePlayer(path) }, "▶"),
    h("span", { class: "player-time", "data-player": path, "data-duration": String(duration) }, `0:00 / ${formatDuration(duration)}`),
  );
}

function countInToggle() {
  return h(
    "label",
    { class: "check small" },
    h("input", {
      type: "checkbox",
      checked: state.withCountIn,
      onchange: (event) => {
        state.withCountIn = event.target.checked;
        if (!state.withCountIn) cancelCountIn();
        render();
      },
    }),
    "Buchstaben mit Einzähler abspielen",
  );
}

const jumpMarks = new Set(["D.S.", "D.C."]);

const markSymbols = {
  Coda: "coda",
  "D.S.": "segno",
  "D.C.": "da-capo",
};

function markLabel(name) {
  const symbol = ownValue(markSymbols, name);
  return h(
    "span",
    { class: `mark${symbol ? " jump" : ""}`, title: symbol ? name : null },
    symbol ? [h("span", { class: `mark-symbol ${symbol}`, "aria-hidden": "true" }), h("span", { class: "visually-hidden" }, name)] : name,
  );
}

function timelineTicks(duration) {
  const seconds = duration / 1000;
  const step = [10, 15, 30, 60, 120, 300].find((candidate) => seconds / candidate <= 8) ?? 600;
  const ticks = [];
  for (let time = 0; time * 1000 < duration * 0.93; time += step) ticks.push(time * 1000);
  ticks.push(duration);
  return ticks;
}

function timeline(playback) {
  const duration = Math.max(playback.duration_ms, 1);
  const percent = (milliseconds) => `${((Math.min(milliseconds, duration) / duration) * 100).toFixed(3)}%`;
  const letters = playback.letters;
  let inJump = false;
  const segments = letters.map((letter, index) => {
    if (jumpMarks.has(letter.name)) inJump = true;
    const end = letters[index + 1]?.position_ms ?? duration;
    return h("div", {
      class: `timeline-segment${index % 2 === 1 ? " alternate" : ""}${inJump ? " jump" : ""}`,
      style: `left: ${percent(letter.position_ms)}; width: calc(${percent(end)} - ${percent(letter.position_ms)})`,
      title: `${letter.name} · ${formatPosition(letter.position_ms)} bis ${formatPosition(end)} · Einzähler ${letter.count_in}`,
    });
  });
  const ticks = timelineTicks(duration);
  return h(
    "div",
    {
      class: "timeline",
      style: `--lanes: ${letters.length > 0 ? 1 : 0}`,
      "data-player": playback.path,
      "data-duration": String(duration),
      "aria-label": letters.length > 0 ? `Buchstaben: ${letters.map((letter) => letter.name).join(", ")}` : "Keine Buchstaben",
    },
    h(
      "div",
      { class: "timeline-marks" },
      letters.map((letter) =>
        h(
          "button",
          {
            type: "button",
            class: `timeline-mark${ownValue(markSymbols, letter.name) ? " jump" : ""}`,
            style: `left: ${percent(letter.position_ms)}`,
            "data-fraction": String(Math.min(letter.position_ms / duration, 1)),
            "data-position": String(letter.position_ms),
            title: `${letter.name} · ${formatPosition(letter.position_ms)} · Einzähler ${letter.count_in}`,
            "aria-label": `Ab ${letter.name} abspielen (${formatPosition(letter.position_ms)})`,
            onclick: () => playLetter(playback.path, letter),
          },
          markLabel(letter.name),
        ),
      ),
    ),
    h(
      "div",
      {
        class: "timeline-track",
        onclick: (event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          playFrom(playback.path, Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * duration);
        },
      },
      segments,
      h("div", { class: "timeline-progress", hidden: true }),
      h("div", { class: "timeline-playhead", hidden: true }),
    ),
    h(
      "div",
      { class: "timeline-axis", "aria-hidden": "true" },
      ticks.map((time, index) =>
        h(
          "span",
          {
            class: `timeline-tick${index === 0 ? " start" : index === ticks.length - 1 ? " end" : ""}`,
            style: `left: ${percent(time)}`,
          },
          formatDuration(time),
        ),
      ),
    ),
  );
}

function layoutTimelines() {
  for (const element of root.querySelectorAll(".timeline")) {
    const width = element.clientWidth;
    const laneEnds = [];
    for (const mark of element.querySelectorAll(".timeline-mark")) {
      const markWidth = mark.offsetWidth;
      const center = Number(mark.dataset.fraction) * width;
      const left = Math.min(Math.max(center - markWidth / 2, 0), Math.max(width - markWidth, 0));
      let lane = laneEnds.findIndex((laneEnd) => laneEnd + 4 <= left);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = left + markWidth;
      mark.style.left = `${left}px`;
      mark.style.setProperty("--shift", "0px");
      mark.style.setProperty("--stem", `${center - left}px`);
      mark.style.setProperty("--lane", String(lane));
    }
    if (laneEnds.length > 0) element.style.setProperty("--lanes", String(laneEnds.length));
  }
}

function instrumentPicker(playback, index) {
  const settings = state.settings.get(playback.path);
  const instruments = [...state.reference.instruments].sort((left, right) =>
    instrumentLabel(left).localeCompare(instrumentLabel(right), "de"),
  );
  const selectedNames = instruments.filter((instrument) => settings.ids.has(instrument.id)).map(instrumentLabel);
  const invalid = settings.mode !== "all" && settings.ids.size === 0;
  const open = invalid || state.openPickers.has(playback.path);
  const summary =
    settings.mode === "all"
      ? "alle"
      : settings.mode === "only"
        ? selectedNames.join(", ") || "–"
        : `alle außer ${selectedNames.join(", ") || "–"}`;
  const toggleOpen = () => {
    if (state.openPickers.has(playback.path)) state.openPickers.delete(playback.path);
    else state.openPickers.add(playback.path);
    render();
  };
  const modes = [
    ["all", "Alle"],
    ["only", "Nur für …"],
    ["except", "Alle außer …"],
  ];
  return h(
    "div",
    { class: `picker${open ? " open" : ""}` },
    h(
      "div",
      { class: "picker-summary" },
      h("span", { class: "muted" }, "Sichtbar für: "),
      h("strong", {}, summary),
      settings.source === "type" ? h("span", { class: "tag" }, "automatisch") : null,
      invalid ? null : h("button", { class: "link", type: "button", onclick: toggleOpen }, open ? "Fertig" : "Ändern"),
    ),
    open
      ? [
          h(
            "div",
            { class: "segmented", role: "radiogroup", "aria-label": "Sichtbar für" },
            modes.map(([mode, label]) =>
              h(
                "label",
                { class: settings.mode === mode ? "selected" : "" },
                h("input", {
                  type: "radio",
                  name: `mode-${index}`,
                  value: mode,
                  checked: settings.mode === mode,
                  onchange: () => {
                    settings.mode = mode;
                    settings.source = "user";
                    render();
                  },
                }),
                label,
              ),
            ),
          ),
          settings.mode === "all"
            ? null
            : [
                invalid ? h("p", { class: "form-error" }, "Instrument wählen") : null,
                h("input", {
                  type: "search",
                  class: "instrument-search",
                  placeholder: "Suchen …",
                  "aria-label": "Instrument suchen",
                  oninput: (event) => {
                    const query = event.target.value.trim().toLowerCase();
                    for (const chip of event.target.parentElement.querySelectorAll(".instrument-chips .chip")) {
                      chip.hidden = query !== "" && !chip.textContent.toLowerCase().includes(query);
                    }
                  },
                }),
                h(
                  "div",
                  { class: "chips instrument-chips" },
                  instruments.map((instrument) =>
                    h(
                      "button",
                      {
                        class: "chip",
                        type: "button",
                        "aria-pressed": String(settings.ids.has(instrument.id)),
                        onclick: () => {
                          if (settings.ids.has(instrument.id)) settings.ids.delete(instrument.id);
                          else settings.ids.add(instrument.id);
                          settings.source = "user";
                          render();
                        },
                      },
                      instrumentLabel(instrument),
                    ),
                  ),
                ),
              ],
        ]
      : null,
  );
}

function renderPlaybacksStep() {
  const result = state.result;
  const playbackByPath = new Map(result.playbacks.map((entry) => [entry.path, entry]));
  const audioFiles = activeFiles().filter(
    (entry) =>
      entry.path.startsWith("Playbacks/") &&
      entry.path.split("/").length === 2 &&
      !isIgnoredName(basename(entry.path)),
  );
  const allRows = sortByName(audioFiles.map((entry) => ({ path: entry.path, status: fileStatus(entry.path) })));
  const rows = filterRows(allRows);
  const countInFiles = activeFiles().filter((entry) => {
    const parts = entry.path.split("/");
    return parts[0] === "Playbacks" && parts[1] === "Einzaehler" && parts.length === 3 && !isIgnoredName(parts[2]);
  });
  const allCountInRows = sortByName(countInFiles.map((entry) => ({ path: entry.path, status: fileStatus(entry.path) })));
  const countInRows = filterRows(allCountInRows);
  const filter = filterBar([...allRows, ...allCountInRows]);
  const filtering = (state.listFilter.get(state.step) ?? "all") !== "all";
  const countInsByPath = new Map(result.count_ins.map((countIn) => [countIn.path, countIn]));
  const usage = new Map();
  for (const playback of result.playbacks) {
    for (const letter of playback.letters) {
      if (!usage.has(letter.count_in)) usage.set(letter.count_in, new Set());
      usage.get(letter.count_in).add(playback.path);
    }
  }
  return [
    pageTitle("Playbacks", `${result.playbacks.length} von ${audioFiles.length} werden hochgeladen`),
    messagesBlock("playbacks", stackMessagesFor("playbacks")),
    filter ? h("div", { class: "toolbar" }, filter) : null,
    filterEmpty([...rows, ...countInRows]),
    audioFiles.length === 0
      ? h("section", { class: "card" }, h("p", { class: "muted" }, "Keine Playbacks"))
      : filtering && rows.length === 0
        ? null
        : h(
          "section",
          { class: "card" },
          h(
            "div",
            { class: "section-head" },
            h("h2", {}, "Playbacks", h("span", { class: "count" }, String(audioFiles.length))),
            countInToggle(),
          ),
          bulkBar(audioFiles.map((entry) => entry.path)),
          h(
            "div",
            { class: "playback-list" },
            rows.map((row, index) => {
              const playback = playbackByPath.get(row.path);
              return h(
                "article",
                { class: `playback ${row.status}` },
                h(
                  "div",
                  { class: "playback-head" },
                  h(
                    "div",
                    { class: "playback-title" },
                    statusIcon(row.status),
                    h("div", {}, h("h3", {}, playback ? playback.type : basename(effectivePath(row.path))), h("div", { class: "playback-file" }, fileName(row.path))),
                  ),
                  playback
                    ? h("span", { class: "playback-meta" }, `${formatDuration(playback.duration_ms)} · ${plural(playback.letters.length, "Buchstabe", "Buchstaben")}`)
                    : h("span", { class: "tag" }, "Wird nicht hochgeladen"),
                ),
                inlineMessages(row.path),
                playback
                  ? [
                      h("div", { class: "player" }, playerControls(playback.path, playback.duration_ms), timeline(playback)),
                      playback.letters.length > 0
                        ? h(
                            "details",
                            { class: "letters" },
                            h("summary", {}, "Buchstaben anzeigen"),
                            h(
                              "table",
                              {},
                              h("thead", {}, h("tr", {}, h("th", {}, "Buchstabe"), h("th", {}, "Zeit"), h("th", {}, "Einzähler"))),
                              h(
                                "tbody",
                                {},
                                playback.letters.map((letter) =>
                                  h("tr", {}, h("td", {}, markLabel(letter.name)), h("td", { class: "path" }, formatPosition(letter.position_ms)), h("td", {}, letter.count_in)),
                                ),
                              ),
                            ),
                          )
                        : null,
                      h("div", { class: "playback-footer" }, instrumentPicker(playback, index)),
                    ]
                  : null,
              );
            }),
          ),
        ),
    countInFiles.length > 0 && !(filtering && countInRows.length === 0)
      ? h(
          "section",
          { class: "card" },
          h("div", { class: "section-head" }, h("h2", {}, "Einzähler", h("span", { class: "count" }, String(countInFiles.length)))),
          bulkBar(countInFiles.map((entry) => entry.path)),
          h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              { class: "file-table" },
              h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, ""), h("th", {}, "Name"), h("th", {}, "Länge"), h("th", {}, "Genutzt von"), h("th", {}, "Datei"))),
              countInRows.map((row) => {
                const countIn = countInsByPath.get(row.path);
                return rowGroup(
                  row.path,
                  row.status,
                  h(
                    "tr",
                    { class: countIn ? "" : "unmatched" },
                    h("td", {}, statusIcon(row.status)),
                    h(
                      "td",
                      {},
                      countIn
                        ? h("button", { class: "play-button small", type: "button", "data-player": countIn.path, "aria-label": "Abspielen", onclick: () => togglePlayer(countIn.path) }, "▶")
                        : null,
                    ),
                    h("td", {}, countIn ? h("strong", {}, countIn.name) : "–"),
                    h("td", {}, countIn ? `${(countIn.duration_ms / 1000).toFixed(1).replace(".", ",")} s` : "–"),
                    h("td", {}, countIn ? plural(usage.get(countIn.name)?.size ?? 0, "Playback", "Playbacks") : "–"),
                    h("td", {}, fileName(row.path)),
                  ),
                  6,
                );
              }),
            ),
          ),
        )
      : null,
    pageNavigation({ next: nextButton() }),
  ];
}

const weekdayNames = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function shiftDay(day, offset) {
  const [year, month, date] = day.split("-").map(Number);
  return dayString(year, month, date + offset);
}

function releaseCalendar(earliest, disabled) {
  const release = state.release;
  const [year, month] = release.month.split("-").map(Number);
  const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const nowParts = berlinParts(new Date());
  const today = dayString(nowParts.year, nowParts.month, nowParts.day);
  const monthTitle = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
  const showMonth = (day) => {
    release.month = day.slice(0, 7);
    render();
  };
  const select = (day) => {
    release.date = day;
    release.month = day.slice(0, 7);
    render();
    root.querySelector(`.calendar-day[data-day="${day}"]`)?.focus();
  };
  const onKey = (event) => {
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const offset = offsets[event.key];
    const current = event.target.dataset?.day;
    if (!offset || !current) return;
    event.preventDefault();
    const target = shiftDay(current, offset);
    if (target < earliest) return;
    if (target.slice(0, 7) !== release.month) {
      release.month = target.slice(0, 7);
      render();
    }
    root.querySelector(`.calendar-day[data-day="${target}"]`)?.focus();
  };
  const firstOpenDay = earliest.startsWith(release.month) ? earliest : dayString(year, month, 1);
  const focusDay = release.date.startsWith(release.month) ? release.date : firstOpenDay;
  const cells = [];
  for (let index = 0; index < firstWeekday; index++) cells.push(h("span", { class: "calendar-blank" }));
  for (let date = 1; date <= daysInMonth; date++) {
    const day = dayString(year, month, date);
    const selected = day === release.date;
    cells.push(
      h(
        "button",
        {
          type: "button",
          class: `calendar-day${selected ? " selected" : ""}${day === today ? " today" : ""}`,
          "data-day": day,
          "aria-pressed": String(selected),
          "aria-label": formatReleaseDay(day),
          tabindex: day === focusDay ? "0" : "-1",
          disabled: disabled || day < earliest,
          onclick: () => select(day),
        },
        String(date),
      ),
    );
  }
  const previousMonth = dayString(year, month - 1, 1);
  const nextMonth = dayString(year, month + 1, 1);
  return h(
    "div",
    { class: "calendar" },
    h(
      "div",
      { class: "calendar-head" },
      h("span", { class: "calendar-title" }, monthTitle),
      h(
        "span",
        { class: "calendar-nav" },
        h("button", { type: "button", class: "calendar-arrow", "aria-label": "Vorheriger Monat", disabled: disabled || previousMonth.slice(0, 7) < earliest.slice(0, 7), onclick: () => showMonth(previousMonth) }, "‹"),
        h("button", { type: "button", class: "calendar-arrow", "aria-label": "Nächster Monat", disabled, onclick: () => showMonth(nextMonth) }, "›"),
      ),
    ),
    h(
      "div",
      { class: "calendar-grid", role: "group", "aria-label": monthTitle, onkeydown: onKey },
      weekdayNames.map((name) => h("span", { class: "calendar-weekday", "aria-hidden": "true" }, name)),
      cells,
    ),
  );
}

function releaseSection(disabled) {
  const earliest = earliestReleaseDay();
  const release = state.release;
  const choose = (mode) => {
    release.mode = mode;
    if (mode === "date" && release.date === "") release.date = earliest;
    if (mode === "date") release.month = release.date.slice(0, 7);
    render();
  };
  return h(
    "section",
    { class: `card release${release.mode === "date" ? " with-calendar" : ""}` },
    h(
      "div",
      { class: "release-options" },
      h("h2", {}, "Freigabe"),
      h(
        "div",
        { class: "option-list", role: "group", "aria-label": "Freigabe" },
        [
          ["earliest", "Frühestmöglich", formatReleaseDay(earliest)],
          ["date", "An einem bestimmten Tag", release.mode === "date" && releaseDateValid() ? formatReleaseDay(release.date) : "im Kalender wählen"],
        ].map(([mode, label, detail]) =>
          h(
            "button",
            { type: "button", class: "option", disabled, "aria-pressed": String(release.mode === mode), onclick: () => choose(mode) },
            h("span", { class: "option-dot", "aria-hidden": "true" }),
            h("span", { class: "option-text" }, h("span", { class: "option-label" }, label), h("span", { class: "option-detail" }, detail)),
          ),
        ),
      ),
      release.mode === "date" && !releaseDateValid() ? h("p", { class: "form-error" }, `Frühestens ${formatReleaseDay(earliest)}`) : null,
    ),
    release.mode === "date" ? releaseCalendar(earliest, disabled) : null,
  );
}

function blockerRow(message) {
  return h(
    "li",
    { class: `message ${message.severity}` },
    h("span", { class: "message-icon", "aria-hidden": "true" }, message.severity === "warning" ? "!" : "×"),
    h(
      "div",
      { class: "message-body" },
      h(
        "p",
        { class: "message-text" },
        message.path ? h("span", { class: "blocker-file" }, basename(message.path), message.line ? ` · Z. ${message.line}` : "") : null,
        message.text,
      ),
    ),
  );
}

function blockerNote(text) {
  return h(
    "li",
    { class: "message note" },
    h("span", { class: "message-icon", "aria-hidden": "true" }, "·"),
    h("div", { class: "message-body" }, h("p", { class: "message-text" }, text)),
  );
}

function blockerList(messages, renderRow) {
  const ordered = orderedMessages(messages);
  const counts = new Map();
  for (const message of ordered) {
    const key = `${message.severity}|${message.code}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const shown = new Set();
  const items = [];
  for (const message of ordered) {
    const key = `${message.severity}|${message.code}`;
    if (counts.get(key) < groupMinimum) {
      items.push(renderRow(message));
      continue;
    }
    if (shown.has(key)) continue;
    shown.add(key);
    const group = ordered.filter((candidate) => `${candidate.severity}|${candidate.code}` === key);
    items.push(
      h(
        "li",
        { class: `message ${message.severity} blocker-group` },
        h("span", { class: "message-icon", "aria-hidden": "true" }, message.severity === "warning" ? "!" : "×"),
        h(
          "details",
          { class: "message-body" },
          h("summary", {}, ownValue(groupTitles, message.code) ?? message.text, h("span", { class: "count" }, String(group.length))),
          h("ul", { class: "messages inline-messages" }, group.map(renderRow)),
        ),
      ),
    );
  }
  return items;
}

const blockerPreview = 5;

function cappedItems(items) {
  if (items.length <= blockerPreview + 1) return items;
  return [
    ...items.slice(0, blockerPreview),
    h(
      "li",
      { class: "blocker-more" },
      h("details", {}, h("summary", {}, `${items.length - blockerPreview} weitere anzeigen`), h("ul", { class: "messages inline-messages" }, items.slice(blockerPreview))),
    ),
  ];
}

function uploadCard() {
  const result = state.result;
  const upload = state.upload;
  const running = upload?.status === "running";
  const reasons = blockingReasons();
  const isOpen = (message) => message.severity === "error" || !state.confirmed.has(warningKey(message));
  const invalidPlaybacks = result.playbacks.filter((playback) => !playbackSettingsValid(playback)).length;
  const sections = [
    {
      title: "Allgemein",
      messages: messagesFor("overview").filter(isOpen),
      notes: result.playbacks.length === 0 && result.sheet_music.length === 0 ? ["Nichts zum Hochladen"] : [],
      renderRow: (message) => messageRow(message, { showPath: true }),
    },
    { title: "Noten", step: 2, messages: messagesFor("sheetMusic").filter(isOpen), notes: [], renderRow: blockerRow },
    {
      title: "Playbacks",
      step: 3,
      messages: messagesFor("playbacks").filter(isOpen),
      notes: invalidPlaybacks > 0 ? [`Instrument wählen bei ${plural(invalidPlaybacks, "Playback", "Playbacks")}`] : [],
      renderRow: blockerRow,
    },
    { title: "Freigabe", messages: [], notes: releaseDateValid() ? [] : ["Tag wählen (oben)"], renderRow: blockerRow },
  ].filter((section) => section.messages.length > 0 || section.notes.length > 0);

  const all = sections.flatMap((section) => section.messages);
  const errors = all.filter((message) => message.severity === "error").length;
  const warnings = all.length - errors;
  const summary = [errors > 0 ? plural(errors, "Fehler", "Fehler") : null, warnings > 0 ? `${plural(warnings, "Warnung", "Warnungen")} offen` : null]
    .filter(Boolean)
    .join(" · ");
  const ready = sections.length === 0;
  return h(
    "section",
    { class: "card upload" },
    h(
      "div",
      { class: "section-head" },
      h("h2", {}, "Hochladen"),
      ready
        ? h("span", { class: "blockers-summary ready" }, "Bereit zum Hochladen")
        : summary
          ? h("span", { class: `blockers-summary${errors > 0 ? " error" : ""}` }, summary)
          : null,
    ),
    sections.map((section) =>
      h(
        "div",
        { class: "blocker-section" },
        h(
          "div",
          { class: "blocker-head" },
          h("h3", {}, section.title),
          section.step ? h("button", { class: "link", type: "button", onclick: () => goTo(section.step) }, "→ zur Seite") : null,
        ),
        h(
          "ul",
          { class: "messages blocker-list" },
          section.step ? cappedItems(blockerList(section.messages, section.renderRow)) : blockerList(section.messages, section.renderRow),
          section.notes.map(blockerNote),
        ),
      ),
    ),
    h(
      "div",
      { class: "upload-footer" },
      upload?.status === "failed" ? h("p", { class: "form-error", role: "alert" }, upload.text) : null,
      running
        ? h(
            "div",
            { class: "progress", role: "progressbar", "aria-label": "Upload", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(upload.progress * 100)) },
            h("div", { class: "progress-bar", style: `width: ${Math.round(upload.progress * 100)}%` }),
            h("span", { class: "progress-label" }, `${Math.round(upload.progress * 100)} %`),
          )
        : null,
      h(
        "div",
        { class: "upload-action" },
        h(
          "button",
          { class: "button primary large", type: "button", disabled: reasons.length > 0 || running, onclick: startUpload },
          running ? "Lädt hoch …" : demo ? "Manifest anzeigen" : "Hochladen",
        ),
        reasons.length > 0 ? h("span", { class: "muted small" }, "Erst die Punkte oben erledigen") : null,
      ),
    ),
  );
}

function renderOverviewStep() {
  const result = state.result;
  const category = state.reference.categories.find((entry) => entry.id === state.categoryId);
  const upload = state.upload;
  const running = upload?.status === "running";
  const sizes = new Map(state.files.map((entry) => [entry.path, entry.size]));
  const totalBytes = manifestPaths(result).reduce((sum, path) => sum + (sizes.get(path) ?? 0), 0);
  const renamed = Object.keys(state.renames).length;

  if (upload?.status === "done") {
    return [
      h(
        "section",
        { class: "card outcome success" },
        h("span", { class: "outcome-icon", "aria-hidden": "true" }, "✓"),
        h("h1", {}, "Hochgeladen"),
        h("p", {}, `„${result.song_name}“ erscheint am ${formatReleaseDay(upload.releaseDay)} in der App.`),
        h("button", { class: "button primary", type: "button", onclick: resetSong }, "Nächsten Song wählen"),
      ),
    ];
  }

  const tile = (value, label) => h("div", { class: "stat" }, h("span", { class: "stat-value" }, value), h("span", { class: "stat-label" }, label));
  return [
    pageTitle("Überblick", null),
    h(
      "div",
      { class: "stats" },
      tile(String(result.sheet_music.length), "Noten"),
      tile(String(result.playbacks.length), result.playbacks.length === 1 ? "Playback" : "Playbacks"),
      tile(String(result.count_ins.length), "Einzähler"),
      tile(formatBytes(totalBytes), "Größe"),
    ),
    h(
      "section",
      { class: "card" },
      h(
        "dl",
        { class: "facts" },
        h("dt", {}, "Song"),
        h("dd", {}, result.song_name),
        h("dt", {}, "Kategorie"),
        h("dd", {}, category?.name ?? "–"),
        h("dt", {}, "Playbacks"),
        h(
          "dd",
          {},
          result.playbacks.length === 0 ? "–" : null,
          result.playbacks.length > 0
            ? h(
                "ul",
                { class: "plain" },
                result.playbacks.map((playback) => {
                  const settings = state.settings.get(playback.path);
                  const names = [...settings.ids]
                    .map((id) => state.reference.instruments.find((instrument) => instrument.id === id))
                    .filter(Boolean)
                    .map(instrumentLabel)
                    .join(", ");
                  const audience =
                    settings.mode === "all" ? "für alle" : settings.mode === "only" ? `nur für ${names || "…"}` : `für alle außer ${names || "…"}`;
                  return h("li", {}, h("strong", {}, playback.type), h("span", { class: "muted" }, ` · ${audience}`));
                }),
              )
            : null,
        ),
        renamed > 0 ? [h("dt", {}, "Korrekturen"), h("dd", {}, plural(renamed, "Dateiname", "Dateinamen"))] : null,
        state.excluded.size > 0
          ? [
              h("dt", {}, "Ausgelassen"),
              h(
                "dd",
                {},
                h(
                  "details",
                  {},
                  h("summary", {}, plural(state.excluded.size, "Datei oder Ordner", "Dateien oder Ordner")),
                  h(
                    "ul",
                    { class: "plain small" },
                    [...state.excluded].sort().map((path) =>
                      h(
                        "li",
                        {},
                        h("span", { class: "path" }, path),
                        " ",
                        h("button", { class: "link", type: "button", onclick: () => includePath(path) }, "wieder aufnehmen"),
                      ),
                    ),
                  ),
                ),
              ),
            ]
          : null,
      ),
    ),
    upload?.status === "demo" ? null : releaseSection(running),
    upload?.status === "demo"
      ? h(
          "section",
          { class: "card outcome" },
          h("h2", {}, "Testmodus"),
          h("p", { class: "muted" }, `${upload.paths.length} Dateien würden hochgeladen:`),
          h("pre", { class: "manifest" }, JSON.stringify(upload.manifest, null, 2)),
          h("button", { class: "button", type: "button", onclick: () => { state.upload = null; render(); } }, "Schließen"),
        )
      : uploadCard(),
    pageNavigation({ back: !running }),
  ];
}

function render() {
  const renderers = [renderFolderStep, renderCategoryStep, renderSheetMusicStep, renderPlaybacksStep, renderOverviewStep];
  if (!stepAvailable(state.step)) state.step = stepAvailable(1) ? 1 : 0;
  const busy = state.checking && state.step >= 2;
  const content = busy
    ? [h("section", { class: "card busy" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("p", { class: "hint", role: "status" }, "Prüfe Dateien …"))]
    : renderers[state.step]();
  root.replaceChildren(header(true), h("main", { class: "shell" }, content));
  layoutTimelines();
  updatePlayer();
  saveDraft();
}

async function start() {
  try {
    state.reference = await loadReference();
    signedIn = true;
    if (state.result && state.upload == null) {
      await runCheck();
    } else {
      render();
    }
  } catch (error) {
    if (error instanceof SessionExpired) return;
    root.replaceChildren(
      header(),
      h(
        "main",
        { class: "shell narrow" },
        h(
          "section",
          { class: "card" },
          h("h1", {}, "Server nicht erreichbar"),
          h("p", { class: "muted" }, "Kategorien und Instrumente nicht geladen."),
          h("button", { class: "button primary", type: "button", onclick: start }, "Erneut versuchen"),
        ),
      ),
    );
  }
}

window.addEventListener("resize", layoutTimelines);
document.fonts?.ready.then(layoutTimelines);
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  await checkSession();
  refreshReference();
});
setInterval(() => {
  if (document.visibilityState === "visible") checkSession();
}, sessionCheckIntervalMs);

start();
