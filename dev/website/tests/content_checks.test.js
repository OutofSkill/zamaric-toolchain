import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { contentCheckNames, evaluateContent, findingKey } from "../static/content_checks.js";

const now = new Date("2026-11-24T12:00:00Z");
const releaseAt = "2026-11-26T03:00:00+00:00";
const waitingUntil = "2026-12-01T03:00:00+00:00";

const instruments = [
  { id: 1, name: "Trompete", transposition: "B" },
  { id: 2, name: "Posaune", transposition: "C" },
  { id: 3, name: "Altsaxophon", transposition: "Es" },
  { id: 4, name: "Tenorsaxophon", transposition: "B" },
  { id: 5, name: "DrumSet", transposition: "" },
];

let nextId = 1000;

const letter = (name, seconds, countInId = 10) => ({ name, position_ms: seconds * 1000, count_in_id: countInId });
const countIn = (id, name, extra = {}) => ({ id, name, duration_ms: 2000, release_at: null, replaces_id: null, ...extra });
const playback = (type, letters, extra = {}) => ({
  id: nextId++,
  type,
  duration_ms: 300000,
  instrument_mode: "all",
  instrument_ids: [],
  release_at: null,
  replaces_id: null,
  letters,
  ...extra,
});
const sheet = (partId, levelId, extra = {}) => ({ id: nextId++, part_id: partId, level_id: levelId, release_at: null, replaces_id: null, ...extra });
const song = (name, { playbacks = [], countIns = [countIn(10, "4-4")], sheetMusic = [], releaseAt: songReleaseAt = null } = {}) => ({
  id: nextId++,
  name,
  category_id: 1,
  release_at: songReleaseAt,
  count_ins: countIns,
  playbacks,
  sheet_music: sheetMusic,
});
const snapshot = (songs, { parts = [], instrumentParts = [] } = {}) => ({
  generated_at: now.toISOString(),
  categories: [{ id: 1, name: "Konzert", position: 0 }],
  levels: [{ id: 1, name: "Normal" }, { id: 2, name: "Leicht" }],
  instruments,
  parts,
  instrument_parts: instrumentParts,
  songs,
});
const evaluate = (songs, options) => evaluateContent(snapshot(songs, options), now);
const withCheck = (findings, check) => findings.filter((finding) => finding.check === check);
const startLetters = () => [letter("A", 0), letter("B", 10)];

