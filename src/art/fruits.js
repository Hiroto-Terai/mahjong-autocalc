import { hex, stopsOf, hash1, bayer, mix } from './palette.js';
import { leaf, stroke, bezier, discOver } from './canvas.js';

/**
 * Per-fruit art definitions.
 *
 * A fruit is four things here, and the last two are what stop it from being a
 * coloured ball:
 *
 *   ramps   authored 5-stop palettes, darkest -> lightest. Ramp 0 is the skin;
 *           extra ramps are markings (a watermelon stripe is a *different
 *           ramp at the same lighting index*, never the skin ramp darkened).
 *   height  an object-space height field. The shader takes its normal from
 *           this, so silhouette and shading always agree: a pear tapers, a
 *           peach has a real cleft, a grape is genuinely seven berries.
 *   surface markings clipped to the body — seeds, pores, netting, streaks.
 *   parts   stems, leaves, calyxes, crowns. These break the circle, and
 *           breaking the circle is most of what makes a fruit read as fruit.
 *
 * u, v are object space in -1..1 across the disc (v positive downward), so all
 * of it rotates with the physics body while the key light stays in screen
 * space. Detail level `d` (0 tiny .. 4 huge) gates everything a small sprite
 * has no texels to spend on.
 */

/** Size bracket. A 16px cherry and a 100px watermelon cannot share settings. */
export const detailFor = (r) => (r <= 11 ? 0 : r <= 20 ? 1 : r <= 29 ? 2 : r <= 39 ? 3 : 4);

/* ---- shape helpers ------------------------------------------------ */

/**
 * Smooth a sparse control table into a lookup. Hand-placing a dozen points
 * beats any closed form for getting a pear to look like a pear.
 */
function tableCurve(pts) {
  const N = 256;
  const lut = new Float32Array(N + 1);
  let k = 0;
  for (let i = 0; i <= N; i++) {
    const v = -1 + (2 * i) / N;
    while (k < pts.length - 2 && pts[k + 1][0] < v) k++;
    const [v0, w0] = pts[k];
    const [v1, w1] = pts[k + 1];
    const t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0)));
    lut[i] = w0 + (w1 - w0) * t;
  }
  for (let pass = 0; pass < 18; pass++) {
    const c = lut.slice();
    for (let i = 1; i < N; i++) lut[i] = (c[i - 1] + 2 * c[i] + c[i + 1]) * 0.25;
  }
  return (v) => {
    if (v <= -1) return lut[0];
    if (v >= 1) return lut[N];
    const f = (v + 1) * 0.5 * N;
    const i = f | 0;
    return lut[i] + (lut[i + 1] - lut[i]) * (f - i);
  };
}

/** Half-width of a unit circle at height v — the baseline every fruit bends. */
const circle = (v) => (v > -1 && v < 1 ? Math.sqrt(1 - v * v) : 0);

/**
 * A silhouette authored as *multipliers on that circle*, optionally squashed
 * and widened. Authoring absolute half-widths instead interpolates the circle
 * into a rounded box, and a boxy melon is the first thing that betrays
 * generated art — the deviation from round is the part worth hand-authoring.
 */
function shaped(mult, squash = 1, width = 1) {
  const f = mult && tableCurve(mult);
  return (v) => {
    const t = v / squash;
    if (t <= -1 || t >= 1) return 0;
    return circle(t) * width * (f ? f(t) : 1);
  };
}

/**
 * Spin a half-width profile around the vertical axis into a height field.
 *
 * At (u, v) the surface of the solid of revolution sits at
 * `sqrt(w(v)^2 - u^2)`, zero outside the silhouette. Feeding the plain circle
 * profile through this returns exactly a unit sphere, so every fruit's shading
 * and its silhouette are derived from the same function and can never
 * disagree — which is what stops a hand-tweaked outline from reading as a
 * decal stuck on a ball.
 */
function revolve(profile) {
  return (u, v) => {
    const w = profile(v);
    if (w <= 0) return 0;
    const uu = u * u;
    const ww = w * w;
    return uu >= ww ? 0 : Math.sqrt(ww - uu);
  };
}

