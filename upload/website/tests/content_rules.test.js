import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  bestMatch,
  countInTempoFindings,
  createTypeRules,
  duplicateLetterIndexes,
  firstLetterFinding,
  formatMinutes,
  instrumentFamilies,
  letterChanges,
  similarity,
  timingOutliers,
  variantFindings,
} from "../../../shared/content_rules.js";

const letter = (name, seconds, line = 1, countIn = "4-4") => ({ name, position_ms: seconds * 1000, line, count_in: countIn });
const lineFeed = String.fromCharCode(10);

describe("Gemeinsame Inhaltsregeln", () => {
  test("similarity ignoriert Groß-/Kleinschreibung", () => {
    assert.equal(similarity("Tuba", "tuba"), 1);
    assert.equal(similarity("Tubxy", "Tuba"), 0.6);
    assert.equal(similarity("", ""), 1);
  });

  test("bestMatch wählt den besten Treffer und keinen bei Gleichstand", () => {
    assert.equal(bestMatch("Trompete in Cc", ["Trompete in B", "Trompete in C"], 0.6), "Trompete in C");
    assert.equal(bestMatch("Trompete", ["Trompete in B", "Trompete in C"], 0.6), null);
    assert.equal(bestMatch("xyz", ["Tuba"], 0.6), null);
  });

  test("formatMinutes rundet auf Sekunden", () => {
    assert.equal(formatMinutes(150400), "2:30");
    assert.equal(formatMinutes(-5), "0:00");
  });

  test("letterChanges findet fehlende und zusätzliche Buchstaben", () => {
    assert.deepEqual(letterChanges([..."ACF"], [..."AEF"]), { missing: ["C"], extra: ["E"] });
    assert.deepEqual(letterChanges([..."BD"], [..."BCDF"]), { missing: [], extra: ["C", "F"] });
  });

  test("timingOutliers meldet nur echte Ausreißer", () => {
    const reference = [letter("A", 0), letter("B", 10), letter("C", 20)];
    assert.deepEqual(timingOutliers(reference, [letter("A", 0), letter("B", 10), letter("C", 20)]), []);
    assert.deepEqual(
      timingOutliers(reference, [letter("A", 0), letter("B", 15), letter("C", 20)]).map(({ index }) => index),
      [1],
    );
  });

  test("instrumentFamilies bildet Familien ab fünf gemeinsamen Endbuchstaben", () => {
    const families = instrumentFamilies(["Altsaxophon", "Tenorsaxophon", "Tuba", "Althorn", "Tenorhorn"]);
    assert.deepEqual(families, [
      { name: "Saxophon", members: ["Altsaxophon", "Tenorsaxophon"], preferred: "Altsaxophon" },
    ]);
  });

  test("duplicateLetterIndexes beginnt nach D.S. und D.C. neu", () => {
    const letters = ["A", "B", "A", "D.S.", "A", "B", "D.C.", "B", "B"].map((name, index) => letter(name, index));
    assert.deepEqual([...duplicateLetterIndexes(letters)], [2, 8]);
  });

  test("firstLetterFinding nur, wenn der erste Buchstabe nicht bei 0 liegt", () => {
    assert.equal(firstLetterFinding([]), null);
    assert.equal(firstLetterFinding([letter("A", 0)]), null);
    assert.deepEqual(firstLetterFinding([letter("A", 1, 3)]), { line: 3, text: "„A“ beginnt nicht bei 0:00" });
  });

  test("countInTempoFindings in beide Richtungen", () => {
    assert.deepEqual(countInTempoFindings("Strophe - langsamer", [letter("A", 0, 1, "4-4")], ["4-4", "4-4langsamer"]), [
      { line: 1, text: "Langsames Playback mit Einzähler „4-4“ bei „A“, gemeint „4-4langsamer“?" },
    ]);
    assert.deepEqual(countInTempoFindings("Strophe", [letter("A", 0, 2, "4-4langsamer")], ["4-4langsamer"]), [
      { line: 2, text: "Normales Playback mit langsamem Einzähler „4-4langsamer“ bei „A“" },
    ]);
    assert.deepEqual(countInTempoFindings("Strophe - langsamer", [letter("A", 0, 1, "4-4")], ["4-4"]), []);
  });

  test("createTypeRules gruppiert Varianten und erkennt Instrumente im Zusatz", () => {
    const rules = createTypeRules([
      { id: 1, name: "Altsaxophon" },
      { id: 2, name: "Tenorsaxophon" },
      { id: 3, name: "DrumSet" },
    ]);
    assert.equal(rules.variantGroup("Strophe - lauter_langsamer"), "strophe");
    assert.equal(rules.variantGroup("Altsaxophon - lauter"), "normal");
    assert.deepEqual(rules.typeInstrumentIds("ohne Drums"), [3]);
    assert.deepEqual(rules.typeSegmentFindings("Altsaxofon"), [
      { code: "unknown_type_instrument", severity: "warning", index: 0, text: "Tippfehler im Zusatz: „Altsaxofon“", replacement: "Altsaxophon" },
    ]);
    assert.deepEqual(rules.typeSegmentFindings("Saxophon - lauter"), [
      {
        code: "ambiguous_type_instrument",
        severity: "error",
        index: 0,
        text: "„Saxophon“ ist kein genaues Instrument, gemeint ist eines von: Altsaxophon, Tenorsaxophon",
        replacement: "Altsaxophon",
      },
    ]);
  });

  test("variantFindings vergleicht innerhalb einer Gruppe mit der Referenz", () => {
    const normal = { type: "Normal", group: "normal", letters: [letter("A", 0, 1), letter("B", 10, 2), letter("C", 20, 3), letter("D", 30, 4)] };
    const slow = { type: "langsamer", group: "normal", letters: [letter("A", 0, 1), letter("D", 10, 2), letter("E", 20, 3)] };
    const alone = { type: "Solo", group: "solo", letters: [letter("A", 0, 1)] };
    assert.deepEqual(variantFindings([slow, normal, alone]), [
      {
        code: "letters_differ_between_variants",
        sequence: slow,
        line: null,
        text: `Andere Buchstaben als Normal:${lineFeed}Hier: A D E${lineFeed}Normal: A B C D`,
      },
    ]);
  });

  test("variantFindings nennt bis zu zwei Unterschiede in der Kurzform", () => {
    const normal = { type: "Normal", group: "normal", letters: [letter("A", 0, 1), letter("C", 10, 2), letter("F", 20, 3)] };
    const slow = { type: "langsamer", group: "normal", letters: [letter("A", 0, 1), letter("E", 10, 2), letter("F", 20, 3)] };
    assert.deepEqual(variantFindings([normal, slow]), [
      { code: "letters_differ_between_variants", sequence: slow, line: null, text: "Fehlt „C“, zusätzlich „E“ (vgl. „Normal“)" },
    ]);
  });

  test("variantFindings meldet zeitlich verschobene Buchstaben bei gleicher Folge", () => {
    const normal = { type: "Normal", group: "normal", letters: [letter("A", 0, 1), letter("B", 10, 2), letter("C", 20, 3)] };
    const slow = { type: "langsamer", group: "normal", letters: [letter("A", 0, 1), letter("B", 15, 2), letter("C", 20, 3)] };
    assert.deepEqual(variantFindings([normal, slow]), [
      { code: "letter_time_differs_between_variants", sequence: slow, line: 2, text: "„B“ bei 0:15, erwartet ~0:10" },
    ]);
  });
});
