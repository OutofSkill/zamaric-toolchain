import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatPosition, hasInvisible, isIgnoredName } from "../static/check.js";
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
  reference,
  runCheck,
  timestampLines,
  timestampPath,
  txt,
} from "./fixtures.js";

const tab = String.fromCharCode(9);
const lineFeed = String.fromCharCode(10);
const carriageReturn = String.fromCharCode(13);
const byteOrderMark = String.fromCharCode(0xfeff);
const zeroWidthSpace = String.fromCharCode(0x200b);
const noBreakSpace = String.fromCharCode(0xa0);

const rawText = (path, text) => ({ path, size: 256, file: { text } });
const missingTimestamps = (path) => message("warning", "missing_timestamps", path, "Keine TXT, also ohne Buchstaben");
const unusedCountIn = (name) => message("error", "unused_count_in", countInPath(name), "Von keiner TXT benutzt");
const onlySheet = async (name, options) => runCheck([pdf(`Noten/Alba - ${name}.pdf`)], options);
const lettersOf = (result) => result.playbacks[0].letters;

describe("Struktur im Detail", () => {
  test("Punkt im Namen gehört zum Zusatz", async () => {
    const result = await runCheck([mp3("Playbacks/Alba - Version 2.0.mp3")]);
    assert.deepEqual(result.messages, [missingTimestamps("Playbacks/Alba - Version 2.0.mp3")]);
    assert.equal(result.playbacks[0].type, "Version 2.0");
  });

  test("Datei ohne Stamm ist kein PDF", async () => {
    const result = await runCheck([pdf("Noten/.pdf")]);
    assert.deepEqual(result.messages, [message("error", "wrong_file_type", "Noten/.pdf", "Nur PDF erlaubt")]);
  });

  test("Endungen in Großbuchstaben sind erlaubt", async () => {
    const result = await runCheck([pdf("Noten/Alba - Tuba.PDF"), mp3("Playbacks/Alba.MP3")]);
    assert.deepEqual(result.messages, [missingTimestamps("Playbacks/Alba.MP3")]);
    assert.equal(result.sheet_music[0].part_id, 108);
    assert.equal(result.playbacks[0].type, "Normal");
  });

  test("zu große Datei wird mit dem Originalpfad gemeldet, auch nach Umbenennung", async () => {
    const result = await runCheck([pdf("Noten/Alab - Tuba.pdf", { size: 50 * 1024 * 1024 + 1 })], {
      renames: { "Noten/Alab - Tuba.pdf": "Noten/Alba - Tuba.pdf" },
    });
    assert.deepEqual(result.messages, [message("error", "file_too_large", "Noten/Alab - Tuba.pdf", "Größer als 50 MB")]);
  });

  test("Unterordner in Timestamps, Einzaehler und fremden Ordnern unter Playbacks", async () => {
    const result = await runCheck([
      txt("Playbacks/Timestamps/Sub/Alba.txt", ["A 00:00:00 4-4"]),
      mp3("Playbacks/Einzaehler/Sub/Alba 4-4.mp3"),
      mp3("Playbacks/Sonstiges/Sub/x.mp3"),
      mp3("Playbacks/Alba.mp3"),
    ]);
    const text = "Nur „Timestamps“ und „Einzaehler“ erlaubt";
    assert.deepEqual(result.messages, [
      message("error", "unexpected_folder", "Playbacks/Timestamps/Sub", text),
      message("error", "unexpected_folder", "Playbacks/Einzaehler/Sub", text),
      message("error", "unexpected_folder", "Playbacks/Sonstiges/Sub", text),
      missingTimestamps("Playbacks/Alba.mp3"),
    ]);
  });

  test("Datei „Noten.pdf“ füllt den Ordner Noten nicht", async () => {
    const result = await runCheck([otherFile("Noten.pdf")], { directories: new Set(["Noten"]) });
    assert.deepEqual(result.messages, [
      message("error", "unexpected_entry", "Noten.pdf", "Gehört in „Noten“ oder „Playbacks“"),
      message("error", "no_content", null, "Keine Noten und keine Playbacks"),
      message("error", "empty_folder", "Noten", "Ordner ist leer"),
    ]);
  });

  test("leere Ordner Timestamps und Einzaehler", async () => {
    const result = await runCheck([mp3("Playbacks/Alba.mp3")], {
      directories: new Set(["Playbacks", "Playbacks/Timestamps", "Playbacks/Einzaehler"]),
    });
    assert.deepEqual(result.messages, [
      message("error", "empty_folder", "Playbacks/Timestamps", "Ordner ist leer"),
      message("error", "empty_folder", "Playbacks/Einzaehler", "Ordner ist leer"),
      missingTimestamps("Playbacks/Alba.mp3"),
    ]);
  });

  test("mehrere unsichtbare Zeichen im Dateinamen", async () => {
    const path = `Noten/Alba - Tu${zeroWidthSpace}b${zeroWidthSpace}a.pdf`;
    const result = await runCheck([pdf(path)]);
    assert.deepEqual(result.messages, [
      message("error", "invisible_character", path, "Unsichtbares Zeichen im Namen", {
        suggestion: "Noten/Alba - Tuba.pdf",
        suggestionLabel: "Zeichen entfernen",
      }),
    ]);
    assert.deepEqual(
      result.sheet_music.map(({ path: sheetPath, part_id }) => [sheetPath, part_id]),
      [[path, 108]],
    );
  });

  test("überflüssige Leerzeichen im Dateinamen", async () => {
    const path = "Noten/Alba  -  Tuba .pdf";
    const result = await runCheck([pdf(path)]);
    assert.equal(result.can_upload, false);
    assert.deepEqual(result.messages, [
      message("error", "whitespace_issue", path, "Überflüssige Leerzeichen", {
        suggestion: "Noten/Alba - Tuba.pdf",
        suggestionLabel: "Leerzeichen entfernen",
      }),
    ]);
    assert.deepEqual(
      result.sheet_music.map(({ path: sheetPath, part_id }) => [sheetPath, part_id]),
      [[path, 108]],
    );
  });

  test("leerer Ordner Playbacks", async () => {
    const result = await runCheck([pdf("Noten/Alba - Tuba.pdf")], { directories: new Set(["Noten", "Playbacks"]) });
    assert.deepEqual(result.messages, [message("error", "empty_folder", "Playbacks", "Ordner ist leer")]);
    assert.equal(result.sheet_music[0].part_id, 108);
  });

  test("führendes Leerzeichen im Dateinamen", async () => {
    const path = "Noten/ Alba - Tuba.pdf";
    const result = await runCheck([pdf(path)]);
    assert.deepEqual(result.messages, [
      message("error", "whitespace_issue", path, "Überflüssige Leerzeichen", {
        suggestion: "Noten/Alba - Tuba.pdf",
        suggestionLabel: "Leerzeichen entfernen",
      }),
    ]);
    assert.deepEqual(
      result.sheet_music.map(({ part_id, level_id }) => [part_id, level_id]),
      [[108, 1]],
    );
  });

  test("Tab im Dateinamen ist ein überflüssiges Leerzeichen", async () => {
    const path = `Noten/Alba -${tab}Tuba.pdf`;
    const result = await runCheck([pdf(path)]);
    assert.deepEqual(result.messages, [
      message("error", "whitespace_issue", path, "Überflüssige Leerzeichen", {
        suggestion: "Noten/Alba - Tuba.pdf",
        suggestionLabel: "Leerzeichen entfernen",
      }),
    ]);
  });

  test("Ordner mit „._“ am Anfang wird nicht ignoriert", async () => {
    const result = await runCheck([otherFile("._Extras/notiz.txt")]);
    assert.deepEqual(result.messages, [
      message("error", "unexpected_entry", "._Extras", "Nur „Noten“ und „Playbacks“ erlaubt"),
      message("error", "no_content", null, "Keine Noten und keine Playbacks"),
    ]);
  });

  test("PDF zwei Ebenen tief unter Noten", async () => {
    const result = await runCheck([pdf("Noten/Alt/Sub/Alba - Tuba.pdf")]);
    assert.deepEqual(result.messages, [message("error", "unexpected_folder", "Noten/Alt/Sub", "Unterordner nicht erlaubt")]);
    assert.deepEqual(result.sheet_music, []);
  });

  test("Datei, die wie eine Objekt-Eigenschaft heißt", async () => {
    const result = await runCheck([otherFile("constructor"), pdf("Noten/Alba - Tuba.pdf")]);
    assert.deepEqual(result.messages, [message("error", "unexpected_entry", "constructor", "Gehört in „Noten“ oder „Playbacks“")]);
  });

  test("„._“ mitten im Namen wird nicht ignoriert", async () => {
    assert.equal(isIgnoredName("Alba - Teil 1._2.mp3"), false);
    const result = await runCheck([mp3("Playbacks/Alba - Teil 1._2.mp3")]);
    assert.deepEqual(result.messages, [missingTimestamps("Playbacks/Alba - Teil 1._2.mp3")]);
    assert.equal(result.playbacks[0].type, "Teil 1._2");
  });

  test("jedes Playback bekommt seine eigene Dauer", async () => {
    const result = await runCheck([mp3("Playbacks/Alba.mp3", 90000), mp3("Playbacks/Alba - lauter.mp3", 60000)]);
    assert.deepEqual(
      result.playbacks.map(({ duration_ms }) => duration_ms),
      [90000, 60000],
    );
  });

  test("Songname aus einem Zeichen", async () => {
    const result = await runCheck([mp3("Playbacks/X.mp3")], { songName: "X" });
    assert.deepEqual(result.messages, [missingTimestamps("Playbacks/X.mp3")]);
    assert.equal(result.playbacks[0].type, "Normal");
  });
});

