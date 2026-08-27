/** Colour helpers for authoring pixel ramps. All colours are [r,g,b] 0-255. */

export const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
export const toHex = ([r, g, b]) => (r << 16) | (g << 8) | b;
export const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

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
