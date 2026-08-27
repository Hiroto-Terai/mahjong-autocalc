/**
 * Deterministic capture scenarios.
 *
 * Each scenario is a seed plus a script of drops. Given the same seed the
 * simulation is bit-identical, so a screenshot difference always means the
 * art or layout actually changed — never that the dice rolled differently.
 */
export const SCENARIOS = [
  {
    name: 'title',
    seed: 1234,
    title: true,
    note: 'Attract screen: title panel, logo, start prompt.',
  },
  {
    name: 'empty-board',
    seed: 1234,
    script: [],
    settle: 400,
    note: 'Title/empty state: jar chrome, HUD, claw, danger line.',
  },
  {
    name: 'early-play',
    seed: 1234,
    script: [
      [120, 700], [180, 700], [150, 700], [220, 700], [90, 700], [160, 900],
    ],
    settle: 1200,
    note: 'A few small fruit resting: reads small-sprite legibility.',
  },
  {
    name: 'mid-game',
    seed: 4242,
    // Deliberately clustered so merges chain and mid-tier fruit appear.
    // 58 drops across the full width: enough for the pile to reach two thirds
    // of the jar with a spread of tiers, which is the state a player actually
    // spends most of a run looking at.
    // Dropped faster than the pile can merge itself flat: a well-played board
    // reaches equilibrium low in the jar, which is not the state worth
    // grading art against.
    script: Array.from({ length: 150 }, (_, i) => [
      44 + ((i * 71) % 232), 200,
    ]),
    settle: 2400,
    note: 'Full jar, mixed tiers: the shot that decides if the game looks AAA.',
  },
  {
    name: 'merge-moment',
    seed: 4242,
    script: Array.from({ length: 18 }, (_, i) => [70 + ((i * 53) % 180), 620]),
    settle: 1600,
    // Captured a few frames after a forced merge so FX are mid-flight.
    forceMerge: true,
    fxDelay: 90,
    note: 'Merge FX mid-burst: particles, flash, shake.',
  },
  {
    name: 'fruit-lineup',
    seed: 7,
    lineup: true,
    note: 'All 11 fruits side by side at rest — the art sheet the critic grades.',
  },
  {
    name: 'game-over',
    seed: 99,
    script: Array.from({ length: 12 }, (_, i) => [70 + ((i * 53) % 180), 500]),
    settle: 1200,
    forceGameOver: true,
    note: 'Overflow + game-over panel.',
  },
];