/** Barrel: a superellipse, flat-ish top and bottom with straight sides. */
const barrel = (p) => (v) => (Math.abs(v) >= 1 ? 0 : (1 - Math.abs(v) ** p) ** (1 / p));

/** Absolute half-width table, for shapes that are not circle-derived. */
const absProfile = (pts) => {
  const f = tableCurve(pts);
  return (v) => Math.max(0, f(v));
};

/** Press a rounded well into a height field — stem and calyx sockets. */
function dip(h, u, v, cu, cv, rad, amt) {
  const t = 1 - Math.hypot(u - cu, v - cv) / rad;
  if (t <= 0) return h;
  return h * (1 - amt * t * t * (3 - 2 * t));
}

/** Scatter n points over the disc, deterministic per fruit and per frame. */
function scatter(n, salt, spread = 0.84) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    // Golden-angle spiral: even coverage without clumping, unlike pure random.
    const a = i * 2.399963 + hash1(i, salt) * 0.9;
    const rr = Math.sqrt((i + 0.6) / n) * spread;
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  return pts;
}

/* ---- shared part colours ------------------------------------------ */

const LEAF_D = hex(0x1d3a17);
const LEAF_M = hex(0x3f7429);
const LEAF_L = hex(0x6cae3d);
const BROWN_D = hex(0x3a2712);
const BROWN_M = hex(0x6d4c24);
const BROWN_L = hex(0x9a7440);
const STEM_G = hex(0x5c8a2e);
const PART_OUTLINE = 0x131e0d;

/* ---- fruit table --------------------------------------------------- */

const cherryH = revolve(shaped(null, 0.97, 1.02));

const strawH = revolve(shaped([
  [-1, 1.02], [-0.6, 1.12], [-0.35, 1.12], [-0.1, 1], [0.15, 0.88],
  [0.4, 0.75], [0.65, 0.62], [0.85, 0.5], [1, 0.42],
]));

const GRAPE_BERRIES = (() => {
  const out = [[0, 0.02, 0.46]];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.5;
    out.push([Math.cos(a) * 0.57, Math.sin(a) * 0.57 + 0.02, 0.44]);
  }
  return out;
})();

const dekoBody = shaped(null, 0.97, 1.02);
/** The crown bump, in absolute units, so it can stand proud of the body. */
const dekoBump = absProfile([
  [-1.24, 0], [-1.16, 0.2], [-1.06, 0.33], [-0.92, 0.37], [-0.8, 0.3], [-0.7, 0], [1, 0],
]);

const persimmonH = revolve(shaped(null, 0.93, 1.05));

const appleProf = shaped([
  [-1, 0.97], [-0.5, 1.02], [0, 1.03], [0.5, 1.01], [1, 0.93],
], 0.97, 1.03);

const pearProf = shaped([
  [-1, 0.6], [-0.9, 0.6], [-0.7, 0.48], [-0.5, 0.46], [-0.3, 0.545], [-0.1, 0.7],
  [0.1, 0.855], [0.3, 1.006], [0.5, 1.14], [0.7, 1.3], [0.85, 1.37], [1, 1.35],
]);

const peachProf = shaped([
  [-1, 0.97], [-0.4, 1.03], [0, 1.03], [0.5, 0.99], [0.8, 0.95], [1, 0.86],
], 0.99);

const pineProf = barrel(2.35);

const melonH = revolve(shaped(null, 0.99));

const MELON_NET = scatter(82, 0x51ce, 1.04);
const PEAR_DOTS = scatter(34, 0x9a13, 0.8);
const DEKO_PORES = scatter(66, 0x33ab, 0.88);
const STRAW_SEEDS = scatter(26, 0x77c1, 0.78);

