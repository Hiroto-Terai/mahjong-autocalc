/** Colour helpers for authoring pixel ramps. All colours are [r,g,b] 0-255. */

export const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
export const toHex = ([r, g, b]) => (r << 16) | (g << 8) | b;
export const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/** An authored ramp: 0xRRGGBB stops, darkest -> lightest, as rgb triples. */
export const stopsOf = (list) => list.map(hex);

/**
 * Reduce an authored 5-stop ramp to `n` stops for a small sprite.
 *
 * The stops are *picked*, never interpolated: blending two authored colours
 * hands back exactly the muddy near-duplicate that dropping a stop exists to
 * avoid. Four stops keep both endpoints and skip the upper midtone, which is
 * the one a small sphere can least afford to spend texels on.
 */
const PICKS = { 2: [0, 4], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4] };
export const pick = (stops, n) => (PICKS[n] || PICKS[5]).map((i) => stops[i]);

/**
 * Build an N-stop ramp between a shadow and a highlight colour.
 *
 * Real pixel artists never ramp straight through RGB: shadows shift toward the
 * cool end and highlights toward warm, or the result reads as a grey-washed
 * 3D render. `hueShift` bends the midtones to keep the ramp lively.
 */
export function ramp(shadow, light, stops = 5, hueShift = null) {
  const out = [];
  for (let i = 0; i < stops; i++) {
    const t = i / (stops - 1);
    let c = mix(shadow, light, t);
    if (hueShift) {
      // Strongest push at the midtone, none at the endpoints.
      const bend = Math.sin(t * Math.PI) * 0.35;
      c = mix(c, hueShift, bend);
    }
    out.push(c);
  }
  return out;
}

/** 4x4 Bayer matrix, normalised 0..1 — the workhorse of pixel-art gradients. */
export const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));

export const bayer = (x, y) => BAYER4[y & 3][x & 3];

/**
 * Quantise a 0..1 luminance onto `n` ramp stops.
 *
 * `band` is the half-width — in units of one ramp step — of the dithered
 * transition either side of a stop boundary. Outside that band the choice is a
 * hard threshold, so the dither shows up as a narrow ribbon following each
 * terminator instead of a haze over the whole surface. Dithering everywhere is
 * the single thing that makes generated art read as a downsampled 3D render.
 */
export function quantIndex(lum, n, px, py, band) {
  const top = n - 1;
  const s = Math.max(0, Math.min(1, lum)) * top;
  const lo = Math.min(top - 1, Math.floor(s));
  const frac = s - lo;
  if (band <= 0) return lo + (frac >= 0.5 ? 1 : 0);
  const t = (frac - (0.5 - band)) / (2 * band);
  if (t <= 0) return lo;
  if (t >= 1) return lo + 1;
  return lo + (t > bayer(px, py) ? 1 : 0);
}

/** Deterministic 0..1 hash — used to scatter seeds and pores reproducibly. */
export function hash1(i, salt = 0) {
  let h = (i * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
