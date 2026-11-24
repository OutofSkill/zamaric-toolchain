import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  formatPosition,
  groupableWarnings,
  hasInvisible,
  instrumentLabel,
  isIgnoredName,
  warningOrder,
} from "../static/check.js";
import {
  countIn,
  countInPath,
  message,
  messagesWithCode,
  mp3,
  otherFile,
  pdf,
  playbackPath,
  playbackWithTimestamps,
  runCheck,
  timestampLine,
  timestampLines,
  timestampPath,
  txt,
} from "./fixtures.js";

describe("Exportierte Hilfsfunktionen", () => {
  test("hasInvisible erkennt Format- und Steuerzeichen, auch bei wiederholtem Aufruf", () => {
    assert.equal(hasInvisible("Alba"), false);
    assert.equal(hasInvisible("A\tB"), false);
    assert.equal(hasInvisible("Al​ba"), true);
    assert.equal(hasInvisible("Al​ba"), true);
    assert.equal(hasInvisible("Alba\u0007"), true);
    assert.equal(hasInvisible("‮Alba"), true);
  });

  test("isIgnoredName ignoriert .DS_Store und ._-Dateien", () => {
    assert.equal(isIgnoredName(".DS_Store"), true);
    assert.equal(isIgnoredName("._Alba.mp3"), true);
    assert.equal(isIgnoredName("Alba.mp3"), false);
    assert.equal(isIgnoredName("_Alba.mp3"), false);
  });

  test("instrumentLabel hängt die Stimmung an, falls vorhanden", () => {
    assert.equal(instrumentLabel({ name: "Trompete", transposition: "B" }), "Trompete in B");
    assert.equal(instrumentLabel({ name: "DrumSet", transposition: "" }), "DrumSet");
    assert.equal(instrumentLabel({ name: "DrumSet", transposition: null }), "DrumSet");
  });

  test("formatPosition formatiert als MM:SS.mmm", () => {
    assert.equal(formatPosition(0), "00:00.000");
    assert.equal(formatPosition(61234), "01:01.234");
    assert.equal(formatPosition(65967), "01:05.967");
  });

  test("warningOrder und groupableWarnings sind festgelegt", () => {
    assert.deepEqual(warningOrder, [
      "letters_differ_between_variants",
      "letter_time_differs_between_variants",
      "count_in_tempo_mismatch",
      "missing_timestamps",
      "part_without_viewers",
      "missing_separator",
      "unknown_type_instrument",
      "first_letter_not_at_start",
    ]);
    assert.deepEqual([...groupableWarnings], ["missing_separator", "unknown_type_instrument", "first_letter_not_at_start"]);
  });
});

describe("Sauberer Song-Ordner", () => {
  test("liefert Noten, Playbacks, Einzähler und Paare ohne Meldungen", async () => {
    const result = await runCheck(
      [
        pdf("Noten/Alba - Trompete in B.pdf"),
        pdf("Noten/Alba - Tuba Leicht.pdf"),
        otherFile("Noten/.DS_Store"),
        mp3("Playbacks/Alba.mp3"),
        mp3("Playbacks/Alba - ohne Drums.mp3"),
        otherFile("Playbacks/._Alba.mp3"),
        txt("Playbacks/Timestamps/Alba.txt", ["A 00:00:00 4-4", "B 00:10:15 auftakt", "", "C 01:05:29 4-4"]),
        txt("Playbacks/Timestamps/Alba - ohne Drums.txt", ["A 00:00:00 4-4", "B 00:10:15 Auftakt", "C 01:05:29 4-4"]),
        countIn("4-4", 1500),
        countIn("Auftakt", 900),
      ],
      { directories: new Set(["Noten", "Playbacks", "Playbacks/Timestamps", "Playbacks/Einzaehler"]) },
    );
    const letters = [
      { name: "A", position_ms: 0, count_in: "4-4" },
      { name: "B", position_ms: 10500, count_in: "Auftakt" },
      { name: "C", position_ms: 65967, count_in: "4-4" },
    ];
    assert.deepEqual(result, {
      song_name: "Alba",
      can_upload: true,
      messages: [],
      sheet_music: [
        { path: "Noten/Alba - Trompete in B.pdf", part_id: 106, part_label: "Trompete in B", level_id: 1, level_name: "Normal" },
        { path: "Noten/Alba - Tuba Leicht.pdf", part_id: 108, part_label: "Tuba in C", level_id: 3, level_name: "Leicht" },
      ],
      playbacks: [
        { path: "Playbacks/Alba.mp3", type: "Normal", duration_ms: 120000, suggested_instrument_ids: [], letters },
        { path: "Playbacks/Alba - ohne Drums.mp3", type: "ohne Drums", duration_ms: 120000, suggested_instrument_ids: [9], letters },
      ],
      count_ins: [
        { path: "Playbacks/Einzaehler/Alba 4-4.mp3", name: "4-4", duration_ms: 1500 },
        { path: "Playbacks/Einzaehler/Alba Auftakt.mp3", name: "Auftakt", duration_ms: 900 },
      ],
      timestamp_pairs: [
        { audio_path: "Playbacks/Alba.mp3", timestamps_path: "Playbacks/Timestamps/Alba.txt" },
        { audio_path: "Playbacks/Alba - ohne Drums.mp3", timestamps_path: "Playbacks/Timestamps/Alba - ohne Drums.txt" },
      ],
    });
  });
});

