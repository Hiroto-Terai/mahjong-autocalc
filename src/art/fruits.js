import { hex, mix } from './palette.js';

/**
 * Per-fruit surface definitions.
 *
 * Each fruit supplies an `albedo(u, v, ctx)` sampled in *object space* — the
 * disc rotated with the body — so stripes, seeds and netting spin with the
 * fruit while the light stays fixed in screen space. That separation is what
 * makes a rotating pixel sphere read as a solid object instead of a decal.
 *
 * u, v are in -1..1 across the disc; `r` is the radius from centre (0..1).
 */

/* helper: soft step used to keep decoration edges 1px crisp, not feathered */
const band = (x, edge, w = 0.04) => (x < edge - w ? 0 : x > edge + w ? 1 : (x - edge + w) / (2 * w));

export const FRUIT_ART = [
  /* 0 cherry ---------------------------------------------------------- */
  {
    shadow: hex(0x4a0a1a), light: hex(0xff6f7e), hueShift: hex(0xd6244a),
    outline: hex(0x2a0512), stem: { colour: hex(0x4c7a2b), len: 0.55 },
    albedo(u, v) {
      // A crease down the cherry's face, offset from centre.
      const crease = Math.abs(u * 0.9 + v * 0.1);
      return crease < 0.10 ? 0.82 : 1;
    },
  },
  /* 1 strawberry ------------------------------------------------------ */
  {
    shadow: hex(0x5e0c1c), light: hex(0xff8a80), hueShift: hex(0xe03048),
    outline: hex(0x33060f), leaf: hex(0x4f8f34),
    speckle: { colour: hex(0xffe7a8), density: 0.055, size: 1 },
    albedo() { return 1; },
  },
  /* 2 grape ----------------------------------------------------------- */
  {
    shadow: hex(0x240d3c), light: hex(0xc79bea), hueShift: hex(0x7b39b0),
    outline: hex(0x160724), stem: { colour: hex(0x4c7a2b), len: 0.4 },
    // Lobes: three overlapping berries read as a cluster at any size.
    albedo(u, v) {
      const lobes = [[-0.38, 0.18, 0.52], [0.36, 0.2, 0.5], [0, -0.32, 0.5]];
      let best = 1;
      for (const [lx, ly, lr] of lobes) {
        const d = Math.hypot(u - lx, v - ly) / lr;
        if (d < 1) best = Math.min(best, 0.86 + 0.14 * (1 - d));
      }
      // Darken the seams between lobes.
      return best;
    },
  },
  /* 3 dekopon --------------------------------------------------------- */
  {
    shadow: hex(0x8f3a04), light: hex(0xffd27a), hueShift: hex(0xf07d1c),
    outline: hex(0x4a1c02), stem: { colour: hex(0x4c7a2b), len: 0.3 },
    // Citrus pores: a fine dither of slightly darker texels.
    pore: { colour: hex(0xc4590c), density: 0.16 },
    albedo(u, v) { return v < -0.62 ? 0.9 : 1; },
  },
  /* 4 persimmon ------------------------------------------------------- */
  {
    shadow: hex(0x74260a), light: hex(0xffb15c), hueShift: hex(0xe2650f),
    outline: hex(0x3d1204), calyx: hex(0x3f6b27),
    albedo(u, v) {
      // Four faint vertical facets, like a real persimmon.
      const f = Math.abs(Math.sin(u * Math.PI * 2));
      return 0.94 + 0.06 * f;
    },
  },
  /* 5 apple ----------------------------------------------------------- */
  {
    shadow: hex(0x5d0c14), light: hex(0xff7a63), hueShift: hex(0xd42a24),
    outline: hex(0x310509), stem: { colour: hex(0x6b4a22), len: 0.42 }, leaf: hex(0x4f9236),
    albedo(u, v) {
      // Vertical streaking, the giveaway detail on a red apple.
      const s = Math.sin(u * 7.3 + v * 0.8);
      return 0.93 + 0.07 * (s * 0.5 + 0.5);
    },
  },
  /* 6 pear ------------------------------------------------------------ */
  {
    shadow: hex(0x53661a), light: hex(0xe9f08a), hueShift: hex(0xa8bf35),
    outline: hex(0x2c3a0c), stem: { colour: hex(0x6b4a22), len: 0.5 },
    speckle: { colour: hex(0xbfa85c), density: 0.05, size: 1 },
    albedo() { return 1; },
  },
  /* 7 peach ----------------------------------------------------------- */
  {
    shadow: hex(0x8a2a3a), light: hex(0xffd0a8), hueShift: hex(0xf2748a),
    outline: hex(0x4a1220), leaf: hex(0x4f9236),
    albedo(u, v) {
      // The signature cleft.
      const c = Math.abs(u * 0.95 + v * 0.15);
      return c < 0.09 ? 0.78 : 1;
    },
  },
  /* 8 pineapple ------------------------------------------------------- */
  {
    shadow: hex(0x7a4a05), light: hex(0xffe07a), hueShift: hex(0xd99a12),
    outline: hex(0x3d2402), crown: hex(0x3f7d2a),
    albedo(u, v) {
      // Diamond crosshatch. Frequency is tuned per-size at bake time so small
      // pineapples do not turn into moire soup.
      const a = Math.sin((u + v) * 9.0);
      const b = Math.sin((u - v) * 9.0);
      const edge = Math.max(Math.abs(a), Math.abs(b));
      return edge < 0.22 ? 0.74 : 1;
    },
  },
  /* 9 melon ----------------------------------------------------------- */
  {
    shadow: hex(0x63752c), light: hex(0xeff5c0), hueShift: hex(0xa9bd5e),
    outline: hex(0x35401a), stem: { colour: hex(0x6b7a2a), len: 0.3 },
    // Netting is drawn as raised lighter veins over the base.
    net: { colour: hex(0xf6f7d8), freq: 6.5 },
    albedo() { return 1; },
  },
  /* 10 watermelon ----------------------------------------------------- */
  {
    shadow: hex(0x14361a), light: hex(0x8fd36a), hueShift: hex(0x3f8a35),
    outline: hex(0x0c2010),
    stripe: { colour: hex(0x123a1c), count: 7 },
    albedo() { return 1; },
  },
];
