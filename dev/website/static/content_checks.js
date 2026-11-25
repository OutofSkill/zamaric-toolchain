import {
  countInTempoFindings,
  createTypeRules,
  duplicateLetterIndexes,
  firstLetterFinding,
  formatMinutes,
  variantFindings,
} from "./content_rules.js";
import { sha256 } from "./vendor/sha256.min.js";

export const contentCheckNames = [
  "ambiguous_type_instrument",
  "duplicate_letter",
  "unknown_type_instrument",
  "visibility_differs_from_type",
  "playback_without_letters",
  "first_letter_not_at_start",
  "count_in_tempo_mismatch",
  "letters_differ_between_variants",
  "letter_time_differs_between_variants",
  "part_without_viewers",
];

export function findingKey(finding) {
  return sha256(JSON.stringify([finding.kind, finding.check, finding.subject, finding.detail]));
}

function entryLabel(entry) {
  return entry.transposition ? `${entry.name} in ${entry.transposition}` : entry.name;
}

function normalizeEntry(entry) {
  return { ...entry, name: entry.name.normalize("NFC"), transposition: (entry.transposition ?? "").normalize("NFC") };
}

function isPending(row) {
  return row.release_at != null;
}

function visibleRows(rows) {
  return rows.filter((row) => !isPending(row));
}

function releasedRows(rows) {
  const visible = visibleRows(rows);
  const visibleIds = new Set(visible.map((row) => row.id));
  const replacements = new Map();
  const added = [];
  for (const row of rows.filter(isPending)) {
    if (row.replaces_id != null && visibleIds.has(row.replaces_id)) replacements.set(row.replaces_id, row);
    else added.push(row);
  }
  return [
    ...visible.map((row) => {
      const replacement = replacements.get(row.id);
      return replacement ? { ...replacement, id: row.id, source_id: replacement.id } : row;
    }),
    ...added,
  ];
}

function normalizeText(text) {
  return typeof text === "string" ? text.normalize("NFC") : text;
}

function songState(song, selectRows) {
  return {
    countIns: selectRows(song.count_ins ?? []).map((countIn) => ({ ...countIn, name: normalizeText(countIn.name) })),
    playbacks: selectRows(song.playbacks ?? []).map((playback) => ({
      ...playback,
      type: normalizeText(playback.type),
      letters: (playback.letters ?? []).map((letter) => ({ ...letter, name: normalizeText(letter.name) })),
    })),
    sheetMusic: selectRows(song.sheet_music ?? []),
  };
}

function canSee(playback, instrumentId) {
  const listed = (playback.instrument_ids ?? []).includes(instrumentId);
  if (playback.instrument_mode === "only") return listed;
  if (playback.instrument_mode === "except") return !listed;
  return true;
}

function songFindings(song, state, context) {
  const findings = [];
  const add = (check, severity, rowId, target, detail) =>
    findings.push({
      kind: "content",
      check,
      severity,
      song_id: song.id,
      song_name: normalizeText(song.name),
      table_name: "playback",
      row_id: rowId,
      subject: `playback:${rowId}`,
      target,
      detail,
    });
  const instrumentNames = (ids) => ids.map((id) => context.instrumentLabels.get(id) ?? `Instrument ${id}`).join(", ");
  const visibilityText = (playback) => {
    const names = instrumentNames(playback.instrument_ids ?? []);
    if (playback.instrument_mode === "only") return `nur für ${names || "niemanden"}`;
    if (playback.instrument_mode === "except") return `für alle außer ${names}`;
    return "für alle";
  };
  const countInNames = new Map();
  for (const countIn of state.countIns) {
    countInNames.set(countIn.id, countIn.name);
    if (countIn.source_id != null) countInNames.set(countIn.source_id, countIn.name);
  }
  const allCountInNames = state.countIns.map((countIn) => countIn.name);
  const sequences = [];
  for (const playback of state.playbacks) {
    const target = `Playback „${playback.type}“`;
    const addForPlayback = (check, severity, detail) => add(check, severity, playback.id, target, detail);
    for (const finding of context.rules.typeSegmentFindings(playback.type)) {
      addForPlayback(finding.code, finding.severity, finding.replacement ? `${finding.text} → „${finding.replacement}“` : finding.text);
    }
    const unseen = context.rules.typeInstrumentIds(playback.type).filter((id) => !canSee(playback, id));
    if (unseen.length > 0) {
      addForPlayback("visibility_differs_from_type", "warning", `Im Zusatz genannt, sieht es nicht: ${instrumentNames(unseen)} (${visibilityText(playback)})`);
    }
    const letters = (playback.letters ?? []).map((letter) => ({
      name: letter.name,
      position_ms: letter.position_ms,
      count_in: countInNames.get(letter.count_in_id) ?? "",
    }));
    if (letters.length === 0) {
      addForPlayback("playback_without_letters", "warning", "Keine Buchstaben");
      continue;
    }
    for (const index of duplicateLetterIndexes(letters)) {
      addForPlayback("duplicate_letter", "error", `„${letters[index].name}“ doppelt bei ${formatMinutes(letters[index].position_ms)}`);
    }
    const firstLetter = firstLetterFinding(letters);
    if (firstLetter) addForPlayback("first_letter_not_at_start", "warning", firstLetter.text);
    for (const finding of countInTempoFindings(playback.type, letters, allCountInNames)) {
      addForPlayback("count_in_tempo_mismatch", "warning", finding.text);
    }
    sequences.push({ type: playback.type, group: context.rules.variantGroup(playback.type), playback, letters });
  }
  for (const finding of variantFindings(sequences)) {
    add(finding.code, "warning", finding.sequence.playback.id, `Playback „${finding.sequence.type}“`, finding.text);
  }
  return findings;
}