export const FRUIT_ART = [
  /* 0 cherry ---------------------------------------------------------- *
   * Tiny: three stops, no surface markings at all, and every scrap of
   * identity carried by one long curved stem. */
  {
    name: 'cherry',
    pad: 10,
    ramps: [[0x4a0a1e, 0x8a1030, 0xc4183f, 0xe83d5c, 0xff7a86]],
    outlineHex: 0x2b0614,
    bounceHex: 0x7b2b52,
    hiHex: 0xffc9cd,
    height(u, v) {
      return dip(cherryH(u, v), u, v, 0.04, -0.88, 0.34, 0.55);
    },
    parts(ov, c) {
      const path = bezier(c.proj(0.06, -0.86), c.proj(0.42, -1.6), c.proj(0.88, -1.86), 14);
      stroke(ov, path, 1, 1, STEM_G);
    },
  },

  /* 1 strawberry ------------------------------------------------------ *
   * Cone silhouette + a green calyx + pale seeds. Nothing else here reads
   * differently from the cherry, so all three have to survive at 20px. */
  {
    name: 'strawberry',
    pad: 8,
    ramps: [[0x6b1010, 0xa81a1e, 0xe03328, 0xf4613c, 0xff9560]],
    outlineHex: 0x3d0810,
    bounceHex: 0x8f3a4e,
    hiHex: 0xffd2a4,
    height: strawH,
    surface(buf, c) {
      const seed = hex(0xffe08a);
      const shade = hex(0xc07a2e);
      for (const [u, v] of STRAW_SEEDS) {
        // Seeds sit in dimples: the pale grain plus one dark texel below it.
        const [x, y] = c.proj(u, v * 0.86 - 0.06);
        const px = Math.round(x);
        const py = Math.round(y);
        if (!c.solid(px, py)) continue;
        buf.over(px, py, c.lit(px, py) > 0.52 ? seed : shade);
        if (c.d >= 1) buf.over(px, py + 1, shade);
      }
    },
    parts(ov, c) {
      const [hx, hy] = c.proj(0, -0.9);
      const spread = [[-0.78, -0.28], [-0.42, -0.62], [0.05, -0.78], [0.5, -0.6], [0.82, -0.26]];
      for (const [du, dv] of spread) {
        const [tx, ty] = c.proj(du * 0.72, -0.9 + dv * 0.46);
        leaf(ov, hx, hy, tx, ty, Math.max(1.2, c.R * 0.15), LEAF_D, LEAF_M, LEAF_L);
      }
      stroke(ov, [c.proj(0, -1.02), c.proj(0.03, -1.3)], 1, 1, LEAF_M);
    },
  },

  /* 2 grape ----------------------------------------------------------- *
   * Seven overlapping berries, so the lobes come out of the height field and
   * are shaded as real bulges instead of being painted on. */
  {
    name: 'grape',
    pad: 6,
    ramps: [[0x2a1046, 0x4a1c78, 0x7433ad, 0x9d63d4, 0xc9a0ee]],
    outlineHex: 0x180828,
    bounceHex: 0x4d4aa2,
    hiHex: 0xe9d6ff,
    height(u, v) {
      let best = 0;
      for (const [bu, bv, br] of GRAPE_BERRIES) {
        const q = br * br - (u - bu) * (u - bu) - (v - bv) * (v - bv);
        if (q > 0) {
          const h = Math.sqrt(q);
          if (h > best) best = h;
        }
      }
      return best;
    },
    surf(c) {
      // Darken the crease where two berries meet — the seam that says cluster.
      let h1 = 0;
      let h2 = 0;
      for (const [bu, bv, br] of GRAPE_BERRIES) {
        const q = br * br - (c.u - bu) * (c.u - bu) - (c.v - bv) * (c.v - bv);
        if (q <= 0) continue;
        const h = Math.sqrt(q);
        if (h > h1) { h2 = h1; h1 = h; } else if (h > h2) h2 = h;
      }
      if (h2 > 0 && h1 - h2 < 0.05) c.add = -0.3;
      return 0;
    },
    parts(ov, c) {
      stroke(ov, bezier(c.proj(-0.02, -0.9), c.proj(0.1, -1.2), c.proj(0.3, -1.34), 8), 2, 1, BROWN_M);
    },
  },

  /* 3 dekopon --------------------------------------------------------- *
   * The bump on the crown is in the height field, so it catches its own
   * highlight and throws a shadow onto the shoulder below it. */
  {
    name: 'dekopon',
    pad: 6,
    ramps: [[0x8a3a04, 0xc26208, 0xef8c12, 0xffb43a, 0xffdc84]],
    outlineHex: 0x4a1c02,
    bounceHex: 0xa85c46,
    hiHex: 0xfff3c4,
    height(u, v) {
      const a = dekoBody(v);
      const b = dekoBump(v);
      const p = Math.max(a, b);
      const q = p * p - u * u;
      return q > 0 ? Math.sqrt(q) : 0;
    },
    surface(buf, c) {
      const pore = c.ramp(0)[0];
      for (const [u, v] of DEKO_PORES) {
        const [x, y] = c.proj(u, v);
        const px = Math.round(x);
        const py = Math.round(y);
        if (c.solid(px, py)) buf.over(px, py, mix(buf.get(px, py), pore, 0.55));
      }
    },
    parts(ov, c) {
      // Two small leaves tucked against the bump, angled apart.
      const [bx, by] = c.proj(0, -0.98);
      leaf(ov, bx, by, ...c.proj(-0.62, -1.16), Math.max(1.3, c.R * 0.12), LEAF_D, LEAF_M, LEAF_L);
      leaf(ov, bx, by, ...c.proj(0.5, -1.24), Math.max(1.3, c.R * 0.12), LEAF_D, LEAF_M, LEAF_L);
    },
  },

  /* 4 persimmon ------------------------------------------------------- *
   * Squat body, and the four-lobed green calyx sitting on the crown is the
   * whole reason this never gets mistaken for the dekopon below it. */
  {
    name: 'persimmon',
    pad: 6,
    ramps: [[0x6e1c06, 0xa8300a, 0xd9550f, 0xf4762a, 0xffb45c]],
    outlineHex: 0x3a0e02,
    bounceHex: 0x8f3a52,
    hiHex: 0xffd8a6,
    height(u, v) {
      return dip(persimmonH(u, v), u, v, 0, -0.8, 0.5, 0.3);
    },
    surf(c) {
      // Four soft vertical facets, the way a real persimmon creases.
      c.add = Math.cos(c.lon * 4) * 0.045;
      return 0;
    },
    parts(ov, c) {
      const [cxp, cyp] = c.proj(0, -0.7);
      const w = Math.max(1.6, c.R * 0.15);
      const lobes = [[-0.74, -0.2], [0.74, -0.2], [-0.4, 0.28], [0.4, 0.28]];
      for (const [du, dv] of lobes) {
        leaf(ov, cxp, cyp, ...c.proj(du, -0.7 + dv), w, LEAF_D, LEAF_M, LEAF_L);
      }
      leaf(ov, cxp, cyp, ...c.proj(0, -1.06), w * 0.8, LEAF_D, LEAF_M, LEAF_L);
      discOver(ov, cxp, cyp, Math.max(1, c.R * 0.07), BROWN_D);
      stroke(ov, [c.proj(0, -0.72), c.proj(0.02, -0.98)], 2, 2, BROWN_M);
    },
  },

  /* 5 apple ----------------------------------------------------------- */
  {
    name: 'apple',
    pad: 8,
    ramps: [
      [0x5c0c18, 0x931421, 0xcc2130, 0xe84a44, 0xff8067],
      [0x460a14, 0x77101a, 0xa81826, 0xc93a38, 0xe06a58],
    ],
    outlineHex: 0x2e0510,
    bounceHex: 0x7d3a60,
    hiHex: 0xffd8c4,
    height(u, v) {
      const p = appleProf(v);
      const q = p * p - u * u;
      if (q <= 0) return 0;
      let h = Math.sqrt(q);
      h = dip(h, u, v, 0, -0.86, 0.42, 0.62);
      return dip(h, u, v, 0, 0.9, 0.34, 0.4);
    },
    surf(c) {
      // Longitudinal streaking: a second, deeper ramp, never a darkened skin.
      const s = Math.sin(c.lon * 6.2 + Math.sin(c.lon * 2.7) * 0.8);
      return s > 0.32 ? 1 : 0;
    },
    parts(ov, c) {
      stroke(ov, bezier(c.proj(0, -0.84), c.proj(0.06, -1.08), c.proj(0.16, -1.24), 8), 2, 2, BROWN_M);
      const [sx, sy] = c.proj(0.14, -1.16);
      leaf(ov, sx, sy, ...c.proj(0.86, -1.16), Math.max(2, c.R * 0.13), LEAF_D, LEAF_M, LEAF_L);
    },
  },

  /* 6 pear ------------------------------------------------------------ */
  {
    name: 'pear',
    pad: 12,
    ramps: [[0x4c5a16, 0x77901f, 0xa4bd34, 0xcbdc68, 0xecf2a4]],
    outlineHex: 0x28320c,
    bounceHex: 0x5c7a72,
    hiHex: 0xfbffdc,
    height: revolve(pearProf),
    surface(buf, c) {
      if (c.d < 2) return;
      const dot = hex(0x8a7a3a);
      for (const [u, v] of PEAR_DOTS) {
        const [x, y] = c.proj(u * 0.9, v * 0.9 + 0.1);
        const px = Math.round(x);
        const py = Math.round(y);
        if (c.solid(px, py)) buf.over(px, py, mix(buf.get(px, py), dot, 0.5));
      }
    },
    parts(ov, c) {
      stroke(ov, bezier(c.proj(0.02, -0.96), c.proj(0.1, -1.16), c.proj(0.26, -1.28), 8), 2, 2, BROWN_M);
      leaf(ov, ...c.proj(0.2, -1.22), ...c.proj(0.86, -1.34), Math.max(1.8, c.R * 0.1), LEAF_D, LEAF_M, LEAF_L);
    },
  },

  /* 7 peach ----------------------------------------------------------- *
   * Two ramps blended across a dithered seam — a blush is the one place on
   * this sprite sheet where a wide dither band is the correct answer. */
  {
    name: 'peach',
    pad: 12,
    ramps: [
      [0x8a2438, 0xb8404f, 0xe0656a, 0xf2908a, 0xffbfa8],
      [0x8a4a26, 0xc07a34, 0xe0a248, 0xf2c46e, 0xffe8a8],
    ],
    outlineHex: 0x4a1424,
    bounceHex: 0x9c5a76,
    hiHex: 0xffeade,
    height(u, v) {
      const p = peachProf(v);
      const q = p * p - u * u;
      if (q <= 0) return 0;
      const h = Math.sqrt(q);
      // The cleft: a groove down the face, deepest at the top, fading below.
      const g = Math.exp(-((u + 0.1) * (u + 0.1)) / 0.012)
        * Math.max(0, Math.min(1, (0.8 - v) / 1.1));
      return h * (1 - 0.34 * g);
    },
    surf(c) {
      const b = (-c.u * 0.52 - c.v * 0.85 + 0.16) / 0.12;
      if (b > 1) return 0;
      if (b < 0) return 1;
      return b > bayer(c.px, c.py) ? 0 : 1;
    },
    parts(ov, c) {
      stroke(ov, [c.proj(-0.06, -0.98), c.proj(-0.02, -1.14)], 2, 2, BROWN_D);
      leaf(ov, ...c.proj(0, -1.08), ...c.proj(0.74, -1.3), Math.max(2, c.R * 0.12), LEAF_D, LEAF_M, LEAF_L);
    },
  },

  /* 8 pineapple ------------------------------------------------------- *
   * Barrel body, diamond lattice in spherical coordinates so the cells
   * compress toward the silhouette, spiky crown on top. */
  {
    name: 'pineapple',
    pad: 22,
    ramps: [
      [0x7a4406, 0xa8690c, 0xd49312, 0xecb734, 0xffd96e],
      [0x50290b, 0x74400e, 0x965c14, 0xb07c22, 0xc79c42],
    ],
    outlineHex: 0x3a2002,
    bounceHex: 0x8a6a44,
    hiHex: 0xfff2bc,
    height(u, v) {
      const p = pineProf(v);
      const q = p * p - u * u;
      return q > 0 ? Math.sqrt(q) : 0;
    },
    surf(c) {
      const a = c.lon * 2.6 + c.lat * 3.0;
      const b = c.lon * 2.6 - c.lat * 3.0;
      const fa = Math.abs(a - Math.round(a));
      const fb = Math.abs(b - Math.round(b));
      if (fa < 0.13 || fb < 0.13) return 1;
      // A raised pip at the centre of every scale.
      if (fa > 0.38 && fb > 0.38) c.add = 0.1;
      return 0;
    },
    parts(ov, c) {
      const w = Math.max(1.8, c.R * 0.075);
      const blades = [
        [-0.92, -1.2], [-0.54, -1.44], [-0.16, -1.56], [0.22, -1.52], [0.58, -1.38], [0.9, -1.12],
      ];
      // Back row first so the front blades overlap them, which reads as depth.
      for (const [du, dv] of blades) {
        leaf(ov, ...c.proj(du * 0.34, -0.86), ...c.proj(du, dv), w, LEAF_D, LEAF_D, LEAF_M);
      }
      for (const [du, dv] of [[-0.42, -1.3], [0.02, -1.46], [0.42, -1.26]]) {
        leaf(ov, ...c.proj(du * 0.3, -0.9), ...c.proj(du, dv), w * 1.15, LEAF_D, LEAF_M, LEAF_L);
      }
    },
  },

  /* 9 melon ----------------------------------------------------------- *
   * The netting is a Voronoi web, not a sine grid: real cantaloupe rind is
   * irregular, and a regular grid instantly reads as a shader. */
  {
    name: 'melon',
    pad: 9,
    ramps: [
      [0x5a6a2c, 0x86974a, 0xafbd72, 0xd2dca0, 0xeef2cc],
      [0x8a9a62, 0xb8c48c, 0xd8e0b4, 0xeef2d2, 0xfaffe8],
    ],
    outlineHex: 0x2e3a16,
    bounceHex: 0x6a7c92,
    hiHex: 0xffffe8,
    height: melonH,
    surf(c) {
      let d1 = 9;
      let d2 = 9;
      for (const [sx, sy] of MELON_NET) {
        const d = (c.uw - sx) * (c.uw - sx) + (c.vw - sy) * (c.vw - sy);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
      }
      const e = Math.sqrt(d2) - Math.sqrt(d1);
      if (e < 0.028) return 1;
      // One texel of shadow inside each ridge sells the netting as raised.
      if (e < 0.062) c.add = -0.14;
      return 0;
    },
    parts(ov, c) {
      const [sx, sy] = c.proj(0, -0.96);
      stroke(ov, [[sx, sy], c.proj(0.02, -1.16)], 3, 3, BROWN_M);
      stroke(ov, [c.proj(-0.24, -1.16), c.proj(0.26, -1.16)], 3, 3, BROWN_D);
    },
  },

  /* 10 watermelon ----------------------------------------------------- *
   * Stripes wander with latitude instead of running as clean sine bands —
   * the wobble is the difference between a melon and a beach ball. */
  {
    name: 'watermelon',
    pad: 10,
    ramps: [
      [0x14401e, 0x246c2e, 0x389c40, 0x5cbd5a, 0x92dc7c],
      [0x0c2612, 0x143f1c, 0x1e5a26, 0x2a7a32, 0x3f9642],
    ],
    outlineHex: 0x08180c,
    bounceHex: 0x2e5e72,
    hiHex: 0xdcf7b4,
    height: melonH,
    surf(c) {
      const s = c.lon * 1.7
        + Math.sin(c.lat * 3.3) * 0.26
        + Math.sin(c.lat * 7.1 + 1.3) * 0.12
        + Math.sin(c.lat * 12.7 + 0.4) * 0.05;
      const f = Math.abs(s - Math.round(s));
      return f < 0.2 ? 1 : 0;
    },
    parts(ov, c) {
      stroke(ov, bezier(c.proj(0, -0.94), c.proj(0.16, -1.16), c.proj(0.42, -1.06), 10), 3, 2, BROWN_M);
    },
  },
];

/* Derived fields. `shadow`/`light`/`hueShift`/`outline` are the contract the
 * FX module reads to tint debris, so they stay anchored to the authored ramp. */
for (const art of FRUIT_ART) {
  art.stops = art.ramps.map(stopsOf);
  art.shadow = art.stops[0][0];
  art.light = art.stops[0][4];
  art.hueShift = art.stops[0][2];
  art.outline = hex(art.outlineHex);
  art.bounce = hex(art.bounceHex);
  art.hi = hex(art.hiHex);
  art.partOutline = hex(art.partOutlineHex ?? PART_OUTLINE);
}