describe("Struktur und Song", () => {
  test("meldet falsche Einträge, Ordner, Dateitypen, Größe und Präfix in Dateireihenfolge", async () => {
    const result = await runCheck([
      otherFile("Liesmich.txt"),
      otherFile("Extras/a.pdf"),
      otherFile("Extras/b.pdf"),
      pdf("Noten/Alt/Alba - Tuba.pdf"),
      otherFile("Noten/Alba - Tuba.docx"),
      otherFile("Playbacks/Alba.wav"),
      otherFile("Playbacks/Timestamps/Alba.rtf"),
      otherFile("Playbacks/Einzaehler/Alba 4-4.wav"),
      mp3("Playbacks/Sonstiges/x.mp3"),
      pdf("Noten/Alba - Trompete in C.pdf", { size: 50 * 1024 * 1024 }),
      pdf("Noten/Alab - Tuba.pdf", { size: 50 * 1024 * 1024 + 1 }),
    ]);
    assert.equal(result.can_upload, false);
    assert.deepEqual(result.messages, [
      message("error", "unexpected_entry", "Liesmich.txt", "Gehört in „Noten“ oder „Playbacks“"),
      message("error", "unexpected_entry", "Extras", "Nur „Noten“ und „Playbacks“ erlaubt"),
      message("error", "unexpected_folder", "Noten/Alt", "Unterordner nicht erlaubt"),
      message("error", "wrong_file_type", "Noten/Alba - Tuba.docx", "Nur PDF erlaubt"),
      message("error", "wrong_file_type", "Playbacks/Alba.wav", "Nur MP3 erlaubt"),
      message("error", "wrong_file_type", "Playbacks/Timestamps/Alba.rtf", "Nur TXT erlaubt"),
      message("error", "wrong_file_type", "Playbacks/Einzaehler/Alba 4-4.wav", "Nur MP3 erlaubt"),
      message("error", "unexpected_folder", "Playbacks/Sonstiges", "Nur „Timestamps“ und „Einzaehler“ erlaubt"),
      message("error", "file_too_large", "Noten/Alab - Tuba.pdf", "Größer als 50 MB"),
      message("error", "prefix_mismatch", "Noten/Alab - Tuba.pdf", "„Alab“ statt „Alba“", {
        suggestion: "Noten/Alba - Tuba.pdf",
        suggestionLabel: "Alba",
      }),
    ]);
    assert.deepEqual(result.sheet_music, [
      { path: "Noten/Alba - Trompete in C.pdf", part_id: 107, part_label: "Trompete in C", level_id: 1, level_name: "Normal" },
      { path: "Noten/Alab - Tuba.pdf", part_id: 108, part_label: "Tuba in C", level_id: 1, level_name: "Normal" },
    ]);
  });

  test("übernommene Umbenennung prüft mit neuem Namen, behält aber den Originalpfad", async () => {
    const result = await runCheck([pdf("Noten/Alab - Tuba.pdf")], {
      renames: { "Noten/Alab - Tuba.pdf": "Noten/Alba - Tuba.pdf" },
    });
    assert.deepEqual(result.messages, []);
    assert.equal(result.can_upload, true);
    assert.deepEqual(result.sheet_music, [
      { path: "Noten/Alab - Tuba.pdf", part_id: 108, part_label: "Tuba in C", level_id: 1, level_name: "Normal" },
    ]);
  });

  test("Playback ohne Songnamen am Anfang bekommt Vorschlag ohne Zusatz", async () => {
    const result = await runCheck([mp3("Playbacks/Albatross.mp3")]);
    assert.deepEqual(result.messages, [
      message("error", "prefix_mismatch", "Playbacks/Albatross.mp3", "Beginnt nicht mit „Alba“", {
        suggestion: "Playbacks/Alba.mp3",
        suggestionLabel: "Alba",
      }),
      message("warning", "missing_timestamps", "Playbacks/Albatross.mp3", "Keine TXT, also ohne Buchstaben"),
    ]);
    assert.equal(result.playbacks[0].type, "Normal");
  });

  test("leerer Ordner und kein Inhalt", async () => {
    const result = await runCheck([otherFile("Liesmich.txt")], { directories: new Set(["Noten"]) });
    assert.deepEqual(result.messages, [
      message("error", "unexpected_entry", "Liesmich.txt", "Gehört in „Noten“ oder „Playbacks“"),
      message("error", "no_content", null, "Keine Noten und keine Playbacks"),
      message("error", "empty_folder", "Noten", "Ordner ist leer"),
    ]);
  });

  test("Kategorie, vorhandener Song und unsichtbares Zeichen im Songnamen", async () => {
    const files = [pdf("Noten/Tequila - Tuba.pdf")];
    const existing = await runCheck(files, { songName: "Tequila" });
    assert.deepEqual(existing.messages, [message("error", "song_exists", null, "Song gibt es in dieser Kategorie schon")]);
    const updating = await runCheck(files, { songName: "Tequila", updating: true });
    assert.deepEqual(updating.messages, []);
    const otherCategory = await runCheck(files, { songName: "Tequila", categoryId: 2 });
    assert.deepEqual(otherCategory.messages, []);
    const unknownCategory = await runCheck([pdf("Noten/Alba - Tuba.pdf")], { categoryId: 99 });
    assert.deepEqual(unknownCategory.messages, [message("error", "unknown_category", null, "Kategorie gibt es nicht")]);
    const invisible = await runCheck([pdf("Noten/Al​ba - Tuba.pdf")], { songName: "Al​ba" });
    assert.deepEqual(messagesWithCode(invisible, "invisible_character")[0], message("error", "invisible_character", null, "Unsichtbares Zeichen im Namen des Song-Ordners"));
  });
});