describe("Song, Präfix und Zusatz im Detail", () => {
  test("song_exists ignoriert Groß-/Kleinschreibung", async () => {
    const result = await runCheck([pdf("Noten/tequila - Tuba.pdf")], { songName: "tequila" });
    assert.deepEqual(result.messages, [message("error", "song_exists", null, "Song gibt es in dieser Kategorie schon")]);
  });

  test("song_exists findet den Song unter mehreren", async () => {
    const result = await runCheck([pdf("Noten/Tequila - Tuba.pdf")], {
      songName: "Tequila",
      reference: {
        ...reference,
        songs: [
          { id: 1, category_id: 1, name: "Tequila" },
          { id: 2, category_id: 2, name: "Alba" },
        ],
      },
    });
    assert.deepEqual(result.messages, [message("error", "song_exists", null, "Song gibt es in dieser Kategorie schon")]);
  });

  test("verwaiste TXT werden in Dateireihenfolge gemeldet", async () => {
    const result = await runCheck([
      txt("Playbacks/Timestamps/Alba - Xa.txt", ["A 00:00:00 4-4"]),
      txt("Playbacks/Timestamps/Alba - Yb.txt", ["A 00:00:00 4-4"]),
    ]);
    assert.deepEqual(
      messagesWithCode(result, "orphan_timestamps").map(({ path }) => path),
      ["Playbacks/Timestamps/Alba - Xa.txt", "Playbacks/Timestamps/Alba - Yb.txt"],
    );
  });

  test("song_exists normalisiert Unicode", async () => {
    const name = "Müde";
    const result = await runCheck([pdf(`Noten/${name} - Tuba.pdf`)], {
      songName: name,
      reference: { ...reference, songs: [{ id: 2, category_id: 1, name: name.normalize("NFD") }] },
    });
    assert.deepEqual(result.messages, [message("error", "song_exists", null, "Song gibt es in dieser Kategorie schon")]);
  });

  test("fehlendes „ - “ ist nur eine Warnung", async () => {
    const result = await runCheck([pdf("Noten/Alba Tuba.pdf"), mp3("Playbacks/Alba ohne Drums.mp3")]);
    assert.equal(result.can_upload, true);
    assert.deepEqual(result.messages, [
      message("warning", "missing_separator", "Noten/Alba Tuba.pdf", "„ - “ fehlt → Zusatz „Tuba“"),
      message("warning", "missing_separator", "Playbacks/Alba ohne Drums.mp3", "„ - “ fehlt → Zusatz „ohne Drums“"),
      missingTimestamps("Playbacks/Alba ohne Drums.mp3"),
    ]);
    assert.equal(result.sheet_music[0].part_id, 108);
    assert.equal(result.playbacks[0].type, "ohne Drums");
    assert.deepEqual(result.playbacks[0].suggested_instrument_ids, [9]);
  });

  test("Bindestrich ohne Leerzeichen", async () => {
    const result = await runCheck([pdf("Noten/Alba -Tuba.pdf")]);
    assert.deepEqual(result.messages, [
      message("warning", "missing_separator", "Noten/Alba -Tuba.pdf", "„ - “ fehlt → Zusatz „-Tuba“"),
      message("error", "unknown_part", "Noten/Alba -Tuba.pdf", "Stimme „-Tuba“ unbekannt", {
        suggestion: "Noten/Alba - Tuba.pdf",
        suggestionLabel: "Tuba",
      }),
    ]);
  });

  test("Präfix aus mehreren Wörtern beim Einzähler", async () => {
    const path = "Playbacks/Einzaehler/Alab Teil 4-4.mp3";
    const result = await runCheck([path].map((entry) => mp3(entry)));
    assert.deepEqual(messagesWithCode(result, "prefix_mismatch"), [
      message("error", "prefix_mismatch", path, "„Alab Teil“ statt „Alba“", {
        suggestion: "Playbacks/Einzaehler/Alba 4-4.mp3",
        suggestionLabel: "Alba",
      }),
    ]);
    assert.equal(messagesWithCode(result, "unused_count_in").length, 1);
    assert.equal(result.count_ins[0].name, "4-4");
  });

  test("Präfix bei mehreren Segmenten im Zusatz", async () => {
    const path = "Playbacks/Alab - Tuba - lauter.mp3";
    const result = await runCheck([mp3(path)]);
    assert.deepEqual(messagesWithCode(result, "prefix_mismatch"), [
      message("error", "prefix_mismatch", path, "„Alab“ statt „Alba“", {
        suggestion: "Playbacks/Alba - Tuba - lauter.mp3",
        suggestionLabel: "Alba",
      }),
    ]);
    assert.equal(result.playbacks[0].type, "Tuba - lauter");
    assert.deepEqual(result.playbacks[0].suggested_instrument_ids, [8]);
  });

  test("Namen ohne Stimme bzw. ohne Einzähler-Namen", async () => {
    const result = await runCheck([pdf("Noten/Tuba.pdf"), mp3("Playbacks/Einzaehler/4-4.mp3"), mp3("Playbacks/Alba.mp3")]);
    assert.deepEqual(result.messages, [
      message("error", "invalid_name_pattern", "Noten/Tuba.pdf", "Stimme fehlt im Namen"),
      message("error", "invalid_name_pattern", "Playbacks/Einzaehler/4-4.mp3", "Einzähler-Name fehlt"),
      missingTimestamps("Playbacks/Alba.mp3"),
    ]);
  });

  test("„Normal“ als Zusatz ist derselbe Typ wie ohne Zusatz, die erste Datei bleibt", async () => {
    const result = await runCheck([
      mp3("Playbacks/Alba.mp3", 1000),
      mp3("Playbacks/Alba - Normal.mp3", 2000),
      txt("Playbacks/Timestamps/Alba.txt", ["A 00:00:00 4-4"]),
      txt("Playbacks/Timestamps/Alba - normal.txt", ["A 00:00:00 4-4", "B 00:00:01 4-4"]),
      countIn("4-4"),
    ]);
    assert.deepEqual(result.messages, [
      message("error", "invalid_name_pattern", "Playbacks/Alba - Normal.mp3", "Gleicher Zusatz wie „Alba.mp3“", {
        related: "Playbacks/Alba.mp3",
      }),
      message("error", "invalid_name_pattern", "Playbacks/Timestamps/Alba - normal.txt", "Gleicher Zusatz wie „Alba.txt“", {
        related: "Playbacks/Timestamps/Alba.txt",
      }),
    ]);
    assert.deepEqual(result.playbacks, [
      {
        path: "Playbacks/Alba.mp3",
        type: "Normal",
        duration_ms: 1000,
        suggested_instrument_ids: [],
        letters: [{ name: "A", position_ms: 0, count_in: "4-4" }],
      },
    ]);
    assert.deepEqual(result.timestamp_pairs, [
      { audio_path: "Playbacks/Alba.mp3", timestamps_path: "Playbacks/Timestamps/Alba.txt" },
    ]);
  });

  test("doppelte TXT in anderer Großschreibung wird erkannt, die erste bleibt", async () => {
    const result = await runCheck([
      mp3("Playbacks/Alba - lauter.mp3"),
      txt("Playbacks/Timestamps/Alba - lauter.txt", ["A 00:00:00 4-4"]),
      txt("Playbacks/Timestamps/Alba - Lauter.txt", ["A 00:00:00 4-4", "B 00:10:00 4-4"]),
      countIn("4-4"),
    ]);
    assert.deepEqual(result.messages, [
      message("error", "invalid_name_pattern", "Playbacks/Timestamps/Alba - Lauter.txt", "Gleicher Zusatz wie „Alba - lauter.txt“", {
        related: "Playbacks/Timestamps/Alba - lauter.txt",
      }),
    ]);
    assert.equal(result.timestamp_pairs[0].timestamps_path, "Playbacks/Timestamps/Alba - lauter.txt");
  });

  test("Präfixfehler bei einer TXT", async () => {
    const result = await runCheck([
      mp3("Playbacks/Alba - lauter.mp3"),
      txt("Playbacks/Timestamps/Alab - lauter.txt", ["A 00:00:00 4-4"]),
      countIn("4-4"),
    ]);
    assert.deepEqual(result.messages, [
      message("error", "prefix_mismatch", "Playbacks/Timestamps/Alab - lauter.txt", "„Alab“ statt „Alba“", {
        suggestion: "Playbacks/Timestamps/Alba - lauter.txt",
        suggestionLabel: "Alba",
      }),
    ]);
    assert.equal(result.timestamp_pairs.length, 1);
  });

  test("Songname im Dateinamen muss genau so geschrieben sein", async () => {
    const result = await runCheck([mp3("Playbacks/alba.mp3")]);
    assert.deepEqual(result.messages, [
      message("error", "prefix_mismatch", "Playbacks/alba.mp3", "Beginnt nicht mit „Alba“", {
        suggestion: "Playbacks/Alba.mp3",
        suggestionLabel: "Alba",
      }),
      missingTimestamps("Playbacks/alba.mp3"),
    ]);
  });

  test("Präfix mit Zusatz muss genau so geschrieben sein", async () => {
    const result = await runCheck([pdf("Noten/alba - Tuba.pdf"), mp3("Playbacks/alba - lauter.mp3")]);
    assert.deepEqual(result.messages, [
      message("error", "prefix_mismatch", "Noten/alba - Tuba.pdf", "„alba“ statt „Alba“", {
        suggestion: "Noten/Alba - Tuba.pdf",
        suggestionLabel: "Alba",
      }),
      message("error", "prefix_mismatch", "Playbacks/alba - lauter.mp3", "„alba“ statt „Alba“", {
        suggestion: "Playbacks/Alba - lauter.mp3",
        suggestionLabel: "Alba",
      }),
      missingTimestamps("Playbacks/alba - lauter.mp3"),
    ]);
  });

  test("verwaiste TXT bekommt keine MP3 vorgeschlagen, die schon eine TXT hat", async () => {
    const lines = ["A 00:00:00 4-4"];
    const result = await runCheck([...playbackWithTimestamps("Normal", lines), txt(timestampPath("Normall"), lines), countIn("4-4")]);
    assert.deepEqual(messagesWithCode(result, "orphan_timestamps"), [
      message("error", "orphan_timestamps", timestampPath("Normall"), "TXT ohne passende MP3"),
    ]);
  });

  test("verwaiste TXT bekommt den Normal-Typ ohne Zusatz vorgeschlagen", async () => {
    const result = await runCheck([mp3(playbackPath("Normal")), txt(timestampPath("Normall"), ["A 00:00:00 4-4"]), countIn("4-4")]);
    assert.deepEqual(messagesWithCode(result, "orphan_timestamps"), [
      message("error", "orphan_timestamps", timestampPath("Normall"), "TXT ohne passende MP3", {
        suggestion: "Playbacks/Timestamps/Alba.txt",
        suggestionLabel: "Normal",
      }),
    ]);
  });

  test("verwaiste TXT zu kleingeschriebenem Normal-Zusatz bekommt den Namen ohne Zusatz vorgeschlagen", async () => {
    const result = await runCheck([
      mp3("Playbacks/Alba - normal.mp3"),
      txt("Playbacks/Timestamps/Alba - Normall.txt", ["A 00:00:00 4-4"]),
      countIn("4-4"),
    ]);
    assert.deepEqual(messagesWithCode(result, "orphan_timestamps"), [
      message("error", "orphan_timestamps", "Playbacks/Timestamps/Alba - Normall.txt", "TXT ohne passende MP3", {
        suggestion: "Playbacks/Timestamps/Alba.txt",
        suggestionLabel: "normal",
      }),
    ]);
  });

  test("verwaiste TXT mit Ähnlichkeit 0,67 bekommt einen Vorschlag", async () => {
    const result = await runCheck([mp3(playbackPath("lauter")), txt(timestampPath("laut"), ["A 00:00:00 4-4"]), countIn("4-4")]);
    assert.deepEqual(messagesWithCode(result, "orphan_timestamps"), [
      message("error", "orphan_timestamps", timestampPath("laut"), "TXT ohne passende MP3", {
        suggestion: "Playbacks/Timestamps/Alba - lauter.txt",
        suggestionLabel: "lauter",
      }),
    ]);
  });
});