describe("Inhaltsprüfung der Entwicklerseite", () => {
  test("kennt jede Prüfung genau einmal", () => {
    assert.equal(new Set(contentCheckNames).size, contentCheckNames.length);
    assert.equal(contentCheckNames.length, 10);
  });

  test("meldet einen Tippfehler im Zusatz mit Vorschlag", () => {
    const typo = playback("Trompte", startLetters());
    const [finding] = withCheck(evaluate([song("Alba", { playbacks: [typo] })]), "unknown_type_instrument");
    assert.equal(finding.severity, "warning");
    assert.equal(finding.row_id, typo.id);
    assert.equal(finding.subject, `playback:${typo.id}`);
    assert.equal(finding.target, "Playback „Trompte“");
    assert.equal(finding.detail, "Tippfehler im Zusatz: „Trompte“ → „Trompete“");
    assert.equal(finding.state, null);
  });

  test("meldet ein mehrdeutiges Instrument im Zusatz als Fehler", () => {
    const findings = evaluate([song("Alba", { playbacks: [playback("Saxophon", startLetters())] })]);
    const [finding] = withCheck(findings, "ambiguous_type_instrument");
    assert.equal(finding.severity, "error");
    assert.match(finding.detail, /^„Saxophon“ ist kein genaues Instrument, gemeint ist eines von: Altsaxophon, Tenorsaxophon → „Altsaxophon“$/);
  });

  test("warnt nur, wenn ein Instrument aus dem Zusatz das Playback nicht sieht", () => {
    const findings = evaluate([
      song("Für alle", { playbacks: [playback("Trompete", startLetters())] }),
      song("Nur Posaune", { playbacks: [playback("Trompete", startLetters(), { instrument_mode: "only", instrument_ids: [2] })] }),
      song("Mit Posaune", { playbacks: [playback("Trompete", startLetters(), { instrument_mode: "only", instrument_ids: [1, 2] })] }),
      song("Außer Trompete", { playbacks: [playback("Trompete", startLetters(), { instrument_mode: "except", instrument_ids: [1] })] }),
      song("Drums sehen", { playbacks: [playback("ohne Drums", startLetters())] }),
      song("Drums sehen nicht", { playbacks: [playback("ohne Drums", startLetters(), { instrument_mode: "except", instrument_ids: [5] })] }),
    ]);
    const visibility = withCheck(findings, "visibility_differs_from_type");
    assert.deepEqual(
      visibility.map((finding) => [finding.song_name, finding.detail]),
      [
        ["Außer Trompete", "Im Zusatz genannt, sieht es nicht: Trompete in B (für alle außer Trompete in B)"],
        ["Drums sehen nicht", "Im Zusatz genannt, sieht es nicht: DrumSet (für alle außer DrumSet)"],
        ["Nur Posaune", "Im Zusatz genannt, sieht es nicht: Trompete in B (nur für Posaune in C)"],
      ],
    );
    assert.ok(visibility.every((finding) => finding.severity === "warning"));
  });

  test("meldet ein Playback ohne Buchstaben und prüft dann keine Buchstaben", () => {
    const findings = evaluate([song("Alba", { playbacks: [playback("Normal", [])] })]);
    assert.deepEqual(
      findings.map((finding) => [finding.check, finding.detail]),
      [["playback_without_letters", "Keine Buchstaben"]],
    );
  });

  test("meldet doppelte Buchstaben, außer nach D.S. oder D.C.", () => {
    const findings = evaluate([
      song("Doppelt", { playbacks: [playback("Normal", [letter("A", 0), letter("B", 10), letter("A", 20)])] }),
      song("Sprung", { playbacks: [playback("Normal", [letter("A", 0), letter("B", 10), letter("D.S.", 20), letter("A", 30)])] }),
    ]);
    const duplicates = withCheck(findings, "duplicate_letter");
    assert.deepEqual(
      duplicates.map((finding) => [finding.song_name, finding.severity, finding.detail]),
      [["Doppelt", "error", "„A“ doppelt bei 0:20"]],
    );
  });

  test("meldet einen ersten Buchstaben, der nicht bei 0:00 beginnt", () => {
    const findings = evaluate([song("Alba", { playbacks: [playback("Normal", [letter("A", 5), letter("B", 10)])] })]);
    assert.deepEqual(
      withCheck(findings, "first_letter_not_at_start").map((finding) => finding.detail),
      ["„A“ beginnt nicht bei 0:00"],
    );
  });

  test("meldet einen Einzähler im falschen Tempo", () => {
    const findings = evaluate([
      song("Alba", {
        countIns: [countIn(10, "4-4"), countIn(11, "4-4 langsamer")],
        playbacks: [playback("langsamer", [letter("A", 0, 10), letter("B", 10, 11)])],
      }),
    ]);
    assert.deepEqual(
      withCheck(findings, "count_in_tempo_mismatch").map((finding) => finding.detail),
      ["Langsames Playback mit Einzähler „4-4“ bei „A“, gemeint „4-4 langsamer“?"],
    );
  });

  test("vergleicht die Buchstaben der Varianten einer Gruppe", () => {
    const withoutDrums = playback("ohne Drums", [letter("A", 0), letter("C", 20)]);
    const findings = evaluate([
      song("Alba", { playbacks: [playback("Normal", [letter("A", 0), letter("B", 10), letter("C", 20)]), withoutDrums] }),
    ]);
    const [finding] = withCheck(findings, "letters_differ_between_variants");
    assert.equal(finding.row_id, withoutDrums.id);
    assert.equal(finding.target, "Playback „ohne Drums“");
    assert.equal(finding.detail, "Fehlt „B“ (vgl. „Normal“)");
  });

  test("meldet zeitlich verschobene Buchstaben einer Variante", () => {
    const seconds = [0, 60, 120, 180, 240];
    const names = ["A", "B", "C", "D", "E"];
    const findings = evaluate([
      song("Alba", {
        playbacks: [
          playback("Normal", names.map((name, index) => letter(name, seconds[index]))),
          playback("lauter", names.map((name, index) => letter(name, name === "C" ? 130 : seconds[index]))),
        ],
      }),
    ]);
    assert.deepEqual(
      withCheck(findings, "letter_time_differs_between_variants").map((finding) => finding.detail),
      ["„C“ bei 2:10, erwartet ~2:00"],
    );
  });

  test("meldet eine Stimme ohne Instrument einmal für alle Songs", () => {
    const parts = [
      { id: 20, name: "Akkordblatt", transposition: "C" },
      { id: 21, name: "Trompete", transposition: "B" },
      { id: 22, name: "Harfe", transposition: "" },
    ];
    const findings = evaluate(
      [
        song("Alba", { playbacks: [playback("Normal", startLetters())], sheetMusic: [sheet(20, 1), sheet(20, 2), sheet(21, 1)] }),
        song("Tequila", { playbacks: [playback("Normal", startLetters())], sheetMusic: [sheet(20, 1)] }),
      ],
      { parts, instrumentParts: [{ part_id: 21, instrument_id: 1 }] },
    );
    const partFindings = withCheck(findings, "part_without_viewers");
    assert.equal(partFindings.length, 1);
    assert.deepEqual(
      {
        song_id: partFindings[0].song_id,
        row_id: partFindings[0].row_id,
        subject: partFindings[0].subject,
        detail: partFindings[0].detail,
        usage: partFindings[0].usage,
        state: partFindings[0].state,
      },
      { song_id: null, row_id: 20, subject: "part:20", detail: "„Akkordblatt in C“", usage: "3 Notenblätter in 2 Songs", state: null },
    );
  });

  test("Schlüssel einer Stimme ohne Instrument ändert sich nicht mit der Zahl der Noten", () => {
    const parts = [{ id: 20, name: "Akkordblatt", transposition: "C" }];
    const one = withCheck(evaluate([song("Alba", { sheetMusic: [sheet(20, 1)] })], { parts }), "part_without_viewers");
    const two = withCheck(
      evaluate([song("Alba", { sheetMusic: [sheet(20, 1)] }), song("Tequila", { sheetMusic: [sheet(20, 1)] })], { parts }),
      "part_without_viewers",
    );
    assert.equal(one[0].usage, "1 Notenblatt in 1 Song");
    assert.equal(two[0].usage, "2 Notenblätter in 2 Songs");
    assert.equal(one[0].key, two[0].key);
  });

  test("vergleicht Namen in Unicode-Form NFC", () => {
    const decomposed = (text) => text.normalize("NFD");
    const flugelhorn = { id: 7, name: "Flügelhorn", transposition: "B" };
    const findings = evaluateContent(
      {
        ...snapshot([
          song(decomposed("Grüße"), {
            countIns: [countIn(10, decomposed("Zähler")), countIn(11, "Zähler langsamer")],
            playbacks: [
              playback(decomposed("Flügelhorn"), startLetters(), { instrument_mode: "only", instrument_ids: [1] }),
              playback("langsamer", [letter("A", 0, 10)]),
            ],
          }),
        ]),
        instruments: [...instruments, flugelhorn],
      },
      now,
    );
    assert.deepEqual(withCheck(findings, "unknown_type_instrument"), []);
    assert.deepEqual(
      withCheck(findings, "visibility_differs_from_type").map((finding) => [finding.song_name, finding.target, finding.detail]),
      [["Grüße", "Playback „Flügelhorn“", "Im Zusatz genannt, sieht es nicht: Flügelhorn in B (nur für Trompete in B)"]],
    );
    assert.deepEqual(
      withCheck(findings, "count_in_tempo_mismatch").map((finding) => finding.detail),
      ["Langsames Playback mit Einzähler „Zähler“ bei „A“, gemeint „Zähler langsamer“?"],
    );
  });

  test("prüft Songs mit wartender Änderung sichtbar und nach der Freigabe", () => {
    const normal = playback("Normal", [letter("A", 0), letter("B", 10), letter("A", 20)]);
    const normalPending = playback("Normal", [letter("A", 3), letter("B", 10), letter("C", 20)], { release_at: releaseAt, replaces_id: normal.id });
    const typo = playback("Trompte", startLetters());
    const added = playback("Posaune", [], { release_at: releaseAt });
    const findings = evaluate([song("Alba", { playbacks: [normal, normalPending, typo, added] })]);
    const summary = findings.map((finding) => [finding.check, finding.row_id, finding.state.kind, finding.state.release_at]);
    assert.deepEqual(summary, [
      ["duplicate_letter", normal.id, "fixed", releaseAt],
      ["unknown_type_instrument", typo.id, "visible", null],
      ["playback_without_letters", added.id, "coming", releaseAt],
      ["first_letter_not_at_start", normal.id, "coming", releaseAt],
    ]);
  });

  test("liest Einzähler einer wartenden Änderung über ihre ersetzte Zeile", () => {
    const pendingCountIn = countIn(12, "4-4", { release_at: releaseAt, replaces_id: 10 });
    const slow = playback("langsamer", [letter("A", 0, 11)]);
    const findings = evaluate([
      song("Alba", {
        countIns: [countIn(10, "4-4"), countIn(11, "4-4 langsamer"), pendingCountIn],
        playbacks: [slow, playback("langsamer", [letter("A", 0, 12)], { release_at: releaseAt, replaces_id: slow.id })],
      }),
    ]);
    assert.deepEqual(
      withCheck(findings, "count_in_tempo_mismatch").map((finding) => [finding.row_id, finding.state.kind, finding.detail]),
      [[slow.id, "coming", "Langsames Playback mit Einzähler „4-4“ bei „A“, gemeint „4-4 langsamer“?"]],
    );
  });

  test("prüft wartende Songs einmal und nennt den Freigabetag", () => {
    const findings = evaluate([
      song("Neu", { releaseAt: waitingUntil, playbacks: [playback("Normal", [])] }),
      song("Freigegeben", { releaseAt: "2026-11-01T03:00:00+00:00", playbacks: [playback("Normal", [])] }),
    ]);
    assert.deepEqual(
      findings.map((finding) => [finding.song_name, finding.state]),
      [
        ["Freigegeben", null],
        ["Neu", { kind: "waiting", release_at: waitingUntil }],
      ],
    );
  });

  test("Schlüssel hängt nur an Art, Prüfung, Betroffenem und Detail", () => {
    const [finding] = evaluate([song("Alba", { playbacks: [playback("Normal", [])] })]);
    assert.match(finding.key, /^[0-9a-f]{64}$/);
    assert.equal(findingKey(finding), finding.key);
    assert.equal(findingKey({ ...finding, state: { kind: "coming", release_at: releaseAt }, target: "anders", song_name: "anders" }), finding.key);
    assert.notEqual(findingKey({ ...finding, detail: "Anderes Detail" }), finding.key);
    assert.notEqual(findingKey({ ...finding, subject: "playback:1" }), finding.key);
    assert.notEqual(findingKey({ ...finding, check: "duplicate_letter" }), finding.key);
  });

  test("Schlüssel bleibt nach der Freigabe gleich", () => {
    const normal = playback("Normal", startLetters());
    const pending = playback("Normal", [letter("A", 3), letter("B", 10)], { release_at: releaseAt, replaces_id: normal.id });
    const before = withCheck(evaluate([song("Alba", { playbacks: [normal, pending] })]), "first_letter_not_at_start");
    const released = { ...normal, letters: pending.letters };
    const after = withCheck(evaluate([song("Alba", { playbacks: [released] })]), "first_letter_not_at_start");
    assert.equal(before[0].state.kind, "coming");
    assert.equal(after[0].state, null);
    assert.equal(after[0].key, before[0].key);
  });
});