describe("Noten", () => {
  test("part_without_viewers warnt, die Noten bleiben im Ergebnis", async () => {
    const result = await runCheck([pdf("Noten/Alba - Akkordblatt.pdf")]);
    assert.deepEqual(result.messages, [
      message("warning", "part_without_viewers", "Noten/Alba - Akkordblatt.pdf", "Sieht in der App niemand"),
    ]);
    assert.equal(result.can_upload, true);
    assert.deepEqual(result.sheet_music, [
      { path: "Noten/Alba - Akkordblatt.pdf", part_id: 120, part_label: "Akkordblatt in C", level_id: 1, level_name: "Normal" },
    ]);
  });

  test("Stimmen-, Level- und Doppelt-Fehler mit Vorschlägen", async () => {
    const result = await runCheck([
      pdf("Noten/Alba - Trompete.pdf"),
      pdf("Noten/Alba - Trompete in D.pdf"),
      pdf("Noten/Alba - Tuba Anfänqer.pdf"),
      pdf("Noten/Alba - Tubba Leicht.pdf"),
      pdf("Noten/Alba - Tuba.pdf"),
      pdf("Noten/Alba - tuba normal.pdf"),
      pdf("Noten/Alba - Kaputt.pdf", { valid: false }),
    ]);
    assert.deepEqual(result.messages, [
      message("error", "ambiguous_part", "Noten/Alba - Trompete.pdf", "Stimmung fehlt: B oder C"),
      message("error", "unknown_part", "Noten/Alba - Trompete in D.pdf", "Stimme „Trompete in D“ unbekannt"),
      message("error", "unknown_level", "Noten/Alba - Tuba Anfänqer.pdf", "„Anfänqer“ ist kein Level", {
        suggestion: "Noten/Alba - Tuba Anfänger.pdf",
        suggestionLabel: "Anfänger",
      }),
      message("error", "unknown_part", "Noten/Alba - Tubba Leicht.pdf", "Stimme „Tubba“ unbekannt", {
        suggestion: "Noten/Alba - Tuba Leicht.pdf",
        suggestionLabel: "Tuba",
      }),
      message("error", "duplicate_sheet_music", "Noten/Alba - tuba normal.pdf", "Doppelt mit „Alba - Tuba.pdf“", {
        related: "Noten/Alba - Tuba.pdf",
      }),
      message("error", "invalid_file_content", "Noten/Alba - Kaputt.pdf", "Kein gültiges PDF"),
    ]);
  });
});