describe("Noten im Detail", () => {
  const unknownPart = (name, suggestion = null, suggestionLabel = null) =>
    message("error", "unknown_part", `Noten/Alba - ${name}.pdf`, `Stimme „${name}“ unbekannt`, { suggestion, suggestionLabel });
  const unknownLevel = (name, word, suggestion = null, suggestionLabel = null) =>
    message("error", "unknown_level", `Noten/Alba - ${name}.pdf`, `„${word}“ ist kein Level`, { suggestion, suggestionLabel });

  for (const [name, suggestion, label] of [
    ["Tubxy", "Noten/Alba - Tuba.pdf", "Tuba"],
    ["Tubxyz", null, null],
    ["XXXXTuba", null, null],
    ["Tub", "Noten/Alba - Tuba.pdf", "Tuba"],
    ["Tubaaa", "Noten/Alba - Tuba.pdf", "Tuba"],
    ["DrumSett", "Noten/Alba - DrumSet.pdf", "DrumSet"],
    ["Trompete in Bb", "Noten/Alba - Trompete in B.pdf", "Trompete in B"],
    ["Trompete in Cc", "Noten/Alba - Trompete in C.pdf", "Trompete in C"],
    ["Trompette", null, null],
  ]) {
    test(`Stimmen-Vorschlag für „${name}“`, async () => {
      const result = await onlySheet(name);
      assert.deepEqual(result.messages, [unknownPart(name, suggestion, label)]);
    });
  }

  test("mehrteilige Stimme mit Level-Wort am Ende", async () => {
    const result = await onlySheet("Trompete in B Leicht");
    assert.deepEqual(result.messages, []);
    assert.deepEqual(
      result.sheet_music.map(({ part_id, part_label, level_id }) => [part_id, part_label, level_id]),
      [[106, "Trompete in B", 3]],
    );
  });

  test("fehlendes Level „Normal“ auch bei nur einer PDF", async () => {
    const result = await onlySheet("Tuba Leicht", { reference: { ...reference, levels: [{ id: 3, name: "Leicht" }] } });
    assert.deepEqual(result.messages, [message("error", "missing_default_level", null, "Level „Normal“ fehlt in der Datenbank")]);
    assert.deepEqual(
      result.sheet_music.map(({ level_id }) => level_id),
      [3],
    );
  });

  test("doppelte PDF landet nicht im Ergebnis", async () => {
    const result = await runCheck([pdf("Noten/Alba - Tuba.pdf"), pdf("Noten/Alba - tuba normal.pdf")]);
    assert.deepEqual(
      result.messages.map(({ code }) => code),
      ["duplicate_sheet_music"],
    );
    assert.deepEqual(
      result.sheet_music.map(({ path }) => path),
      ["Noten/Alba - Tuba.pdf"],
    );
  });

  test("doppelte Noten nennen den Originalpfad der umbenannten Datei", async () => {
    const result = await runCheck([pdf("Noten/Alab - Tuba.pdf"), pdf("Noten/Alba - tuba normal.pdf")], {
      renames: { "Noten/Alab - Tuba.pdf": "Noten/Alba - Tuba.pdf" },
    });
    assert.deepEqual(result.messages, [
      message("error", "duplicate_sheet_music", "Noten/Alba - tuba normal.pdf", "Doppelt mit „Alab - Tuba.pdf“", {
        related: "Noten/Alab - Tuba.pdf",
      }),
    ]);
  });

  test("mehrdeutige Stimme in Kleinschreibung nennt die Stimmungen", async () => {
    const result = await onlySheet("trompete");
    assert.deepEqual(result.messages, [message("error", "ambiguous_part", "Noten/Alba - trompete.pdf", "Stimmung fehlt: B oder C")]);
  });

  test("ein Level-Wort allein ist keine Stimme", async () => {
    const result = await onlySheet("Leicht");
    assert.deepEqual(messagesWithCode(result, "unknown_part").map(({ text }) => text), ["Stimme „Leicht“ unbekannt"]);
  });

  for (const [name, word] of [
    ["Tuba Leixxx", "Leixxx"],
    ["Tuba Normall", "Normall"],
  ]) {
    test(`kein Level-Vorschlag für „${word}“`, async () => {
      const result = await onlySheet(name);
      assert.deepEqual(result.messages, [unknownLevel(name, word)]);
    });
  }

  for (const name of ["Trompete in B xyz", "Trompete xyz"]) {
    test(`unbekanntes Level hinter „${name.replace(" xyz", "")}“`, async () => {
      const result = await onlySheet(name);
      assert.deepEqual(
        result.messages.map(({ code, text }) => [code, text]),
        [["unknown_level", "„xyz“ ist kein Level"]],
      );
    });
  }

  for (const name of ["Trompete in b", "trompete in B"]) {
    test(`Stimme „${name}“ ohne Rücksicht auf Groß-/Kleinschreibung`, async () => {
      const result = await onlySheet(name);
      assert.deepEqual(result.messages, []);
      assert.equal(result.sheet_music[0].part_id, 106);
      assert.equal(result.sheet_music[0].part_label, "Trompete in B");
    });
  }

  test("gleiche Stimme in zwei Leveln ist erlaubt", async () => {
    const result = await runCheck([pdf("Noten/Alba - Tuba.pdf"), pdf("Noten/Alba - Tuba Leicht.pdf")]);
    assert.deepEqual(result.messages, []);
    assert.deepEqual(
      result.sheet_music.map(({ level_id }) => level_id),
      [1, 3],
    );
  });

  test("Referenzdaten in NFD werden normalisiert", async () => {
    const levelName = "Anfänger";
    const partName = "Flügelhorn";
    const nfdReference = {
      ...reference,
      levels: [
        { id: 1, name: "Normal" },
        { id: 2, name: levelName.normalize("NFD") },
      ],
      parts: [...reference.parts, { id: 130, name: partName.normalize("NFD"), transposition: "B" }],
      instrument_parts: [...reference.instrument_parts, { part_id: 130, instrument_id: 6 }],
    };
    const result = await runCheck(
      [pdf(`Noten/Alba - ${partName} ${levelName}.pdf`), pdf(`Noten/Alba - ${partName} Anfänqer.pdf`)],
      { reference: nfdReference },
    );
    assert.deepEqual(
      result.sheet_music.map(({ part_id, part_label, level_id }) => [part_id, part_label, level_id]),
      [[130, `${partName} in B`, 2]],
    );
    assert.deepEqual(messagesWithCode(result, "unknown_level"), [
      message("error", "unknown_level", `Noten/Alba - ${partName} Anfänqer.pdf`, "„Anfänqer“ ist kein Level", {
        suggestion: `Noten/Alba - ${partName} ${levelName}.pdf`,
        suggestionLabel: levelName,
      }),
    ]);
  });

  test("Stimme mit Transposition null", async () => {
    const result = await onlySheet("Schlagwerk", {
      reference: {
        ...reference,
        parts: [...reference.parts, { id: 121, name: "Schlagwerk", transposition: null }],
        instrument_parts: [...reference.instrument_parts, { part_id: 121, instrument_id: 9 }],
      },
    });
    assert.deepEqual(result.messages, []);
    assert.equal(result.sheet_music[0].part_label, "Schlagwerk");
  });

  test("Referenz ohne instrument_parts", async () => {
    const { instrument_parts, ...withoutInstrumentParts } = reference;
    assert.ok(instrument_parts.length > 0);
    const result = await onlySheet("Tuba", { reference: withoutInstrumentParts });
    assert.deepEqual(result.messages, [message("warning", "part_without_viewers", "Noten/Alba - Tuba.pdf", "Sieht in der App niemand")]);
  });

  test("fehlendes Level „Normal“ nur bei Noten", async () => {
    const withoutNormal = { ...reference, levels: [{ id: 3, name: "Leicht" }] };
    const withSheets = await runCheck([pdf("Noten/Alba - Tuba.pdf"), pdf("Noten/Alba - Tuba Leicht.pdf")], { reference: withoutNormal });
    assert.deepEqual(withSheets.messages, [message("error", "missing_default_level", null, "Level „Normal“ fehlt in der Datenbank")]);
    assert.deepEqual(
      withSheets.sheet_music.map(({ level_name }) => level_name),
      ["Leicht"],
    );
    const withoutSheets = await runCheck([mp3("Playbacks/Alba.mp3")], { reference: withoutNormal });
    assert.deepEqual(messagesWithCode(withoutSheets, "missing_default_level"), []);
  });

  test("Stimmung aus mehreren Wörtern wird nicht erkannt", async () => {
    const result = await onlySheet("Horn in F tief", {
      reference: { ...reference, parts: [...reference.parts, { id: 140, name: "Horn", transposition: "F tief" }] },
    });
    assert.deepEqual(result.messages, [unknownPart("Horn in F tief", "Noten/Alba - Horn in F tief.pdf", "Horn in F tief")]);
    assert.deepEqual(result.sheet_music, []);
  });

  test("doppelte Stimmen-Zeile in der Referenz", async () => {
    const result = await onlySheet("Tuba in C", {
      reference: { ...reference, parts: [...reference.parts, { id: 132, name: "Tuba", transposition: "C" }] },
    });
    assert.deepEqual(
      result.messages.map(({ code }) => code),
      ["unknown_part"],
    );
  });
});