function keyed(findings) {
  const byKey = new Map();
  for (const finding of findings) {
    const key = findingKey(finding);
    if (!byKey.has(key)) byKey.set(key, { ...finding, key });
  }
  return byKey;
}

function partFindings(snapshot, sheetCounts) {
  const viewedPartIds = new Set((snapshot.instrument_parts ?? []).map((entry) => entry.part_id));
  const findings = [];
  for (const part of (snapshot.parts ?? []).map(normalizeEntry)) {
    const counts = sheetCounts.get(part.id);
    if (!counts || viewedPartIds.has(part.id)) continue;
    const label = entryLabel(part);
    findings.push({
      kind: "content",
      check: "part_without_viewers",
      severity: "warning",
      song_id: null,
      song_name: null,
      table_name: "part",
      row_id: part.id,
      subject: `part:${part.id}`,
      target: `Stimme „${label}“`,
      detail: `„${label}“`,
      usage: `${counts.sheets} ${counts.sheets === 1 ? "Notenblatt" : "Notenblätter"} in ${counts.songs.size} ${counts.songs.size === 1 ? "Song" : "Songs"}`,
    });
  }
  return [...keyed(findings).values()].map((finding) => ({ ...finding, state: null }));
}

export function evaluateContent(snapshot, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const instruments = (snapshot.instruments ?? []).map(normalizeEntry);
  const context = {
    rules: createTypeRules(instruments),
    instrumentLabels: new Map(instruments.map((instrument) => [instrument.id, entryLabel(instrument)])),
  };
  const findings = [];
  const sheetCounts = new Map();
  for (const song of snapshot.songs ?? []) {
    const released = songState(song, releasedRows);
    for (const sheet of released.sheetMusic) {
      const counts = sheetCounts.get(sheet.part_id) ?? { sheets: 0, songs: new Set() };
      counts.sheets += 1;
      counts.songs.add(song.id);
      sheetCounts.set(sheet.part_id, counts);
    }
    if (song.release_at != null && Date.parse(song.release_at) > nowMs) {
      const state = { kind: "waiting", release_at: song.release_at };
      for (const finding of keyed(songFindings(song, released, context)).values()) findings.push({ ...finding, state });
      continue;
    }
    const visibleFindings = keyed(songFindings(song, songState(song, visibleRows), context));
    const pendingDates = [...(song.count_ins ?? []), ...(song.playbacks ?? []), ...(song.sheet_music ?? [])]
      .filter(isPending)
      .map((row) => row.release_at)
      .sort((left, right) => Date.parse(left) - Date.parse(right));
    if (pendingDates.length === 0) {
      for (const finding of visibleFindings.values()) findings.push({ ...finding, state: null });
      continue;
    }
    const releaseAt = pendingDates[0];
    const releasedFindings = keyed(songFindings(song, released, context));
    for (const [key, finding] of visibleFindings) {
      const state = releasedFindings.has(key) ? { kind: "visible", release_at: null } : { kind: "fixed", release_at: releaseAt };
      findings.push({ ...finding, state });
    }
    for (const [key, finding] of releasedFindings) {
      if (!visibleFindings.has(key)) findings.push({ ...finding, state: { kind: "coming", release_at: releaseAt } });
    }
  }
  findings.push(...partFindings(snapshot, sheetCounts));
  const checkOrder = new Map(contentCheckNames.map((name, index) => [name, index]));
  return findings.sort(
    (left, right) =>
      checkOrder.get(left.check) - checkOrder.get(right.check) ||
      (left.song_name ?? "").localeCompare(right.song_name ?? "", "de") ||
      left.target.localeCompare(right.target, "de") ||
      left.detail.localeCompare(right.detail, "de"),
  );
}
