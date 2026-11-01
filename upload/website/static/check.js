const maximumFileBytes = 50 * 1024 * 1024;
const suggestionCutoff = 0.6;
const levelSuggestionCutoff = 0.75;
const typeInstrumentCutoff = 0.8;
const timingToleranceMs = 3000;
const maximumListedLetterChanges = 2;
const defaultLevelName = "normal";
const defaultType = "Normal";
const jumpMarks = new Set(["D.S.", "D.C."]);
const variantModifierPattern = /^(ohne Drums|lauter)?(_?langsamer)?$/i;
const withoutDrumsPattern = /ohne drums/i;
const drumInstrumentPrefix = "drum";
const minimumFamilySuffixLength = 5;
const preferredFamilyPrefix = "alt";
const invisibleCharacters = /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

export function hasInvisible(text) {
  invisibleCharacters.lastIndex = 0;
  return invisibleCharacters.test(text);
}

export const warningOrder = [
  "letters_differ_between_variants",
  "letter_time_differs_between_variants",
  "missing_timestamps",
  "part_without_viewers",
  "missing_separator",
  "unknown_type_instrument",
  "first_letter_not_at_start",
];

export const groupableWarnings = new Set([
  "missing_separator",
  "unknown_type_instrument",
  "first_letter_not_at_start",
]);

function fold(text) {
  return text.toLowerCase();
}

