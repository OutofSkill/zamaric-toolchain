const instrumentRows = [
  ["Akkordeon", "C"],
  ["Akkordinstrument", "C"],
  ["Altflöte", "G"],
  ["Altsaxophon", "Es"],
  ["Baritonsaxophon", "Es"],
  ["Bassklarinette", "B"],
  ["DrumSet", ""],
  ["E-Bass", "C"],
  ["Euphonium", "C"],
  ["Fagott", "C"],
  ["Flöte", "C"],
  ["Gitarre", "C"],
  ["Glockenspiel", "C"],
  ["Horn", "F"],
  ["Klarinette", "B"],
  ["Oboe", "C"],
  ["Posaune", "C"],
  ["Sopransaxophon", "B"],
  ["strategische AltPosaune", "C"],
  ["Tenorhorn", "B"],
  ["Tenorsaxophon", "B"],
  ["Trompete", "B"],
  ["Trompete", "C"],
  ["Tuba", "C"],
];

const extraPartRows = [
  ["Akkordblatt", "C", false, ["Akkordeon", "Akkordinstrument", "Gitarre"]],
  ["DrumSet Große Trommel", "", false, ["DrumSet"]],
  ["DrumSet Hi-Hat", "", false, ["DrumSet"]],
  ["DrumSet Kleine Trommel", "", false, ["DrumSet"]],
  ["in B Stimmung", "B", true, []],
  ["in C Stimmung", "C", true, []],
  ["in Es Stimmung", "Es", true, []],
  ["in F Stimmung", "F", true, []],
];

const instruments = instrumentRows.map(([name, transposition], index) => ({
  id: index + 1,
  name,
  transposition,
}));

const parts = [
  ...instruments.map(({ name, transposition }) => ({ name, transposition, forWholeTransposition: false, instrumentNames: [] })),
  ...extraPartRows.map(([name, transposition, forWholeTransposition, instrumentNames]) => ({
    name,
    transposition,
    forWholeTransposition,
    instrumentNames,
  })),
].map((part, index) => ({ ...part, id: 101 + index }));

const instrumentParts = parts.flatMap((part) =>
  instruments
    .filter((instrument) =>
      part.forWholeTransposition
        ? part.transposition !== "" && instrument.transposition === part.transposition
        : part.instrumentNames.includes(instrument.name) ||
          (instrument.name === part.name && instrument.transposition === part.transposition),
    )
    .map((instrument) => ({ part_id: part.id, instrument_id: instrument.id })),
);

export const demoReference = {
  categories: [
    { id: 1, name: "Grande Fanfare" },
    { id: 2, name: "Absolute Beginners Brass" },
    { id: 3, name: "Bläserklassen" },
    { id: 4, name: "Posaunenchor" },
  ],
  levels: [
    { id: 1, name: "Normal" },
    { id: 2, name: "Anfänger" },
    { id: 3, name: "Leicht" },
  ],
  instruments,
  parts: parts.map(({ id, name, transposition }) => ({ id, name, transposition })),
  instrument_parts: instrumentParts,
  songs: [
    {
      id: 1,
      category_id: 1,
      name: "Tequila",
      created_at: "2026-10-20T19:12:00.000000+00:00",
      release_at: "2026-10-22T02:00:00.000000+00:00",
    },
  ],
};

export const demoExistingSong = {
  song_id: 1,
  release_at: "2026-10-22T02:00:00.000000+00:00",
  pending_release_at: null,
  publisher_name: null,
  publisher_url: null,
  count_ins: [],
  playbacks: [],
  sheet_music: [],
};