describe("Timestamps im Detail", () => {
  const run = (lines, duration) => runCheck([...playbackWithTimestamps("Normal", lines, duration), countIn("4-4")]);

  test("gültige und ungültige Buchstaben", async () => {
    const result = await run(["A 00:00:00 4-4", "1 00:10:00 4-4", "12 00:20:00 4-4", "Coda 00:30:00 4-4", "AB 00:40:00 4-4", "Z 00:50:00 4-4"]);
    assert.deepEqual(result.messages, [
      message("error", "invalid_letter", timestampPath("Normal"), "„AB“ ist kein gültiger Buchstabe", { line: 5 }),
    ]);
    assert.deepEqual(result.playbacks, []);
  });

  for (const [label, text] of [
    ["Byte Order Mark", `${byteOrderMark}A 00:00:00 4-4${lineFeed}B 00:10:00 4-4`],
    ["CR-Zeilenenden", `A 00:00:00 4-4${carriageReturn}B 00:10:00 4-4${carriageReturn}`],
  ]) {
    test(`${label} wird gelesen`, async () => {
      const result = await runCheck([mp3(playbackPath("Normal")), rawText(timestampPath("Normal"), text), countIn("4-4")]);
      assert.deepEqual(result.messages, []);
      assert.deepEqual(
        lettersOf(result).map(({ name, position_ms }) => [name, position_ms]),
        [
          ["A", 0],
          ["B", 10000],
        ],
      );
    });
  }

  test("Byte Order Mark mitten im Text wird gemeldet", async () => {
    const text = `A 00:00:00 4-4${lineFeed}${byteOrderMark}B 00:10:00 4-4`;
    const result = await runCheck([mp3(playbackPath("Normal")), rawText(timestampPath("Normal"), text), countIn("4-4")]);
    assert.deepEqual(result.messages, [
      message("error", "invisible_character_text", timestampPath("Normal"), "Unsichtbares Zeichen in der Zeile", { line: 2 }),
    ]);
  });

  test("Zeit mit Punkten statt Doppelpunkten", async () => {
    const result = await run(["A 00:00:00 4-4", "B 00.10.00 4-4"]);
    assert.deepEqual(result.messages, [
      message("error", "invalid_timestamp_line", timestampPath("Normal"), "„00.10.00“ ist keine Zeit (MM:SS:FF)", { line: 2 }),
    ]);
  });

  test("Tabs und Einrückung", async () => {
    const result = await run([`  A${tab}00:00:00  4-4  `, "B 00:10:00 4-4"]);
    assert.deepEqual(result.messages, []);
    assert.equal(lettersOf(result)[0].count_in, "4-4");
  });

  test("Zeit mit zu vielen Ziffern", async () => {
    const result = await run(["A 00:00:001 4-4"]);
    assert.deepEqual(result.messages, [
      message("error", "invalid_timestamp_line", timestampPath("Normal"), "„00:00:001“ ist keine Zeit (MM:SS:FF)", { line: 1 }),
      unusedCountIn("4-4"),
    ]);
  });

  test("59 Sekunden sind gültig", async () => {
    const result = await run(["A 00:00:00 4-4", "B 00:59:29 4-4"]);
    assert.deepEqual(result.messages, []);
    assert.equal(lettersOf(result)[1].position_ms, 59967);
  });

  test("unlesbare MP3 ohne TXT", async () => {
    const result = await runCheck([mp3("Playbacks/Alba.mp3", null)]);
    assert.deepEqual(result.messages, [
      message("error", "invalid_file_content", "Playbacks/Alba.mp3", "MP3 nicht lesbar"),
      missingTimestamps("Playbacks/Alba.mp3"),
    ]);
    assert.deepEqual(result.playbacks, []);
  });

  test("unlesbare MP3 mit TXT", async () => {
    const result = await run(["A 00:00:00 4-4", "B 00:10:00 4-4"], null);
    assert.deepEqual(result.messages, [message("error", "invalid_file_content", playbackPath("Normal"), "MP3 nicht lesbar")]);
    assert.deepEqual(result.playbacks, []);
    assert.equal(result.timestamp_pairs.length, 1);
  });

  test("unvollständige Zeile nach gültiger Zeile", async () => {
    const result = await run(["A 00:00:00 4-4", "B 00:10"]);
    assert.deepEqual(result.messages, [
      message("error", "invalid_timestamp_line", timestampPath("Normal"), "Zeile unvollständig (Buchstabe, Zeit, Einzähler)", { line: 2 }),
    ]);
    assert.deepEqual(result.playbacks, []);
  });

  test("nur eine unvollständige Zeile", async () => {
    const result = await run(["B 00:10"]);
    assert.deepEqual(result.messages, [
      message("error", "invalid_timestamp_line", timestampPath("Normal"), "Zeile unvollständig (Buchstabe, Zeit, Einzähler)", { line: 1 }),
      unusedCountIn("4-4"),
    ]);
  });

  test("leere TXT liefert kein Playback", async () => {
    const result = await runCheck([...playbackWithTimestamps("Normal", [])]);
    assert.deepEqual(
      result.messages.map(({ code }) => code),
      ["empty_timestamps"],
    );
    assert.deepEqual(result.playbacks, []);
  });

  for (const [label, lines, duration, code, text, line] of [
    ["ungültiger Buchstabe", ["A 00:00:00 4-4", "Ä 00:10:00 4-4"], undefined, "invalid_letter", "„Ä“ ist kein gültiger Buchstabe", 2],
    ["gleiche Position", ["A 00:00:00 4-4", "B 00:00:00 4-4"], undefined, "duplicate_position", "„B“ an gleicher Stelle wie „A“", 2],
    ["nicht aufsteigend", timestampLines([["A", 0], ["B", 20], ["C", 10]]), undefined, "letters_not_ascending", "„C“ liegt zeitlich vor „B“", 3],
    ["nach MP3-Ende", timestampLines([["A", 0], ["B", 10]]), 5000, "letter_after_end", "„B“ nach MP3-Ende (0:05)", 2],
  ]) {
    test(`${label} macht das Playback unbrauchbar`, async () => {
      const result = await run(lines, duration);
      assert.deepEqual(result.messages, [message("error", code, timestampPath("Normal"), text, { line })]);
      assert.deepEqual(result.playbacks, []);
    });
  }

  for (const [duration, time, end] of [
    [150400, "02:40:00", "2:30"],
    [120000, "02:10:00", "2:00"],
    [59000, "01:10:00", "0:59"],
  ]) {
    test(`MP3-Ende ${end} in der Meldung`, async () => {
      const result = await run(["A 00:00:00 4-4", `B ${time} 4-4`], duration);
      assert.deepEqual(result.messages, [
        message("error", "letter_after_end", timestampPath("Normal"), `„B“ nach MP3-Ende (${end})`, { line: 2 }),
      ]);
    });
  }

  test("zweiter Buchstabe vor dem ersten", async () => {
    const result = await run(["A 00:10:00 4-4", "B 00:05:00 4-4"]);
    assert.deepEqual(result.messages, [
      message("error", "letters_not_ascending", timestampPath("Normal"), "„B“ liegt zeitlich vor „A“", { line: 2 }),
      message("warning", "first_letter_not_at_start", timestampPath("Normal"), "„A“ beginnt nicht bei 0:00", { line: 1 }),
    ]);
    assert.deepEqual(result.playbacks, []);
  });

  test("Buchstabe eine halbe Sekunde nach dem MP3-Ende", async () => {
    const result = await run(["A 00:00:00 4-4", "B 00:10:15 4-4"], 10000);
    assert.deepEqual(result.messages, [
      message("error", "letter_after_end", timestampPath("Normal"), "„B“ nach MP3-Ende (0:10)", { line: 2 }),
    ]);
    assert.deepEqual(result.playbacks, []);
  });

  test("Buchstaben einen Frame auseinander sind erlaubt", async () => {
    const result = await run(["A 00:00:00 4-4", "B 00:00:01 4-4"]);
    assert.deepEqual(result.messages, []);
    assert.deepEqual(
      lettersOf(result).map(({ name, position_ms }) => [name, position_ms]),
      [
        ["A", 0],
        ["B", 33],
      ],
    );
  });

  test("Fehler beim 51. Buchstaben wird noch gefunden", async () => {
    const lines = Array.from({ length: 51 }, (_, index) => {
      const seconds = index * 10;
      const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}:00`;
      return `${index + 1} ${time} ${index === 50 ? "5-4" : "4-4"}`;
    });
    const result = await run(lines, 600000);
    assert.deepEqual(result.messages, [
      message("error", "unknown_count_in", timestampPath("Normal"), "Einzähler „5-4“ fehlt", { line: 51 }),
    ]);
    assert.deepEqual(result.playbacks, []);
  });

  test("Buchstabe genau am MP3-Ende ist erlaubt", async () => {
    const result = await run(timestampLines([["A", 0], ["B", 10]]), 10000);
    assert.deepEqual(result.messages, []);
    assert.equal(result.playbacks.length, 1);
  });

  test("Zeilen nur aus Leerzeichen oder Tabs werden übersprungen", async () => {
    const result = await run(["A 00:00:00 4-4", "   ", tab, "B 00:10:00 4-4"]);
    assert.deepEqual(result.messages, []);
    assert.deepEqual(
      lettersOf(result).map(({ name, position_ms }) => [name, position_ms]),
      [
        ["A", 0],
        ["B", 10000],
      ],
    );
  });

  test("Fehler in einer umbenannten TXT tragen den Originalpfad", async () => {
    const result = await runCheck(
      [
        mp3("Playbacks/Alab - lauter.mp3"),
        txt("Playbacks/Timestamps/Alab - lauter.txt", ["A 00:00:00 4-4", "B 00:10"]),
        countIn("4-4"),
      ],
      {
        renames: {
          "Playbacks/Alab - lauter.mp3": "Playbacks/Alba - lauter.mp3",
          "Playbacks/Timestamps/Alab - lauter.txt": "Playbacks/Timestamps/Alba - lauter.txt",
        },
      },
    );
    assert.deepEqual(result.messages, [
      message("error", "invalid_timestamp_line", "Playbacks/Timestamps/Alab - lauter.txt", "Zeile unvollständig (Buchstabe, Zeit, Einzähler)", {
        line: 2,
      }),
    ]);
  });

  test("dreistellige Minuten sind keine Zeit", async () => {
    const result = await run(["A 00:00:00 4-4", "B 100:00:00 4-4"]);
    assert.deepEqual(result.messages, [
      message("error", "invalid_timestamp_line", timestampPath("Normal"), "„100:00:00“ ist keine Zeit (MM:SS:FF)", { line: 2 }),
    ]);
  });

  test("erster Buchstabe eine halbe Sekunde nach dem Anfang", async () => {
    const result = await run(["A 00:00:15 4-4"]);
    assert.deepEqual(result.messages, [
      message("warning", "first_letter_not_at_start", timestampPath("Normal"), "„A“ beginnt nicht bei 0:00", { line: 1 }),
    ]);
    assert.equal(lettersOf(result)[0].position_ms, 500);
  });
});

describe("Varianten im Detail", () => {
  const variantFiles = (variants) => [
    ...variants.flatMap(([type, lines]) => playbackWithTimestamps(type, lines)),
    countIn("4-4"),
  ];
  const timeWarning = (type, line, text) =>
    message("warning", "letter_time_differs_between_variants", timestampPath(type), text, { line });
  const differWarning = (type, text) => message("warning", "letters_differ_between_variants", timestampPath(type), text);

  test("Toleranz von genau drei Sekunden und Rundung der Anzeige", async () => {
    const base = ["A 00:00:00 4-4", "B 00:10:00 4-4", "C 00:20:00 4-4", "D 00:30:00 4-4", "E 00:40:00 4-4"];
    const withC = (time) => base.map((line) => (line.startsWith("C ") ? `C ${time} 4-4` : line));
    const result = await runCheck(
      variantFiles([
        ["Normal", base],
        ["langsamer", withC("00:23:00")],
        ["lauter", withC("00:23:12")],
        ["ohne Drums", withC("00:16:15")],
      ]),
    );
    assert.deepEqual(result.messages, [
      timeWarning("lauter", 3, "„C“ bei 0:23, erwartet ~0:20"),
      timeWarning("ohne Drums", 3, "„C“ bei 0:17, erwartet ~0:20"),
    ]);
  });

  for (const [label, normal, slow, expected] of [
    ["stark zusammengedrückte Nachbarn", [["A", 0], ["B", 9], ["C", 10]], [["A", 0], ["B", 3], ["C", 8]], []],
    ["mittlerer Buchstabe", [["A", 0], ["B", 10], ["C", 20]], [["A", 0], ["B", 15], ["C", 20]], [[2, "„B“ bei 0:15, erwartet ~0:10"]]],
    ["Median der Abstände", [["A", 0], ["B", 10], ["C", 12], ["D", 18]], [["A", 0], ["B", 10], ["C", 16], ["D", 17]], [[3, "„C“ bei 0:16, erwartet ~0:12"]]],
    ["früher Ausreißer", [["A", 0], ["B", 7], ["C", 13], ["D", 25]], [["A", 0], ["B", 4], ["C", 15], ["D", 28]], [[2, "„B“ bei 0:04, erwartet ~0:08"]]],
    ["innerhalb der Toleranz", [["A", 0], ["B", 1], ["C", 7], ["D", 16]], [["A", 0], ["B", 1], ["C", 4], ["D", 19]], []],
    ["doppelte Referenzzeit", [["A", 0], ["B", 0], ["C", 6], ["D", 17]], [["A", 0], ["B", 1], ["C", 10], ["D", 16]], [[3, "„C“ bei 0:10, erwartet ~0:06"]]],
    ["gleiche Referenzzeiten am Rand", [["A", 0], ["B", 12], ["C", 12], ["D", 23]], [["A", 0], ["B", 17], ["C", 22], ["D", 34]], []],
    ["rückläufige Referenz mit drei Buchstaben", [["A", 0], ["B", 10], ["C", 8]], [["A", 0], ["B", 8], ["C", 9]], []],
    ["rückläufige Referenz am Ende", [["A", 0], ["B", 4], ["C", 7], ["D", 4]], [["A", 0], ["B", 1], ["C", 1], ["D", 2]], []],
    ["rückläufige Referenz in der Mitte", [["A", 0], ["B", 11], ["C", 5], ["D", 11]], [["A", 0], ["B", 17], ["C", 17], ["D", 18]], []],
  ]) {
    test(`Zeitvergleich: ${label}`, async () => {
      const result = await runCheck(
        variantFiles([
          ["Normal", timestampLines(normal)],
          ["langsamer", timestampLines(slow)],
        ]),
      );
      assert.deepEqual(
        messagesWithCode(result, "letter_time_differs_between_variants"),
        expected.map(([line, text]) => timeWarning("langsamer", line, text)),
      );
    });
  }

  const spaced = (letters) => timestampLines(letters.map((letter, index) => [letter, index * 10]));
  for (const [normal, slow, text] of [
    ["ACF", "AEF", "Fehlt „C“, zusätzlich „E“ (vgl. „Normal“)"],
    ["DF", "AD", "Fehlt „F“, zusätzlich „A“ (vgl. „Normal“)"],
    ["ACEF", "EF", "Fehlt „A“, „C“ (vgl. „Normal“)"],
    ["BD", "BCDF", "Zusätzlich „C“, „F“ (vgl. „Normal“)"],
    ["EF", "BCEF", "Zusätzlich „B“, „C“ (vgl. „Normal“)"],
  ]) {
    test(`Buchstabenvergleich ${normal} gegen ${slow}`, async () => {
      const result = await runCheck(
        variantFiles([
          ["Normal", spaced([...normal])],
          ["langsamer", spaced([...slow])],
        ]),
      );
      assert.deepEqual(messagesWithCode(result, "letters_differ_between_variants"), [differWarning("langsamer", text)]);
    });
  }

  test("vertauschte Buchstaben", async () => {
    const result = await runCheck(
      variantFiles([
        ["Normal", ["B 00:00:00 4-4", "D 00:10:00 4-4"]],
        ["langsamer", ["D 00:00:00 4-4", "B 00:10:00 4-4"]],
      ]),
    );
    assert.deepEqual(result.messages, [differWarning("langsamer", "Fehlt „B“, zusätzlich „B“ (vgl. „Normal“)")]);
  });

  test("wiederholte Buchstaben nach D.S.", async () => {
    const result = await runCheck(
      variantFiles([
        ["Normal", ["D.S. 00:00:00 4-4", "C 00:10:00 4-4"]],
        ["langsamer", ["C 00:00:00 4-4", "B 00:10:00 4-4", "D.S. 00:20:00 4-4", "C 00:30:00 4-4"]],
      ]),
    );
    assert.deepEqual(result.messages, [differWarning("langsamer", "Zusätzlich „C“, „B“ (vgl. „Normal“)")]);
  });

  test("mehrstellige Buchstaben verschmelzen beim Vergleich nicht", async () => {
    const result = await runCheck(
      variantFiles([
        ["Normal", ["1 00:00:00 4-4", "12 00:10:00 4-4"]],
        ["langsamer", ["11 00:00:00 4-4", "2 00:10:00 4-4"]],
      ]),
    );
    assert.deepEqual(result.messages, [
      differWarning("langsamer", `Andere Buchstaben als Normal:${lineFeed}Hier: 11 2${lineFeed}Normal: 1 12`),
    ]);
  });

  test("Langform ab drei Unterschieden", async () => {
    const result = await runCheck(
      variantFiles([
        ["Normal", spaced([..."ABCD"])],
        ["langsamer", spaced([..."ADE"])],
      ]),
    );
    assert.deepEqual(messagesWithCode(result, "letters_differ_between_variants"), [
      differWarning("langsamer", `Andere Buchstaben als Normal:${lineFeed}Hier: A D E${lineFeed}Normal: A B C D`),
    ]);
  });

  test("Zusatz „Lauter“ gehört zur Gruppe Normal", async () => {
    const result = await runCheck(
      variantFiles([
        ["Normal", spaced([..."ABCD"])],
        ["Lauter", spaced(["A"])],
      ]),
    );
    assert.deepEqual(messagesWithCode(result, "letters_differ_between_variants"), [
      differWarning("Lauter", `Andere Buchstaben als Normal:${lineFeed}Hier: A${lineFeed}Normal: A B C D`),
    ]);
  });

  test("Typ ohne Trenner, der auf einen Zusatz endet, ist eine eigene Gruppe", async () => {
    const result = await runCheck(
      variantFiles([
        ["A lauter", spaced([..."AB"])],
        ["A laute", spaced(["A"])],
      ]),
    );
    assert.deepEqual(messagesWithCode(result, "letters_differ_between_variants"), []);
  });

  test("Teil mit Instrument als letztem Segment ist eine eigene Gruppe", async () => {
    const result = await runCheck(
      variantFiles([
        ["Part A", spaced([..."AB"])],
        ["Part A - Tuba", spaced(["A"])],
      ]),
    );
    assert.deepEqual(messagesWithCode(result, "letters_differ_between_variants"), []);
  });

  test("verschachtelte Zusätze gehören zur Gruppe des Teils", async () => {
    const result = await runCheck(
      variantFiles([
        ["Part A", spaced([..."AB"])],
        ["Part A - lauter - langsamer", spaced(["A"])],
      ]),
    );
    assert.deepEqual(messagesWithCode(result, "letters_differ_between_variants"), [
      differWarning("Part A - lauter - langsamer", "Fehlt „B“ (vgl. „Part A“)"),
    ]);
  });
});

describe("Einzähler im Detail", () => {
  test("Einzähler mit Leerzeichen im Namen", async () => {
    const result = await runCheck([...playbackWithTimestamps("Normal", ["A 00:00:00 Prelude 4-4"]), countIn("Prelude 4-4")]);
    assert.deepEqual(result.messages, []);
    assert.equal(lettersOf(result)[0].count_in, "Prelude 4-4");
  });

  test("kein Songname-Hinweis ohne Leerzeichen vor dem Einzähler", async () => {
    const result = await runCheck([...playbackWithTimestamps("Normal", ["A 00:00:00 4-4"]), countIn("Prelude4-4")]);
    assert.deepEqual(result.messages, [
      message("error", "unknown_count_in", timestampPath("Normal"), "Einzähler „4-4“ fehlt", { line: 1 }),
      unusedCountIn("Prelude4-4"),
    ]);
  });

  test("Songname-Hinweis nennt den ersten passenden Einzähler", async () => {
    const result = await runCheck([
      ...playbackWithTimestamps("Normal", ["A 00:00:00 4-4"]),
      countIn("Prelude 4-4"),
      countIn("Teil 4-4"),
    ]);
    assert.deepEqual(result.messages, [
      message("error", "unknown_count_in", timestampPath("Normal"), "Einzähler „4-4“ fehlt – Songname zu kurz? Es gibt „Prelude 4-4“", {
        line: 1,
      }),
      unusedCountIn("Prelude 4-4"),
      unusedCountIn("Teil 4-4"),
    ]);
  });

  test("Songname-Hinweis auch bei großgeschriebenem Einzähler", async () => {
    const result = await runCheck([...playbackWithTimestamps("Normal", ["A 00:00:00 Auftakt"]), countIn("Prelude Auftakt")]);
    assert.deepEqual(result.messages, [
      message("error", "unknown_count_in", timestampPath("Normal"), "Einzähler „Auftakt“ fehlt – Songname zu kurz? Es gibt „Prelude Auftakt“", {
        line: 1,
      }),
      unusedCountIn("Prelude Auftakt"),
    ]);
  });

  test("„langsam“ im Songnamen macht ein Playback nicht langsam", async () => {
    const name = "Langsamer Walzer";
    const result = await runCheck(
      [
        mp3(`Playbacks/${name}.mp3`),
        txt(`Playbacks/Timestamps/${name}.txt`, ["A 00:00:00 4-4"]),
        mp3(`Playbacks/Einzaehler/${name} 4-4.mp3`, 1500),
        mp3(`Playbacks/Einzaehler/${name} 4-4 langsamer.mp3`, 1500),
      ],
      { songName: name },
    );
    assert.deepEqual(result.messages, [
      message("error", "unused_count_in", `Playbacks/Einzaehler/${name} 4-4 langsamer.mp3`, "Von keiner TXT benutzt"),
    ]);
  });

  test("Tempo-Warnung bei großgeschriebenem Einzähler-Namen", async () => {
    const result = await runCheck([...playbackWithTimestamps("Normal", ["A 00:00:00 4-4 Langsam"]), countIn("4-4"), countIn("4-4 Langsam")]);
    assert.deepEqual(result.messages, [
      message(
        "warning",
        "count_in_tempo_mismatch",
        timestampPath("Normal"),
        "Normales Playback mit Einzähler „4-4 Langsam“ bei „A“, gemeint „4-4“?",
        { line: 1 },
      ),
      unusedCountIn("4-4"),
    ]);
  });

  test("bei mehreren langsamen Gegenstücken wird das erste vorgeschlagen", async () => {
    const result = await runCheck([
      ...playbackWithTimestamps("langsamer", ["A 00:00:00 4-4"]),
      countIn("4-4"),
      countIn("4-4 langsamer"),
      countIn("4-4_langsamer"),
    ]);
    assert.deepEqual(result.messages, [
      message(
        "warning",
        "count_in_tempo_mismatch",
        timestampPath("langsamer"),
        "Langsames Playback mit Einzähler „4-4“ bei „A“, gemeint „4-4 langsamer“?",
        { line: 1 },
      ),
      unusedCountIn("4-4 langsamer"),
      unusedCountIn("4-4_langsamer"),
    ]);
  });

  test("Einzähler in der TXT in anderer Schreibweise", async () => {
    const result = await runCheck([...playbackWithTimestamps("Normal", ["A 00:00:00 AUFTAKT"]), countIn("Auftakt")]);
    assert.deepEqual(result.messages, []);
    assert.equal(lettersOf(result)[0].count_in, "Auftakt");
  });

  test("zwei Einzähler-Dateien mit gleichem Namen", async () => {
    const result = await runCheck([...playbackWithTimestamps("Normal", ["A 00:00:00 Auftakt"]), countIn("Auftakt"), countIn("AUFTAKT")]);
    assert.deepEqual(result.messages, [
      message("error", "invalid_name_pattern", countInPath("AUFTAKT"), "Gleicher Name wie „Alba Auftakt.mp3“", {
        related: countInPath("Auftakt"),
      }),
    ]);
    assert.deepEqual(
      result.count_ins.map(({ name }) => name),
      ["Auftakt"],
    );
  });

  test("unlesbarer Einzähler", async () => {
    const result = await runCheck([...playbackWithTimestamps("Normal", ["A 00:00:00 4-4"]), countIn("4-4", null)]);
    assert.deepEqual(result.messages, [
      message("error", "invalid_file_content", countInPath("4-4"), "MP3 nicht lesbar"),
      message("error", "unknown_count_in", timestampPath("Normal"), "Einzähler „4-4“ fehlt", { line: 1 }),
    ]);
    assert.deepEqual(result.count_ins, []);
  });

  for (const slowName of ["langsamer 4-4", "4-4_langsamer", "langsam 4-4 langsamer"]) {
    test(`normales Playback mit Einzähler „${slowName}“`, async () => {
      const result = await runCheck([
        ...playbackWithTimestamps("Normal", [`A 00:00:00 ${slowName}`]),
        countIn("4-4"),
        countIn(slowName),
      ]);
      assert.deepEqual(result.messages, [
        message(
          "warning",
          "count_in_tempo_mismatch",
          timestampPath("Normal"),
          `Normales Playback mit Einzähler „${slowName}“ bei „A“, gemeint „4-4“?`,
          { line: 1 },
        ),
        unusedCountIn("4-4"),
      ]);
    });
  }

  test("Zusatz „Langsamer“ in Großschreibung ist langsam", async () => {
    const result = await runCheck([...playbackWithTimestamps("Langsamer", ["A 00:00:00 4-4"]), countIn("4-4"), countIn("4-4 Langsamer")]);
    assert.deepEqual(result.messages, [
      message(
        "warning",
        "count_in_tempo_mismatch",
        timestampPath("Langsamer"),
        "Langsames Playback mit Einzähler „4-4“ bei „A“, gemeint „4-4 Langsamer“?",
        { line: 1 },
      ),
      unusedCountIn("4-4 Langsamer"),
    ]);
  });
});

describe("Instrumente im Zusatz im Detail", () => {
  test("„ohne Drums“ schlägt nur Instrumente vor, die mit „drum“ beginnen", async () => {
    const result = await runCheck([mp3(playbackPath("ohne Drums"))], {
      reference: {
        ...reference,
        instruments: [
          { id: 1, name: "Drum Set", transposition: "" },
          { id: 2, name: "Kickdrum", transposition: "" },
          { id: 3, name: "Drumcomputer", transposition: "" },
        ],
      },
    });
    assert.deepEqual(result.playbacks[0].suggested_instrument_ids, [1, 3]);
  });

  test("Tippfehler, der auch einer Familie ähnelt, meldet nur den Tippfehler", async () => {
    const result = await runCheck([mp3(playbackPath("Ltsaxophon"))]);
    assert.deepEqual(result.messages, [
      message("warning", "unknown_type_instrument", playbackPath("Ltsaxophon"), "Tippfehler im Zusatz: „Ltsaxophon“", {
        suggestion: "Playbacks/Alba - Altsaxophon.mp3",
        suggestionLabel: "Altsaxophon",
      }),
      missingTimestamps(playbackPath("Ltsaxophon")),
    ]);
  });

  test("unterschiedliches letztes Zeichen bildet keine Familie", async () => {
    const result = await runCheck([mp3(playbackPath("Horn1"))], {
      reference: {
        ...reference,
        instruments: [
          ...reference.instruments,
          { id: 50, name: "Althorn1", transposition: "Es" },
          { id: 51, name: "Tenorhorn2", transposition: "B" },
        ],
      },
    });
    assert.deepEqual(result.messages, [missingTimestamps(playbackPath("Horn1"))]);
  });

  test("Tippfehler beim ersten Instrument der Referenz", async () => {
    const result = await runCheck([mp3(playbackPath("Altsaxofon"))]);
    assert.deepEqual(result.messages, [
      message("warning", "unknown_type_instrument", playbackPath("Altsaxofon"), "Tippfehler im Zusatz: „Altsaxofon“", {
        suggestion: "Playbacks/Alba - Altsaxophon.mp3",
        suggestionLabel: "Altsaxophon",
      }),
      missingTimestamps(playbackPath("Altsaxofon")),
    ]);
  });

  test("Instrumentnamen aus mehreren großgeschriebenen Wörtern", async () => {
    const result = await runCheck([mp3("Playbacks/Alba - Tuba.mp3")], {
      reference: {
        ...reference,
        instruments: [
          ...reference.instruments,
          { id: 40, name: "Bass Klarinette", transposition: "B" },
          { id: 41, name: "Kontra Klarinette", transposition: "Es" },
        ],
      },
    });
    assert.deepEqual(result.messages, [missingTimestamps("Playbacks/Alba - Tuba.mp3")]);
    assert.equal(result.playbacks[0].type, "Tuba");
  });

  test("Familienmitglieder sind deutsch sortiert", async () => {
    const result = await runCheck([mp3(playbackPath("Pauke"))], {
      reference: {
        ...reference,
        instruments: [
          ...reference.instruments,
          { id: 30, name: "Pedalpauke", transposition: "" },
          { id: 31, name: "Ölpauke", transposition: "" },
        ],
      },
    });
    const [ambiguous] = messagesWithCode(result, "ambiguous_type_instrument");
    assert.equal(ambiguous.text, "„Pauke“ ist kein genaues Instrument, gemeint ist eines von: Handpauke, Kesselpauke, Ölpauke, Pedalpauke");
  });

  test("Ähnlichkeit 0,75 zu einer Familie ist noch nicht mehrdeutig", async () => {
    const result = await runCheck([mp3(playbackPath("Saxofon"))]);
    assert.deepEqual(messagesWithCode(result, "ambiguous_type_instrument"), []);
  });

  test("Instrument mit zwei Stimmungen steht in der Familie nur einmal", async () => {
    const result = await runCheck([mp3(playbackPath("Saxophon"))], {
      reference: { ...reference, instruments: [...reference.instruments, { id: 20, name: "Tenorsaxophon", transposition: "C" }] },
    });
    const [ambiguous] = messagesWithCode(result, "ambiguous_type_instrument");
    assert.equal(ambiguous.text, "„Saxophon“ ist kein genaues Instrument, gemeint ist eines von: Altsaxophon, Baritonsaxophon, Tenorsaxophon");
    assert.equal(ambiguous.suggestion, "Playbacks/Alba - Altsaxophon.mp3");
  });

  test("Familie umfasst nur Instrumente, die auf das Wort enden", async () => {
    const result = await runCheck([mp3(playbackPath("Pauke"))], {
      reference: { ...reference, instruments: [...reference.instruments, { id: 21, name: "Paukenset", transposition: "" }] },
    });
    const [ambiguous] = messagesWithCode(result, "ambiguous_type_instrument");
    assert.equal(ambiguous.text, "„Pauke“ ist kein genaues Instrument, gemeint ist eines von: Handpauke, Kesselpauke");
  });

  test("gemeinsames Wortende aus vier Buchstaben bildet keine Familie", async () => {
    const result = await runCheck([mp3(playbackPath("Horn"))], {
      reference: {
        ...reference,
        instruments: [
          { id: 1, name: "Althorn", transposition: "Es" },
          { id: 2, name: "Tenorhorn", transposition: "B" },
        ],
      },
    });
    assert.deepEqual(result.messages, [missingTimestamps(playbackPath("Horn"))]);
  });
});

describe("Ergebnis bei umbenannten Dateien", () => {
  test("Pfade bleiben in Originalschreibweise", async () => {
    const result = await runCheck(
      [
        mp3("Playbacks/Alab.mp3"),
        mp3("Playbacks/Alab - lauter.mp3"),
        txt("Playbacks/Timestamps/Alab - lauter.txt", ["A 00:00:00 4-4"]),
        mp3("Playbacks/Einzaehler/Alab 4-4.mp3", 1500),
      ],
      {
        renames: {
          "Playbacks/Alab.mp3": "Playbacks/Alba.mp3",
          "Playbacks/Alab - lauter.mp3": "Playbacks/Alba - lauter.mp3",
          "Playbacks/Timestamps/Alab - lauter.txt": "Playbacks/Timestamps/Alba - lauter.txt",
          "Playbacks/Einzaehler/Alab 4-4.mp3": "Playbacks/Einzaehler/Alba 4-4.mp3",
        },
      },
    );
    assert.deepEqual(result.messages, [missingTimestamps("Playbacks/Alab.mp3")]);
    assert.deepEqual(
      result.playbacks.map(({ path }) => path),
      ["Playbacks/Alab.mp3", "Playbacks/Alab - lauter.mp3"],
    );
    assert.deepEqual(result.count_ins, [{ path: "Playbacks/Einzaehler/Alab 4-4.mp3", name: "4-4", duration_ms: 1500 }]);
    assert.deepEqual(result.timestamp_pairs, [
      { audio_path: "Playbacks/Alab - lauter.mp3", timestamps_path: "Playbacks/Timestamps/Alab - lauter.txt" },
    ]);
  });

  test("Songname bleibt ungekürzt", async () => {
    const result = await runCheck([mp3("Playbacks/Alba .mp3")], { songName: "Alba " });
    assert.equal(result.song_name, "Alba ");
  });
});

describe("formatPosition im Detail", () => {
  for (const [milliseconds, text] of [
    [59000, "00:59.000"],
    [120000, "02:00.000"],
    [600000, "10:00.000"],
  ]) {
    test(`${milliseconds} ms`, () => {
      assert.equal(formatPosition(milliseconds), text);
    });
  }
});

describe("hasInvisible im Detail", () => {
  for (const code of [0x0000, 0x0008, 0x000b, 0x000c, 0x000e, 0x001b, 0x001f, 0x007f, 0x0085, 0x009f, 0xfeff]) {
    test(`U+${code.toString(16).padStart(4, "0")} ist unsichtbar`, () => {
      assert.equal(hasInvisible(`A${String.fromCharCode(code)}B`), true);
    });
  }

  for (const character of [tab, lineFeed, carriageReturn, " ", noBreakSpace]) {
    test(`U+${character.charCodeAt(0).toString(16).padStart(4, "0")} ist sichtbar`, () => {
      assert.equal(hasInvisible(`A${character}B`), false);
    });
  }
});
