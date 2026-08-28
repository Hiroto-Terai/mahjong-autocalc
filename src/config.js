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
  /** Jar rim. Everything above this is HUD and claw space. Interior is
   *  264x368, close to the roughly 4:5 playfield the genre settled on —
   *  a taller jar makes early fruit look lost at the bottom. */
  top: 84,
  /** Fruits resting above this line for DANGER_GRACE ms end the run. */
  dangerY: 112,
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
  /** Matter takes mass from density*area, so one density makes mass grow with
   *  r^2 — a melon only 6x a cherry. Real fruit go as volume, r^3, and that
   *  difference is most of why a uniform-density pile feels like ping-pong
   *  balls. Scaling density by (r/refRadius)^densityExponent restores it;
   *  the reference tier keeps exactly the authored density. */
  densityExponent: 1.0,
  densityRefRadius: 20,
  slop: 0.02,
  /** Matter solver iterations — high, because stacked circles love to jitter. */
  positionIterations: 12,
  velocityIterations: 10,
  constraintIterations: 4,
  /** Upward kick given to a freshly merged fruit so merges feel alive.
   *  Divided by the merged fruit's mass relative to a mid-tier one, so a
   *  watermelon appearing does not hop like a cherry. */
  mergePop: 0.9,
  /** How much of the room a merged fruit needs is taken from its neighbours
   *  by displacing them, rather than left for the solver to fight out.
   *  1 = the new fruit is fully clear on the frame it is born. */
  mergeRoom: 0.85,
  /** The pop is scaled down by how boxed-in the merge is: this much overlap
   *  with neighbours (in px, summed) kills it completely. */
  mergeConfineSpan: 26,
  /** Fruits slower than this (px/s) are considered settled. */
  sleepSpeed: 6,
  /** Steps of near-stillness before a fruit is parked. Matter measures this
   *  against a 60Hz reference, so at our 120Hz step the real wait is 2x. */
  sleepThreshold: 24,
  /** A parked fruit stops being pushed apart, so anything sleeping while it
   *  still overlaps a neighbour stays visibly sunk into it forever. Sleepers
   *  deeper than this (px) are woken until the solver has separated them.
   *  Below ~0.5 the pile starts cycling awake and settling takes longer. */
  sleepOverlap: 0.6,
  /** Steps between overlap audits. Cheap, but no reason to run it every step. */
  sleepAuditEvery: 4,
  /** Speed ceiling (px per 1/60s, Matter's velocity unit). A free fall from
   *  the claw tops out near 17, so this never touches normal play — it exists
   *  to cap the separation impulse when a fruit spawns inside a full jar. */
  maxSpeed: 26,
  /** ...and no fruit may cross more than this many radii per 1/60s, so a
   *  cherry can never step clean through the far side of a wall. */
  maxSpeedPerRadius: 2.6,
  /** Spin ceiling (rad per 1/60s). */
  maxSpin: 0.6,
  /** Per-step bleed on spin only. Air drag would do this too, but it drags on
   *  falling as well and fruit that fall slowly read as balloons. Damping the
   *  spin alone is what stops a pile behaving like ball bearings. */
  angularDamping: 0.06,
};

/* Drop mechanics. */
export const DROP = {
  /** y position of the claw / spawn line. */
  y: 50,
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