describe("Timestamps", () => {
  test("missing_timestamps warnt, Playback kommt ohne Buchstaben mit", async () => {
    const result = await runCheck([mp3("Playbacks/Alba.mp3", 90000)]);
    assert.deepEqual(result.messages, [
      message("warning", "missing_timestamps", "Playbacks/Alba.mp3", "Keine TXT, also ohne Buchstaben"),
    ]);
    assert.equal(result.can_upload, true);
    assert.deepEqual(result.playbacks, [
      { path: "Playbacks/Alba.mp3", type: "Normal", duration_ms: 90000, suggested_instrument_ids: [], letters: [] },
    ]);
    assert.deepEqual(result.timestamp_pairs, []);
  });

  test("duplicate_letter, aber nicht nach D.S. oder D.C.", async () => {
    const result = await runCheck([
      ...playbackWithTimestamps(
        "Normal",
        timestampLines([["A", 0], ["B", 10], ["D.S.", 20], ["B", 30], ["C", 40], ["D.C.", 50], ["A", 60], ["A", 70]]),
      ),
      countIn("4-4"),
    ]);
    assert.deepEqual(result.messages, [
      message("error", "duplicate_letter", "Playbacks/Timestamps/Alba.txt", "„A“ doppelt", { line: 8 }),
    ]);
    assert.deepEqual(result.playbacks, []);
    assert.deepEqual(result.timestamp_pairs, [
      { audio_path: "Playbacks/Alba.mp3", timestamps_path: "Playbacks/Timestamps/Alba.txt" },
    ]);
  });

  test("first_letter_not_at_start nennt die Zeile des ersten Buchstabens", async () => {
    const result = await runCheck([
      ...playbackWithTimestamps("Normal", ["", timestampLine("A", 2, "4-4"), timestampLine("B", 10, "4-4")]),
      countIn("4-4"),
    ]);
    assert.deepEqual(result.messages, [
      message("warning", "first_letter_not_at_start", "Playbacks/Timestamps/Alba.txt", "„A“ beginnt nicht bei 0:00", { line: 2 }),
    ]);
    assert.equal(result.can_upload, true);
    assert.deepEqual(result.playbacks[0].letters, [
      { name: "A", position_ms: 2000, count_in: "4-4" },
      { name: "B", position_ms: 10000, count_in: "4-4" },
    ]);
  });

  test("unknown_count_in mit Hinweis auf zu kurzen Songnamen und unused_count_in", async () => {
    const result = await runCheck([
      ...playbackWithTimestamps("Normal", [timestampLine("A", 0, "4-4"), timestampLine("B", 10, "5-4")]),
      countIn("Prelude 4-4"),
    ]);
    assert.deepEqual(result.messages, [
      message("error", "unknown_count_in", "Playbacks/Timestamps/Alba.txt", "Einzähler „4-4“ fehlt – Songname zu kurz? Es gibt „Prelude 4-4“", { line: 1 }),
      message("error", "unknown_count_in", "Playbacks/Timestamps/Alba.txt", "Einzähler „5-4“ fehlt", { line: 2 }),
      message("error", "unused_count_in", countInPath("Prelude 4-4"), "Von keiner TXT benutzt"),
    ]);
    assert.deepEqual(result.playbacks, []);
    assert.deepEqual(result.count_ins, [{ path: countInPath("Prelude 4-4"), name: "Prelude 4-4", duration_ms: 1500 }]);
  });

  test("Zeilenfehler in der TXT", async () => {
    const result = await runCheck([
      ...playbackWithTimestamps(
        "Normal",
        ["A 00:00:00 4-4", "B 00:10", "C 0:20:00 4-4", "D 00:60:00 4-4", "E 00:30:30 4-4", "F​ 00:40:00 4-4", "Ä 00:50:00 4-4", "G 00:50:00 4-4", "H 00:45:00 4-4", "I 03:00:00 4-4"],
        150000,
      ),
      countIn("4-4"),
    ]);
    const path = "Playbacks/Timestamps/Alba.txt";
    assert.deepEqual(result.messages, [
      message("error", "invalid_timestamp_line", path, "Zeile unvollständig (Buchstabe, Zeit, Einzähler)", { line: 2 }),
      message("error", "invalid_timestamp_line", path, "„0:20:00“ ist keine Zeit (MM:SS:FF)", { line: 3 }),
      message("error", "invalid_frames", path, "„00:60:00“ ungültig (max. 59 s, 29 Frames)", { line: 4 }),
      message("error", "invalid_frames", path, "„00:30:30“ ungültig (max. 59 s, 29 Frames)", { line: 5 }),
      message("error", "invisible_character_text", path, "Unsichtbares Zeichen in der Zeile", { line: 6 }),
      message("error", "invalid_letter", path, "„Ä“ ist kein gültiger Buchstabe", { line: 7 }),
      message("error", "duplicate_position", path, "„G“ an gleicher Stelle wie „Ä“", { line: 8 }),
      message("error", "letters_not_ascending", path, "„H“ liegt zeitlich vor „G“", { line: 9 }),
      message("error", "letter_after_end", path, "„I“ nach MP3-Ende (2:30)", { line: 10 }),
    ]);
  });

  test("ungültige Kodierung, leere TXT und TXT ohne MP3", async () => {
    const result = await runCheck([
      ...playbackWithTimestamps("Normal", null),
      ...playbackWithTimestamps("langsamer", [""]),
      mp3(playbackPath("ohne Drums")),
      txt(timestampPath("ohne Dums"), timestampLines([["A", 0]])),
      countIn("4-4"),
    ]);
    assert.deepEqual(result.messages, [
      message("error", "orphan_timestamps", timestampPath("ohne Dums"), "TXT ohne passende MP3", {
        suggestion: timestampPath("ohne Drums"),
        suggestionLabel: "ohne Drums",
      }),
      message("error", "invalid_encoding", timestampPath("Normal"), "TXT nicht als UTF-8 gespeichert"),
      message("error", "empty_timestamps", timestampPath("langsamer"), "TXT ist leer"),
      message("warning", "missing_timestamps", playbackPath("ohne Drums"), "Keine TXT, also ohne Buchstaben"),
      message("error", "unused_count_in", countInPath("4-4"), "Von keiner TXT benutzt"),
    ]);
  });
});

