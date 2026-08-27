/**
 * Single source of truth for every tunable in the game.
 *
 * CONTRACT — all modules import from here. Nothing else defines a magic number
 * that affects layout, physics feel, or the fruit chain. Art, physics, game
 * logic, FX and UI must all agree on VIRTUAL_W/H and the FRUITS table.
 */

/* ------------------------------------------------------------------ *
 * Virtual resolution.
 * The whole game is authored at this size, 1 unit == 1 texel, and the
 * renderer integer-scales it to the viewport. Never draw at fractional
 * scale: that is what separates real pixel art from a blurry upscale.
 * ------------------------------------------------------------------ */
export const VIRTUAL_W = 320;
export const VIRTUAL_H = 480;

/* Playfield jar geometry, in virtual pixels. */
export const BOARD = {
  left: 28,
  right: 292,
  floor: 452,
  /** Fruits resting above this line for DANGER_GRACE ms end the run. */
  dangerY: 96,
  /** Wall/floor thickness used for the static Matter bodies. */
  wallThickness: 24,
};
export const BOARD_W = BOARD.right - BOARD.left;

/** How long a fruit may sit above BOARD.dangerY before the run ends (ms). */
export const DANGER_GRACE = 1400;

/* ------------------------------------------------------------------ *
 * The evolution chain.
 *
 * radius  - collision + art radius in virtual pixels
 * score   - points granted when two of the PREVIOUS tier merge into this one
 * palette - 5-stop ramp, darkest -> lightest. The pixel-sphere shader
 *           quantises lighting onto these stops and dithers between them.
 * outline - 1px silhouette colour (never pure black; keeps art from muddying)
 * ------------------------------------------------------------------ */
export const FRUITS = [
  { id: 0,  name: 'cherry',     radius: 8,  score: 1 },
  { id: 1,  name: 'strawberry', radius: 10, score: 3 },
  { id: 2,  name: 'grape',      radius: 13, score: 6 },
  { id: 3,  name: 'dekopon',    radius: 16, score: 10 },
  { id: 4,  name: 'persimmon',  radius: 20, score: 15 },
  { id: 5,  name: 'apple',      radius: 24, score: 21 },
  { id: 6,  name: 'pear',       radius: 29, score: 28 },
  { id: 7,  name: 'peach',      radius: 34, score: 36 },
  { id: 8,  name: 'pineapple',  radius: 39, score: 45 },
  { id: 9,  name: 'melon',      radius: 44, score: 55 },
  { id: 10, name: 'watermelon', radius: 50, score: 66 },
];

/** Only the first five tiers can drop from the claw, as in the original. */
export const SPAWNABLE_TIERS = 5;

/* ------------------------------------------------------------------ *
 * Physics feel. These numbers are the difference between "fruit" and
 * "bouncy balls"; treat them as authored, not arbitrary.
 * ------------------------------------------------------------------ */
export const PHYSICS = {
  gravity: 1.45,
  /** Fixed simulation step (ms). Rendering interpolates between steps. */
  timeStep: 1000 / 120,
  maxSubSteps: 4,
  restitution: 0.06,
  friction: 0.32,
  frictionStatic: 0.55,
  frictionAir: 0.0,
  density: 0.0012,
  slop: 0.02,
  /** Matter solver iterations — high, because stacked circles love to jitter. */
  positionIterations: 12,
  velocityIterations: 10,
  constraintIterations: 4,
  /** Impulse applied to a freshly merged fruit so merges feel alive. */
  mergePop: 0.9,
  /** Fruits slower than this (px/s) are considered settled. */
  sleepSpeed: 6,
};

/* Drop mechanics. */
export const DROP = {
  /** y position of the claw / spawn line. */
  y: 62,
  /** Minimum ms between drops. */
  cooldown: 420,
  /** Horizontal claw travel speed for keyboard input (px/s). */
  keyboardSpeed: 170,
};

/* Combo scoring: chained merges inside this window multiply the payout. */
export const COMBO = {
  windowMs: 900,
  multipliers: [1, 1.2, 1.5, 2, 2.5, 3],
};

/** Deterministic default seed so screenshots and tests reproduce exactly. */
export const DEFAULT_SEED = 0x5ca1ab1e;

/* Named layer order for the Pixi scene graph. Modules attach to these. */
export const LAYERS = ['background', 'jarBack', 'fruit', 'fx', 'jarFront', 'ui', 'overlay'];