function formatMinutes(milliseconds) {
  const totalSeconds = Math.round(Math.max(milliseconds, 0) / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function letterChanges(reference, other) {
  const lengths = Array.from({ length: reference.length + 1 }, () => new Array(other.length + 1).fill(0));
  for (let row = reference.length - 1; row >= 0; row--) {
    for (let column = other.length - 1; column >= 0; column--) {
      lengths[row][column] =
        reference[row] === other[column]
          ? lengths[row + 1][column + 1] + 1
          : Math.max(lengths[row + 1][column], lengths[row][column + 1]);
    }
  }
  const missing = [];
  const extra = [];
  let row = 0;
  let column = 0;
  while (row < reference.length || column < other.length) {
    if (row < reference.length && column < other.length && reference[row] === other[column]) {
      row++;
      column++;
    } else if (column >= other.length || (row < reference.length && lengths[row + 1][column] >= lengths[row][column + 1])) {
      missing.push(reference[row++]);
    } else {
      extra.push(other[column++]);
    }
  }
  return { missing, extra };
}

function timingOutliers(referenceLetters, letters) {
  const xs = referenceLetters.map((letter) => letter.position_ms);
  const ys = letters.map((letter) => letter.position_ms);
  const ratios = [];
  for (let index = 0; index + 1 < xs.length; index++) {
    if (xs[index + 1] > xs[index]) ratios.push((ys[index + 1] - ys[index]) / (xs[index + 1] - xs[index]));
  }
  if (ratios.length < 2) return [];
  ratios.sort((left, right) => left - right);
  const middle = Math.floor(ratios.length / 2);
  const tempoRatio = ratios.length % 2 === 1 ? ratios[middle] : (ratios[middle - 1] + ratios[middle]) / 2;
  const outliers = [];
  for (let index = 1; index + 1 < xs.length; index++) {
    const referenceSpan = xs[index + 1] - xs[index - 1];
    if (referenceSpan <= 0) continue;
    const span = ys[index + 1] - ys[index - 1];
    if (Math.abs(span - tempoRatio * referenceSpan) >= timingToleranceMs) continue;
    const expected = ys[index - 1] + (span * (xs[index] - xs[index - 1])) / referenceSpan;
    if (Math.abs(ys[index] - expected) > timingToleranceMs) outliers.push({ index, expected });
  }
  return outliers;
}

function isValidLetter(name) {
  return /^[A-Z]$/.test(name) || /^\d+$/.test(name) || jumpMarks.has(name) || name === "Coda";
}

export function isIgnoredName(name) {
  return name === ".DS_Store" || name.startsWith("._");
}

export function instrumentLabel(instrument) {
  return instrument.transposition
    ? `${instrument.name} in ${instrument.transposition}`
    : instrument.name;
}

export function formatPosition(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const rest = milliseconds % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(rest).padStart(3, "0")}`;
}

function levenshtein(first, second) {
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let row = 1; row <= first.length; row++) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= second.length; column++) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (first[row - 1] === second[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[second.length];
}

function similarity(first, second) {
  const a = first.toLowerCase();
  const b = second.toLowerCase();
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

function commonSuffix(first, second) {
  let length = 0;
  while (length < first.length && length < second.length && first.at(-1 - length) === second.at(-1 - length)) length++;
  return first.slice(first.length - length);
}

function instrumentFamilies(names) {
  const nameKeys = new Set(names.map(fold));
  const suffixes = new Set();
  for (const first of names) {
    for (const second of names) {
      if (fold(first) === fold(second)) continue;
      const suffix = commonSuffix(fold(first), fold(second));
      if (suffix.length >= minimumFamilySuffixLength && !nameKeys.has(suffix)) suffixes.add(suffix);
    }
  }
  return [...suffixes].map((suffix) => {
    const members = names.filter((name) => fold(name).endsWith(suffix)).sort((left, right) => left.localeCompare(right, "de"));
    const spelled = members[0].slice(members[0].length - suffix.length);
    return {
      name: spelled.charAt(0).toUpperCase() + spelled.slice(1),
      members,
      preferred: members.find((name) => fold(name) === preferredFamilyPrefix + suffix) ?? null,
    };
  });
}

function bestMatch(value, candidates, cutoff) {
  const scored = [...new Set(candidates)]
    .map((candidate) => ({ candidate, score: similarity(value, candidate) }))
    .filter((entry) => entry.score >= cutoff)
    .sort((left, right) => right.score - left.score);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;
  return scored[0].candidate;
}

function splitPath(path) {
  const parts = path.split("/");
  const name = parts.pop();
  const dot = name.lastIndexOf(".");
  return {
    directory: parts,
    stem: dot > 0 ? name.slice(0, dot) : name,
    extension: dot > 0 ? name.slice(dot) : "",
  };
}

function joinPath(directory, stem, extension) {
  return [...directory, stem + extension].join("/");
}

function hasExtension(path, extension) {
  return splitPath(path).extension.toLowerCase() === extension;
}

function resolvePart(text, parts) {
  const withTransposition = /^(.+) in (\S+)$/.exec(text);
  if (withTransposition) {
    const found = parts.filter(
      (part) =>
        fold(part.name) === fold(withTransposition[1]) &&
        fold(part.transposition) === fold(withTransposition[2]),
    );
    if (found.length === 1) return { part: found[0] };
  }
  const byName = parts.filter((part) => fold(part.name) === fold(text));
  if (byName.length === 1) return { part: byName[0] };
  if (byName.length > 1) return { ambiguous: true };
  return { unknown: true };
}

function partCandidates(parts) {
  const candidates = [];
  for (const part of parts) {
    candidates.push(instrumentLabel(part));
    const sameName = parts.filter((other) => fold(other.name) === fold(part.name));
    if (sameName.length === 1) candidates.push(part.name);
  }
  return candidates;
}

function parseTimestamps(text) {
  const letters = [];
  const problems = [];
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  lines.forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "") return;
    if (hasInvisible(raw)) {
      problems.push({ code: "invisible_character_text", line, text: "Unsichtbares Zeichen in der Zeile" });
      return;
    }
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 3) {
      problems.push({
        code: "invalid_timestamp_line",
        line,
        text: "Zeile unvollständig (Buchstabe, Zeit, Einzähler)",
      });
      return;
    }
    const time = /^(\d{2}):(\d{2}):(\d{2})$/.exec(parts[1]);
    if (!time) {
      problems.push({
        code: "invalid_timestamp_line",
        line,
        text: `„${parts[1]}“ ist keine Zeit (MM:SS:FF)`,
      });
      return;
    }
    const minutes = Number(time[1]);
    const seconds = Number(time[2]);
    const frames = Number(time[3]);
    if (seconds > 59 || frames > 29) {
      problems.push({
        code: "invalid_frames",
        line,
        text: `„${parts[1]}“ ungültig (max. 59 s, 29 Frames)`,
      });
      return;
    }
    letters.push({
      name: parts[0],
      position_ms: (minutes * 60 + seconds) * 1000 + Math.round((frames / 30) * 1000),
      count_in: parts.slice(2).join(" "),
      line,
    });
  });
  return { letters, problems };
}

export async function checkSong({
  songName,
  categoryId,
  files,
  directories,
  renames,
  reference,
  inspect,
  updating = false,
}) {
  const messages = [];
  const add = (severity, code, path, text, extra = {}) => {
    messages.push({
      severity,
      code,
      path,
      line: extra.line ?? null,
      text,
      suggestion: extra.suggestion ?? null,
      suggestion_label: extra.suggestionLabel ?? null,
      related: extra.related ?? null,
    });
  };
  const error = (code, path, text, extra) => add("error", code, path, text, extra);
  const warning = (code, path, text, extra) => add("warning", code, path, text, extra);

  if (!reference.categories.some((category) => category.id === categoryId)) {
    error("unknown_category", null, "Kategorie gibt es nicht");
  }
  if (
    !updating &&
    reference.songs.some(
      (song) => song.category_id === categoryId && fold(song.name.normalize("NFC")) === fold(songName),
    )
  ) {
    error("song_exists", null, "Song gibt es in dieser Kategorie schon");
  }
  if (hasInvisible(songName)) {
    error("invisible_character", null, "Unsichtbares Zeichen im Namen des Song-Ordners");
  }

  const entries = files
    .filter((entry) => !isIgnoredName(entry.path.split("/").pop()))
    .map((entry) => ({
      ...entry,
      original: entry.path,
      path: Object.hasOwn(renames, entry.path) ? renames[entry.path] : entry.path,
    }));

  const sheetEntries = [];
  const playbackEntries = [];
  const timestampEntries = [];
  const countInEntries = [];
  const reportedFolders = new Set();
  const reportFolder = (code, folder, text) => {
    if (reportedFolders.has(folder)) return;
    reportedFolders.add(folder);
    error(code, folder, text);
  };

  for (const entry of entries) {
    const parts = entry.path.split("/");
    if (entry.size > maximumFileBytes) {
      error("file_too_large", entry.original, "Größer als 50 MB");
    }
    if (parts.length === 1) {
      error("unexpected_entry", entry.original, "Gehört in „Noten“ oder „Playbacks“");
      continue;
    }
    const top = parts[0];
    if (top !== "Noten" && top !== "Playbacks") {
      reportFolder("unexpected_entry", top, "Nur „Noten“ und „Playbacks“ erlaubt");
      continue;
    }
    if (top === "Noten") {
      if (parts.length !== 2) {
        reportFolder("unexpected_folder", parts.slice(0, -1).join("/"), "Unterordner nicht erlaubt");
      } else if (!hasExtension(entry.path, ".pdf")) {
        error("wrong_file_type", entry.original, "Nur PDF erlaubt");
      } else {
        sheetEntries.push(entry);
      }
      continue;
    }
    if (parts.length === 2) {
      if (!hasExtension(entry.path, ".mp3")) {
        error("wrong_file_type", entry.original, "Nur MP3 erlaubt");
      } else {
        playbackEntries.push(entry);
      }
      continue;
    }
    if (parts.length === 3 && parts[1] === "Timestamps") {
      if (!hasExtension(entry.path, ".txt")) {
        error("wrong_file_type", entry.original, "Nur TXT erlaubt");
      } else {
        timestampEntries.push(entry);
      }
      continue;
    }
    if (parts.length === 3 && parts[1] === "Einzaehler") {
      if (!hasExtension(entry.path, ".mp3")) {
        error("wrong_file_type", entry.original, "Nur MP3 erlaubt");
      } else {
        countInEntries.push(entry);
      }
      continue;
    }
    reportFolder(
      "unexpected_folder",
      parts.slice(0, -1).join("/"),
      "Nur „Timestamps“ und „Einzaehler“ erlaubt",
    );
  }

  const hasTop = (top) => entries.some((entry) => entry.path.split("/")[0] === top);
  if (!hasTop("Noten") && !hasTop("Playbacks")) {
    error("no_content", null, "Keine Noten und keine Playbacks");
  }
  for (const folder of ["Noten", "Playbacks", "Playbacks/Timestamps", "Playbacks/Einzaehler"]) {
    if (!directories?.has(folder)) continue;
    const prefix = `${folder}/`;
    if (!entries.some((entry) => entry.path.startsWith(prefix))) {
      error("empty_folder", folder, "Ordner ist leer");
    }
  }

  const cleanStem = (entry) => {
    const { directory, stem, extension } = splitPath(entry.path);
    const visible = stem.replace(invisibleCharacters, "");
    const cleaned = visible.replace(/\s+/g, " ").trim();
    if (visible !== stem) {
      error("invisible_character", entry.original, "Unsichtbares Zeichen im Namen", {
        suggestion: joinPath(directory, cleaned, extension),
        suggestionLabel: "Zeichen entfernen",
      });
    } else if (cleaned !== stem) {
      error("whitespace_issue", entry.original, "Überflüssige Leerzeichen", {
        suggestion: joinPath(directory, cleaned, extension),
        suggestionLabel: "Leerzeichen entfernen",
      });
    }
    return { directory, stem: cleaned, extension };
  };

  const splitSongPrefix = (entry, name, separator, allowWithoutRest) => {
    const { directory, stem, extension } = name;
    if (stem === songName) return allowWithoutRest ? { rest: null } : null;
    if (stem.startsWith(songName + " ")) {
      const rest = stem.slice(songName.length + 1);
      if (separator === " ") return { rest };
      if (rest.startsWith("- ")) return { rest: rest.slice(2) || null };
      warning("missing_separator", entry.original, `„ - “ fehlt → Zusatz „${rest}“`);
      return { rest };
    }
    const index = separator === " " ? stem.lastIndexOf(" ") : stem.indexOf(separator);
    if (index < 0) {
      if (!allowWithoutRest) return null;
      error("prefix_mismatch", entry.original, `Beginnt nicht mit „${songName}“`, {
        suggestion: joinPath(directory, songName, extension),
        suggestionLabel: songName,
      });
      return { rest: null };
    }
    const rest = stem.slice(index + separator.length);
    error("prefix_mismatch", entry.original, `„${stem.slice(0, index)}“ statt „${songName}“`, {
      suggestion: joinPath(directory, songName + separator + rest, extension),
      suggestionLabel: songName,
    });
    return { rest };
  };

  const levelsByName = new Map(
    reference.levels.map((level) => [level.name.normalize("NFC").toLowerCase(), level]),
  );
  const defaultLevel = levelsByName.get(defaultLevelName);
  const otherLevelNames = reference.levels
    .filter((level) => level !== defaultLevel)
    .map((level) => level.name.normalize("NFC"));
  const normalizeEntry = (entry) => ({
    ...entry,
    name: entry.name.normalize("NFC"),
    transposition: (entry.transposition ?? "").normalize("NFC"),
  });
  const instruments = reference.instruments.map(normalizeEntry);
  const parts = reference.parts.map(normalizeEntry);
  const candidates = partCandidates(parts);
  const viewedPartIds = new Set((reference.instrument_parts ?? []).map((entry) => entry.part_id));

  if (sheetEntries.length > 0 && !defaultLevel) {
    error("missing_default_level", null, "Level „Normal“ fehlt in der Datenbank");
  }

  const pdfChecks = await Promise.all(sheetEntries.map((entry) => inspect.pdf(entry)));
  const sheetMusic = [];
  const sheetKeys = new Map();
  sheetEntries.forEach((entry, index) => {
    if (!pdfChecks[index]) {
      error("invalid_file_content", entry.original, "Kein gültiges PDF");
      return;
    }
    const name = cleanStem(entry);
    const split = splitSongPrefix(entry, name, " - ", false);
    if (!split || !split.rest) {
      error("invalid_name_pattern", entry.original, "Stimme fehlt im Namen");
      return;
    }
    const words = split.rest.split(" ");
    let level = defaultLevel;
    let levelWord = null;
    let partText = split.rest;
    const trailingLevel = levelsByName.get(words.at(-1).toLowerCase());
    if (words.length > 1 && trailingLevel) {
      level = trailingLevel;
      levelWord = words.at(-1);
      partText = words.slice(0, -1).join(" ");
    }
    if (!level) return;

    const resolved = resolvePart(partText, parts);
    const pathWith = (rest) => joinPath(name.directory, `${songName} - ${rest}`, name.extension);
    if (resolved.ambiguous) {
      const transpositions = parts
        .filter((part) => fold(part.name) === fold(partText))
        .map((part) => part.transposition)
        .join(" oder ");
      error("ambiguous_part", entry.original, `Stimmung fehlt: ${transpositions}`);
      return;
    }
    if (resolved.unknown) {
      if (!levelWord && words.length > 1) {
        const withoutLast = words.slice(0, -1).join(" ");
        if (!resolvePart(withoutLast, parts).unknown) {
          const similarLevel = bestMatch(words.at(-1), otherLevelNames, levelSuggestionCutoff);
          error("unknown_level", entry.original, `„${words.at(-1)}“ ist kein Level`, {
            suggestion: similarLevel ? pathWith(`${withoutLast} ${similarLevel}`) : null,
            suggestionLabel: similarLevel,
          });
          return;
        }
      }
      const similarPart = bestMatch(partText, candidates, suggestionCutoff);
      error("unknown_part", entry.original, `Stimme „${partText}“ unbekannt`, {
        suggestion: similarPart ? pathWith(levelWord ? `${similarPart} ${levelWord}` : similarPart) : null,
        suggestionLabel: similarPart,
      });
      return;
    }
    const key = `${resolved.part.id}:${level.id}`;
    if (sheetKeys.has(key)) {
      const other = sheetKeys.get(key);
      error("duplicate_sheet_music", entry.original, `Doppelt mit „${other.split("/").pop()}“`, { related: other });
      return;
    }
    sheetKeys.set(key, entry.original);
    if (!viewedPartIds.has(resolved.part.id)) {
      warning("part_without_viewers", entry.original, "Sieht in der App niemand");
    }
    sheetMusic.push({
      path: entry.original,
      part_id: resolved.part.id,
      part_label: instrumentLabel(resolved.part),
      level_id: level.id,
      level_name: level.name,
    });
  });

  const [countInDurations, playbackDurations, timestampTexts] = await Promise.all([
    Promise.all(countInEntries.map((entry) => inspect.audio(entry))),
    Promise.all(playbackEntries.map((entry) => inspect.audio(entry))),
    Promise.all(timestampEntries.map((entry) => inspect.text(entry))),
  ]);

  const countIns = new Map();
  countInEntries.forEach((entry, index) => {
    const name = cleanStem(entry);
    const split = splitSongPrefix(entry, name, " ", false);
    if (!split || !split.rest) {
      error("invalid_name_pattern", entry.original, "Einzähler-Name fehlt");
      return;
    }
    if (countIns.has(fold(split.rest))) {
      const other = countIns.get(fold(split.rest)).path;
      error("invalid_name_pattern", entry.original, `Gleicher Name wie „${other.split("/").pop()}“`, { related: other });
      return;
    }
    const duration = countInDurations[index];
    if (duration == null) {
      error("invalid_file_content", entry.original, "MP3 nicht lesbar");
      return;
    }
    countIns.set(fold(split.rest), { path: entry.original, name: split.rest, duration_ms: duration });
  });

  const playbacksByType = new Map();
  playbackEntries.forEach((entry, index) => {
    const name = cleanStem(entry);
    const split = splitSongPrefix(entry, name, " - ", true);
    if (!split || split.rest === "") {
      error("invalid_name_pattern", entry.original, "Zusatz nach „ - “ fehlt");
      return;
    }
    const type = split.rest ?? defaultType;
    const key = fold(type);
    if (playbacksByType.has(key)) {
      const other = playbacksByType.get(key).entry.original;
      error("invalid_name_pattern", entry.original, `Gleicher Zusatz wie „${other.split("/").pop()}“`, { related: other });
      return;
    }
    playbacksByType.set(key, { entry, type, duration: playbackDurations[index] });
  });

  const timestampsByType = new Map();
  timestampEntries.forEach((entry, index) => {
    const name = cleanStem(entry);
    const split = splitSongPrefix(entry, name, " - ", true);
    if (!split || split.rest === "") {
      error("invalid_name_pattern", entry.original, "Zusatz nach „ - “ fehlt");
      return;
    }
    const type = split.rest ?? defaultType;
    const key = fold(type);
    if (timestampsByType.has(key)) {
      const other = timestampsByType.get(key).entry.original;
      error("invalid_name_pattern", entry.original, `Gleicher Zusatz wie „${other.split("/").pop()}“`, { related: other });
      return;
    }
    timestampsByType.set(key, { entry, type, text: timestampTexts[index] });
  });

  const instrumentNames = [...new Set(instruments.map((instrument) => instrument.name))];
  const instrumentNameKeys = new Set(instrumentNames.map(fold));
  const isModifier = (text) => text !== "" && variantModifierPattern.test(text);
  const variantGroup = (type) => {
    if (fold(type) === fold(defaultType) || isModifier(type)) return fold(defaultType);
    const index = type.lastIndexOf(" - ");
    if (index < 0) return fold(type);
    const head = type.slice(0, index);
    if (!isModifier(type.slice(index + 3))) return fold(type);
    return instrumentNameKeys.has(fold(head)) ? fold(defaultType) : variantGroup(head);
  };
  const typeInstrumentIds = (type) => {
    const segmentKeys = new Set(type.split(" - ").map(fold));
    const withoutDrums = withoutDrumsPattern.test(type);
    return instruments
      .filter(
        (instrument) =>
          segmentKeys.has(fold(instrument.name)) || (withoutDrums && fold(instrument.name).startsWith(drumInstrumentPrefix)),
      )
      .map((instrument) => instrument.id);
  };
  const families = instrumentFamilies(instrumentNames);
  const familyFor = (segment) => {
    const exact = families.find((family) => fold(family.name) === fold(segment));
    if (exact) return exact;
    const similar = bestMatch(
      segment,
      families.map((family) => family.name),
      typeInstrumentCutoff,
    );
    return families.find((family) => family.name === similar) ?? null;
  };
  const checkTypeInstrument = (entry, type) => {
    if (fold(type) === fold(defaultType)) return;
    const segments = type.split(" - ");
    const { directory, extension } = splitPath(entry.path);
    const renamedTo = (index, replacement) =>
      joinPath(
        directory,
        `${songName} - ${segments.map((other, otherIndex) => (otherIndex === index ? replacement : other)).join(" - ")}`,
        extension,
      );
    segments.forEach((segment, index) => {
      if (isModifier(segment) || instrumentNameKeys.has(fold(segment))) return;
      const similar = bestMatch(segment, instrumentNames, typeInstrumentCutoff);
      if (similar) {
        warning("unknown_type_instrument", entry.original, `Tippfehler im Zusatz: „${segment}“`, {
          suggestion: renamedTo(index, similar),
          suggestionLabel: similar,
        });
        return;
      }
      const family = familyFor(segment);
      if (!family) return;
      error(
        "ambiguous_type_instrument",
        entry.original,
        `„${segment}“ ist kein genaues Instrument, gemeint ist eines von: ${family.members.join(", ")}`,
        family.preferred ? { suggestion: renamedTo(index, family.preferred), suggestionLabel: family.preferred } : {},
      );
    });
  };
  for (const playback of playbacksByType.values()) checkTypeInstrument(playback.entry, playback.type);
  for (const timestamp of timestampsByType.values()) checkTypeInstrument(timestamp.entry, timestamp.type);

  const playbackTypesWithoutTimestamps = [...playbacksByType]
    .filter(([key]) => !timestampsByType.has(key))
    .map(([, playback]) => playback.type);
  for (const [key, timestamp] of timestampsByType) {
    if (playbacksByType.has(key)) continue;
    const similar = bestMatch(timestamp.type, playbackTypesWithoutTimestamps, suggestionCutoff);
    const { directory, extension } = splitPath(timestamp.entry.path);
    error("orphan_timestamps", timestamp.entry.original, "TXT ohne passende MP3", {
      suggestion:
        similar == null
          ? null
          : joinPath(directory, fold(similar) === fold(defaultType) ? songName : `${songName} - ${similar}`, extension),
      suggestionLabel: similar,
    });
  }

  const usedCountIns = new Set();
  const playbacks = [];
  const letterSequences = [];
  for (const [key, playback] of playbacksByType) {
    const { entry } = playback;
    let usable = true;
    if (playback.duration == null) {
      error("invalid_file_content", entry.original, "MP3 nicht lesbar");
      usable = false;
    }
    const timestamp = timestampsByType.get(key);
    if (!timestamp) {
      warning("missing_timestamps", entry.original, "Keine TXT, also ohne Buchstaben");
      if (usable) {
        playbacks.push({
          path: entry.original,
          type: playback.type,
          duration_ms: playback.duration,
          suggested_instrument_ids: typeInstrumentIds(playback.type),
          letters: [],
        });
      }
      continue;
    }
    const txtPath = timestamp.entry.original;
    if (timestamp.text == null) {
      error("invalid_encoding", txtPath, "TXT nicht als UTF-8 gespeichert");
      continue;
    }
    const { letters, problems } = parseTimestamps(timestamp.text);
    for (const problem of problems) {
      error(problem.code, txtPath, problem.text, { line: problem.line });
    }
    if (problems.length > 0) usable = false;
    if (letters.length === 0 && problems.length === 0) {
      error("empty_timestamps", txtPath, "TXT ist leer");
      continue;
    }
    let seenLetters = new Set();
    letters.forEach((letter, index) => {
      usedCountIns.add(fold(letter.count_in));
      if (!isValidLetter(letter.name)) {
        error("invalid_letter", txtPath, `„${letter.name}“ ist kein gültiger Buchstabe`, { line: letter.line });
        usable = false;
      }
      if (jumpMarks.has(letter.name)) seenLetters = new Set();
      if (seenLetters.has(letter.name)) {
        error("duplicate_letter", txtPath, `„${letter.name}“ doppelt`, { line: letter.line });
        usable = false;
      }
      seenLetters.add(letter.name);
      if (index > 0 && letter.position_ms === letters[index - 1].position_ms) {
        error("duplicate_position", txtPath, `„${letter.name}“ an gleicher Stelle wie „${letters[index - 1].name}“`, { line: letter.line });
        usable = false;
      } else if (index > 0 && letter.position_ms < letters[index - 1].position_ms) {
        error("letters_not_ascending", txtPath, `„${letter.name}“ liegt zeitlich vor „${letters[index - 1].name}“`, { line: letter.line });
        usable = false;
      }
      if (playback.duration != null && letter.position_ms > playback.duration) {
        error("letter_after_end", txtPath, `„${letter.name}“ nach MP3-Ende (${formatMinutes(playback.duration)})`, { line: letter.line });
        usable = false;
      }
      if (countIns.has(fold(letter.count_in))) {
        letter.count_in = countIns.get(fold(letter.count_in)).name;
      } else {
        const longer = [...countIns.values()].map((countIn) => countIn.name).find((name) => fold(name).endsWith(` ${fold(letter.count_in)}`));
        const hint = longer ? ` – Songname zu kurz? Es gibt „${longer}“` : "";
        error("unknown_count_in", txtPath, `Einzähler „${letter.count_in}“ fehlt${hint}`, { line: letter.line });
        usable = false;
      }
    });
    letterSequences.push({
      type: playback.type,
      group: variantGroup(playback.type),
      path: txtPath,
      letters,
      names: letters.map((letter) => letter.name),
    });
    if (letters.length > 0 && letters[0].position_ms !== 0) {
      warning("first_letter_not_at_start", txtPath, `„${letters[0].name}“ beginnt nicht bei 0:00`, { line: letters[0].line });
    }
    if (!usable) continue;
    playbacks.push({
      path: entry.original,
      type: playback.type,
      duration_ms: playback.duration,
      suggested_instrument_ids: typeInstrumentIds(playback.type),
      letters: letters.map(({ name, position_ms, count_in }) => ({ name, position_ms, count_in })),
    });
  }

  const sequencesByGroup = new Map();
  for (const sequence of letterSequences) {
    if (!sequencesByGroup.has(sequence.group)) sequencesByGroup.set(sequence.group, []);
    sequencesByGroup.get(sequence.group).push(sequence);
  }
  for (const [group, sequences] of sequencesByGroup) {
    if (sequences.length < 2) continue;
    const referenceSequence = sequences.find((sequence) => fold(sequence.type) === group) ?? sequences[0];
    const referenceType = referenceSequence.type;
    for (const sequence of sequences) {
      if (sequence === referenceSequence) continue;
      if (sequence.names.join(" ") === referenceSequence.names.join(" ")) {
        for (const outlier of timingOutliers(referenceSequence.letters, sequence.letters)) {
          const letter = sequence.letters[outlier.index];
          warning(
            "letter_time_differs_between_variants",
            sequence.path,
            `„${letter.name}“ bei ${formatMinutes(letter.position_ms)}, erwartet ~${formatMinutes(outlier.expected)}`,
            { line: letter.line },
          );
        }
        continue;
      }
      const { missing, extra } = letterChanges(referenceSequence.names, sequence.names);
      const changes = [];
      if (missing.length > 0) changes.push(`Fehlt ${missing.map((name) => `„${name}“`).join(", ")}`);
      if (extra.length > 0) changes.push(`${missing.length > 0 ? "zusätzlich" : "Zusätzlich"} ${extra.map((name) => `„${name}“`).join(", ")}`);
      warning(
        "letters_differ_between_variants",
        sequence.path,
        missing.length + extra.length <= maximumListedLetterChanges
          ? `${changes.join(", ")} (vgl. „${referenceType}“)`
          : `Andere Buchstaben als ${referenceType}:\nHier: ${sequence.names.join(" ")}\n${referenceType}: ${referenceSequence.names.join(" ")}`,
      );
    }
  }

  for (const countIn of countIns.values()) {
    if (!usedCountIns.has(fold(countIn.name))) {
      error("unused_count_in", countIn.path, "Von keiner TXT benutzt");
    }
  }

  return {
    song_name: songName,
    can_upload: !messages.some((message) => message.severity === "error"),
    messages,
    sheet_music: sheetMusic,
    playbacks,
    count_ins: [...countIns.values()],
    timestamp_pairs: [...playbacksByType]
      .filter(([key]) => timestampsByType.has(key))
      .map(([key, playback]) => ({ audio_path: playback.entry.original, timestamps_path: timestampsByType.get(key).entry.original })),
  };
}