describe("Varianten", () => {
  test("Gruppierung und letters_differ_between_variants", async () => {
    const reference = [["A", 0], ["B", 10], ["C", 20], ["D", 30]];
    const result = await runCheck([
      ...playbackWithTimestamps("Normal", timestampLines(reference)),
      ...playbackWithTimestamps("langsamer", timestampLines([...reference, ["E", 40]])),
      ...playbackWithTimestamps("ohne Drums", timestampLines([["A", 0], ["B", 10], ["D", 30], ["E", 40]])),
      ...playbackWithTimestamps("Altsaxophon - lauter", timestampLines([["A", 0], ["B", 10]])),
      ...playbackWithTimestamps("Trompete - lauter_langsamer", timestampLines([["A", 0], ["X", 10], ["Y", 20], ["Z", 30]])),
      ...playbackWithTimestamps("lauter", timestampLines([["A", 0]])),
      ...playbackWithTimestamps("SoloPart", timestampLines([["A", 0], ["Q", 10]])),
      ...playbackWithTimestamps("Part A - ohne Drums", timestampLines([["A", 0]])),
      ...playbackWithTimestamps("Part A", timestampLines([["A", 0], ["B", 10]])),
      ...playbackWithTimestamps("Part B - ohne Drums", timestampLines([["A", 0], ["B", 10]])),
      ...playbackWithTimestamps("Part B - langsamer", timestampLines([["A", 0]])),
      countIn("4-4"),
    ]);
    const differs = (type, text) => message("warning", "letters_differ_between_variants", timestampPath(type), text);
    assert.deepEqual(result.messages, [
      differs("langsamer", "Zusätzlich „E“ (vgl. „Normal“)"),
      differs("ohne Drums", "Fehlt „C“, zusätzlich „E“ (vgl. „Normal“)"),
      differs("Altsaxophon - lauter", "Fehlt „C“, „D“ (vgl. „Normal“)"),
      differs("Trompete - lauter_langsamer", "Andere Buchstaben als Normal:\nHier: A X Y Z\nNormal: A B C D"),
      differs("lauter", "Andere Buchstaben als Normal:\nHier: A\nNormal: A B C D"),
      differs("Part A - ohne Drums", "Fehlt „B“ (vgl. „Part A“)"),
      differs("Part B - langsamer", "Fehlt „B“ (vgl. „Part B - ohne Drums“)"),
    ]);
    assert.equal(result.can_upload, true);
    assert.equal(result.playbacks.length, 11);
  });

  test("letter_time_differs_between_variants nur bei Ausreißern in der Mitte", async () => {
    const result = await runCheck([
      ...playbackWithTimestamps("Normal", timestampLines([["A", 0], ["B", 10], ["C", 20], ["D", 30], ["E", 40]])),
      ...playbackWithTimestamps("langsamer", timestampLines([["A", 0], ["B", 12], ["C", 30], ["D", 36], ["E", 48]])),
      ...playbackWithTimestamps("ohne Drums", timestampLines([["A", 0], ["B", 15], ["C", 30], ["D", 45], ["E", 60]])),
      ...playbackWithTimestamps("lauter", timestampLines([["A", 0], ["B", 10], ["C", 20], ["D", 30], ["E", 50]])),
      countIn("4-4"),
    ]);
    assert.deepEqual(result.messages, [
      message("warning", "letter_time_differs_between_variants", timestampPath("langsamer"), "„C“ bei 0:30, erwartet ~0:24", { line: 3 }),
    ]);
  });

  test("count_in_tempo_mismatch: eine Meldung je TXT und Einzähler", async () => {
    const result = await runCheck([
      ...playbackWithTimestamps("Normal", [
        timestampLine("A", 0, "4-4"),
        timestampLine("B", 10, "4-4langsamer"),
        timestampLine("C", 20, "3-4langsamer"),
        timestampLine("D", 30, "4-4LANGSAMER"),
      ]),
      ...playbackWithTimestamps("langsamer", [
        timestampLine("A", 0, "4-4langsamer"),
        timestampLine("B", 10, "4-4"),
        timestampLine("C", 20, "2-4"),
        timestampLine("D", 30, "4-4"),
      ]),
      countIn("4-4"),
      countIn("4-4langsamer"),
      countIn("3-4langsamer"),
      countIn("2-4"),
    ]);
    assert.deepEqual(result.messages, [
      message("warning", "count_in_tempo_mismatch", timestampPath("Normal"), "Normales Playback mit Einzähler „4-4langsamer“ bei „B“, „D“, gemeint „4-4“?", { line: 2 }),
      message("warning", "count_in_tempo_mismatch", timestampPath("Normal"), "Normales Playback mit langsamem Einzähler „3-4langsamer“ bei „C“", { line: 3 }),
      message("warning", "count_in_tempo_mismatch", timestampPath("langsamer"), "Langsames Playback mit Einzähler „4-4“ bei „B“, „D“, gemeint „4-4langsamer“?", { line: 2 }),
    ]);
    assert.deepEqual(
      result.playbacks[0].letters.map((letter) => letter.count_in),
      ["4-4", "4-4langsamer", "3-4langsamer", "4-4langsamer"],
    );
  });
});

