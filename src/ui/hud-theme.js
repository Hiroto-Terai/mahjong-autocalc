/**
 * The UI's colour constitution.
 *
 * The art bible asks for a deep indigo world with warm UI; these are the only
 * colours the HUD, the claw and the panels are allowed to use, so every frame
 * on screen looks cut from the same sheet of metal.
 */
export const THEME = {
  /** Outer shadow / silhouette. Never pure black — it would punch a hole. */
  ink: 0x0a0d18,
  panelDark: 0x161c30,
  panel: 0x222a49,
  panelLite: 0x323c66,
  /** Bevel highlight along the top-left of every raised surface. */
  edge: 0x5d6b9f,
  edgeLite: 0x8b98cc,

  gold: 0xf5c451,
  goldLite: 0xffeeb0,
  goldDark: 0x8a5a1c,

  cream: 0xfff6e2,
  text: 0xdfe6ff,
  dim: 0x6b78ab,
  dimmer: 0x424c78,

  danger: 0xff5f5f,
  dangerDark: 0x7a1f2a,
  fresh: 0x7fe06a,

  /** Metal for the gantry and claw. */
  steel: 0x77839f,
  steelLite: 0xb6c0d8,
  steelDark: 0x363f5c,
};

const chan = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];

/** N-step colour ramp as packed hex, for per-row lettering fills. */
export function rampHex(a, b, steps) {
  const ca = chan(a), cb = chan(b);
  const out = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    out.push(
      (Math.round(ca[0] + (cb[0] - ca[0]) * t) << 16)
      | (Math.round(ca[1] + (cb[1] - ca[1]) * t) << 8)
      | Math.round(ca[2] + (cb[2] - ca[2]) * t),
    );
  }
  return out;
}

/** Score lettering: hot cream at the top edge falling to deep gold. */
export const RAMP_SCORE = rampHex(THEME.goldLite, 0xc4801e, 10);
export const RAMP_TITLE = rampHex(THEME.cream, THEME.gold, 10);
export const RAMP_DANGER = rampHex(0xffd6c0, 0xc4232f, 10);
