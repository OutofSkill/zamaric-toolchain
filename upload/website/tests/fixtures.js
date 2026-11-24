import { checkSong } from "../static/check.js";

export const songName = "Alba";
export const defaultDurationMs = 120000;

const instrumentRows = [
  ["Altsaxophon", "Es"],
  ["Tenorsaxophon", "B"],
  ["Baritonsaxophon", "Es"],
  ["Bassklarinette", "B"],
  ["Kontraklarinette", "Es"],
  ["Trompete", "B"],
  ["Trompete", "C"],
  ["Tuba", "C"],
  ["DrumSet", ""],
  ["Handpauke", "C"],
  ["Kesselpauke", "C"],
];

const instruments = instrumentRows.map(([name, transposition], index) => ({ id: index + 1, name, transposition }));

export const reference = {
  categories: [
    { id: 1, name: "Grande Fanfare" },
    { id: 2, name: "Posaunenchor" },
  ],
  levels: [
    { id: 1, name: "Normal" },
    { id: 2, name: "Anfänger" },
    { id: 3, name: "Leicht" },
  ],
  instruments,
  parts: [
    ...instruments.map(({ id, name, transposition }) => ({ id: id + 100, name, transposition })),
    { id: 120, name: "Akkordblatt", transposition: "C" },
  ],
  instrument_parts: instruments.map(({ id }) => ({ part_id: id + 100, instrument_id: id })),
  songs: [{ id: 1, category_id: 1, name: "Tequila" }],
};

export const inspect = {
  pdf: async (entry) => entry.file.pdf,
  audio: async (entry) => entry.file.duration,
  text: async (entry) => entry.file.text,
};

export const pdf = (path, { valid = true, size = 2048 } = {}) => ({ path, size, file: { pdf: valid } });
export const mp3 = (path, duration = defaultDurationMs, size = 4096) => ({ path, size, file: { duration } });
export const txt = (path, lines) => ({ path, size: 256, file: { text: lines === null ? null : lines.join("\n") } });
export const otherFile = (path, size = 128) => ({ path, size, file: {} });

const twoDigits = (value) => String(value).padStart(2, "0");
export const timestampLine = (letter, totalSeconds, countIn) =>
  `${letter} ${twoDigits(Math.floor(totalSeconds / 60))}:${twoDigits(totalSeconds % 60)}:00 ${countIn}`;
export const timestampLines = (letters, countIn = "4-4") =>
  letters.map(([letter, totalSeconds]) => timestampLine(letter, totalSeconds, countIn));

const playbackStem = (type) => (type === "Normal" ? songName : `${songName} - ${type}`);
export const playbackPath = (type) => `Playbacks/${playbackStem(type)}.mp3`;
export const timestampPath = (type) => `Playbacks/Timestamps/${playbackStem(type)}.txt`;
export const countInPath = (name) => `Playbacks/Einzaehler/${songName} ${name}.mp3`;

export const playbackWithTimestamps = (type, lines, duration = defaultDurationMs) => [
  mp3(playbackPath(type), duration),
  txt(timestampPath(type), lines),
];
export const countIn = (name, duration = 1500) => mp3(countInPath(name), duration);

export const runCheck = (files, options = {}) =>
  checkSong({
    songName,
    categoryId: 1,
    files,
    directories: null,
    renames: {},
    reference,
    inspect,
    ...options,
  });

export const message = (severity, code, path, text, { line = null, suggestion = null, suggestionLabel = null, related = null } = {}) => ({
  severity,
  code,
  path,
  line,
  text,
  suggestion,
  suggestion_label: suggestionLabel,
  related,
});

export const messagesWithCode = (result, code) => result.messages.filter((entry) => entry.code === code);