describe("Instrumente im Zusatz", () => {
  test("unknown_type_instrument und ambiguous_type_instrument bei MP3 und TXT", async () => {
    const result = await runCheck([
      ...playbackWithTimestamps("Tenorsaxophone - lauter", timestampLines([["A", 0]])),
      ...playbackWithTimestamps("Part B - Saxaphon", timestampLines([["A", 0]])),
      mp3(playbackPath("Klarinette")),
      mp3(playbackPath("Saxophon")),
      mp3(playbackPath("Pauke")),
      countIn("4-4"),
    ]);
    const family = "Altsaxophon, Baritonsaxophon, Tenorsaxophon";
    assert.deepEqual(result.messages, [
      message("warning", "unknown_type_instrument", playbackPath("Tenorsaxophone - lauter"), "Tippfehler im Zusatz: „Tenorsaxophone“", {
        suggestion: playbackPath("Tenorsaxophon - lauter"),
        suggestionLabel: "Tenorsaxophon",
      }),
      message("error", "ambiguous_type_instrument", playbackPath("Part B - Saxaphon"), `„Saxaphon“ ist kein genaues Instrument, gemeint ist eines von: ${family}`, {
        suggestion: playbackPath("Part B - Altsaxophon"),
        suggestionLabel: "Altsaxophon",
      }),
      message("error", "ambiguous_type_instrument", playbackPath("Klarinette"), "„Klarinette“ ist kein genaues Instrument, gemeint ist eines von: Bassklarinette, Kontraklarinette"),
      message("error", "ambiguous_type_instrument", playbackPath("Saxophon"), `„Saxophon“ ist kein genaues Instrument, gemeint ist eines von: ${family}`, {
        suggestion: playbackPath("Altsaxophon"),
        suggestionLabel: "Altsaxophon",
      }),
      message("error", "ambiguous_type_instrument", playbackPath("Pauke"), "„Pauke“ ist kein genaues Instrument, gemeint ist eines von: Handpauke, Kesselpauke"),
      message("warning", "unknown_type_instrument", timestampPath("Tenorsaxophone - lauter"), "Tippfehler im Zusatz: „Tenorsaxophone“", {
        suggestion: timestampPath("Tenorsaxophon - lauter"),
        suggestionLabel: "Tenorsaxophon",
      }),
      message("error", "ambiguous_type_instrument", timestampPath("Part B - Saxaphon"), `„Saxaphon“ ist kein genaues Instrument, gemeint ist eines von: ${family}`, {
        suggestion: timestampPath("Part B - Altsaxophon"),
        suggestionLabel: "Altsaxophon",
      }),
      message("warning", "missing_timestamps", playbackPath("Klarinette"), "Keine TXT, also ohne Buchstaben"),
      message("warning", "missing_timestamps", playbackPath("Saxophon"), "Keine TXT, also ohne Buchstaben"),
      message("warning", "missing_timestamps", playbackPath("Pauke"), "Keine TXT, also ohne Buchstaben"),
    ]);
    assert.deepEqual(
      result.playbacks.map((playback) => playback.suggested_instrument_ids),
      [[], [], [], [], []],
    );
  });

  test("übernommener Vorschlag beseitigt die Warnung und liefert die Instrument-ID", async () => {
    const result = await runCheck(
      [...playbackWithTimestamps("Tenorsaxophone - lauter", timestampLines([["A", 0]])), countIn("4-4")],
      {
        renames: {
          [playbackPath("Tenorsaxophone - lauter")]: playbackPath("Tenorsaxophon - lauter"),
          [timestampPath("Tenorsaxophone - lauter")]: timestampPath("Tenorsaxophon - lauter"),
        },
      },
    );
    assert.deepEqual(result.messages, []);
    assert.deepEqual(result.playbacks, [
      {
        path: playbackPath("Tenorsaxophone - lauter"),
        type: "Tenorsaxophon - lauter",
        duration_ms: 120000,
        suggested_instrument_ids: [2],
        letters: [{ name: "A", position_ms: 0, count_in: "4-4" }],
      },
    ]);
  });

  test("suggested_instrument_ids aus den Teilen des Zusatzes und ohne Drums", async () => {
    const types = ["Normal", "Altsaxophon - lauter", "Trompete - lauter", "ohne Drums", "Tuba - ohne Drums_langsamer", "SoloPart"];
    const result = await runCheck(types.map((type) => mp3(playbackPath(type))));
    assert.deepEqual(
      result.playbacks.map(({ type, suggested_instrument_ids }) => [type, suggested_instrument_ids]),
      [
        ["Normal", []],
        ["Altsaxophon - lauter", [1]],
        ["Trompete - lauter", [6, 7]],
        ["ohne Drums", [9]],
        ["Tuba - ohne Drums_langsamer", [8, 9]],
        ["SoloPart", []],
      ],
    );
    assert.deepEqual(new Set(result.messages.map((entry) => entry.code)), new Set(["missing_timestamps"]));
  });
});
