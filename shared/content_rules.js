export const typeInstrumentCutoff = 0.8;
export const timingToleranceMs = 3000;
export const maximumListedLetterChanges = 2;
export const defaultType = "Normal";
export const jumpMarks = new Set(["D.S.", "D.C."]);
const variantModifierPattern = /^(ohne Drums|lauter)?(_?langsamer)?$/i;
const withoutDrumsPattern = /ohne drums/i;
const slowTempoPattern = /langsam/i;
const slowTempoSuffixPattern = /[\s_-]*langsam(er)?/gi;
const drumInstrumentPrefix = "drum";
const minimumFamilySuffixLength = 5;
const preferredFamilyPrefix = "alt";

export function fold(text) {
  return text.toLowerCase();
}

export function formatMinutes(milliseconds) {
  const totalSeconds = Math.round(Math.max(milliseconds, 0) / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

export function letterChanges(reference, other) {
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

export function timingOutliers(referenceLetters, letters) {
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

export function similarity(first, second) {
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

export function instrumentFamilies(names) {
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

export function bestMatch(value, candidates, cutoff) {
  const scored = [...new Set(candidates)]
    .map((candidate) => ({ candidate, score: similarity(value, candidate) }))
    .filter((entry) => entry.score >= cutoff)
    .sort((left, right) => right.score - left.score);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;
  return scored[0].candidate;
}

export function duplicateLetterIndexes(letters) {
  const duplicates = new Set();
  let seenLetters = new Set();
  letters.forEach((letter, index) => {
    if (jumpMarks.has(letter.name)) seenLetters = new Set();
    if (seenLetters.has(letter.name)) duplicates.add(index);
    seenLetters.add(letter.name);
  });
  return duplicates;
}

export function firstLetterFinding(letters) {
  if (letters.length === 0 || letters[0].position_ms === 0) return null;
  return { line: letters[0].line, text: `„${letters[0].name}“ beginnt nicht bei 0:00` };
}

export function createTypeRules(instruments) {
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
  const typeSegmentFindings = (type) => {
    if (fold(type) === fold(defaultType)) return [];
    const findings = [];
    type.split(" - ").forEach((segment, index) => {
      if (isModifier(segment) || instrumentNameKeys.has(fold(segment))) return;
      const similar = bestMatch(segment, instrumentNames, typeInstrumentCutoff);
      if (similar) {
        findings.push({
          code: "unknown_type_instrument",
          severity: "warning",
          index,
          text: `Tippfehler im Zusatz: „${segment}“`,
          replacement: similar,
        });
        return;
      }
      const family = familyFor(segment);
      if (!family) return;
      findings.push({
        code: "ambiguous_type_instrument",
        severity: "error",
        index,
        text: `„${segment}“ ist kein genaues Instrument, gemeint ist eines von: ${family.members.join(", ")}`,
        replacement: family.preferred,
      });
    });
    return findings;
  };
  return { variantGroup, typeInstrumentIds, typeSegmentFindings };
}

export function countInTempoFindings(type, letters, countInNames) {
  const countIns = new Map(countInNames.map((name) => [fold(name), name]));
  const tempoKey = (name) => fold(name).replace(slowTempoSuffixPattern, "").trim();
  const slow = slowTempoPattern.test(type);
  const mismatches = new Map();
  for (const letter of letters) {
    const countIn = countIns.get(fold(letter.count_in));
    if (!countIn || slowTempoPattern.test(countIn) === slow) continue;
    const counterpart = [...countIns.values()].find(
      (candidate) => slowTempoPattern.test(candidate) === slow && tempoKey(candidate) === tempoKey(countIn),
    );
    if (!counterpart && slow) continue;
    const key = fold(countIn);
    if (!mismatches.has(key)) mismatches.set(key, { used: countIn, expected: counterpart ?? null, letters: [] });
    mismatches.get(key).letters.push(letter);
  }
  return [...mismatches.values()].map(({ used, expected, letters: affected }) => {
    const names = affected.map((letter) => `„${letter.name}“`).join(", ");
    return {
      line: affected[0].line,
      text:
        expected === null
          ? `Normales Playback mit langsamem Einzähler „${used}“ bei ${names}`
          : `${slow ? "Langsames" : "Normales"} Playback mit Einzähler „${used}“ bei ${names}, gemeint „${expected}“?`,
    };
  });
}

export function variantFindings(sequences) {
  const findings = [];
  const sequencesByGroup = new Map();
  for (const sequence of sequences) {
    if (!sequencesByGroup.has(sequence.group)) sequencesByGroup.set(sequence.group, []);
    sequencesByGroup.get(sequence.group).push(sequence);
  }
  for (const [group, groupSequences] of sequencesByGroup) {
    if (groupSequences.length < 2) continue;
    const referenceSequence = groupSequences.find((sequence) => fold(sequence.type) === group) ?? groupSequences[0];
    const referenceType = referenceSequence.type;
    const referenceNames = referenceSequence.letters.map((letter) => letter.name);
    for (const sequence of groupSequences) {
      if (sequence === referenceSequence) continue;
      const names = sequence.letters.map((letter) => letter.name);
      if (names.join(" ") === referenceNames.join(" ")) {
        for (const outlier of timingOutliers(referenceSequence.letters, sequence.letters)) {
          const letter = sequence.letters[outlier.index];
          findings.push({
            code: "letter_time_differs_between_variants",
            sequence,
            line: letter.line,
            text: `„${letter.name}“ bei ${formatMinutes(letter.position_ms)}, erwartet ~${formatMinutes(outlier.expected)}`,
          });
        }
        continue;
      }
      const { missing, extra } = letterChanges(referenceNames, names);
      const changes = [];
      if (missing.length > 0) changes.push(`Fehlt ${missing.map((name) => `„${name}“`).join(", ")}`);
      if (extra.length > 0) changes.push(`${missing.length > 0 ? "zusätzlich" : "Zusätzlich"} ${extra.map((name) => `„${name}“`).join(", ")}`);
      findings.push({
        code: "letters_differ_between_variants",
        sequence,
        line: null,
        text:
          missing.length + extra.length <= maximumListedLetterChanges
            ? `${changes.join(", ")} (vgl. „${referenceType}“)`
            : `Andere Buchstaben als ${referenceType}:\nHier: ${names.join(" ")}\n${referenceType}: ${referenceNames.join(" ")}`,
      });
    }
  }
  return findings;
}
