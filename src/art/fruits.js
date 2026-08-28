import { hex, stopsOf, hash1 } from './palette.js';
import { leaf, stroke, bezier, discOver } from './canvas.js';

/**
 * Per-fruit art definitions.
 *
 * A fruit is four things here, and the last two are what stop it from being a
 * coloured ball:
 *
 *   stops   ONE authored 5-stop ramp, darkest -> lightest, shadows cool and
 *           highlights warm. Everything on the body is drawn from it.
 *   height  an object-space height field. The shader takes its normal from
 *           this, so silhouette and shading always agree: a pear necks in, a
 *           peach has a real cleft, a grape is genuinely seven berries.
 *   surf    markings, returned as an *offset in ramp stops* rather than a
 *           colour. A watermelon stripe is "this ramp, two stops down", so a
 *           marking can never introduce a colour the ramp does not contain —
 *           which is the whole difference between authored pixel art and a
 *           resampled render.
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
 * Sample a half-width profile into a lookup over [lo, hi], zero outside it.
 *
 * Profiles are evaluated five times per texel of every rotation frame, so a
 * closed form with a fractional `pow` in it costs more than the whole rest of
 * the bake; and a table clamped at its domain edge trails the last width off
 * the sprite as a column instead of closing the silhouette.
 */
function profileLut(f, lo = -1, hi = 1, passes = 0) {
  const N = 320;
  const lut = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) lut[i] = Math.max(0, f(lo + ((hi - lo) * i) / N));
  for (let pass = 0; pass < passes; pass++) {
    const c = lut.slice();
    for (let i = 1; i < N; i++) lut[i] = (c[i - 1] + 2 * c[i] + c[i + 1]) * 0.25;
  }
  lut[0] = 0;
  lut[N] = 0;
  const scale = N / (hi - lo);
  return (v) => {
    if (v <= lo || v >= hi) return 0;
    const x = (v - lo) * scale;
    const i = x | 0;
    return lut[i] + (lut[i + 1] - lut[i]) * (x - i);
  };
}

/** Piecewise-linear read of a sparse control table. */
const interp = (pts) => (v) => {
  let k = 0;
  while (k < pts.length - 2 && pts[k + 1][0] < v) k++;
  const [v0, w0] = pts[k];
  const [v1, w1] = pts[k + 1];
  return w0 + (w1 - w0) * Math.max(0, Math.min(1, (v - v0) / (v1 - v0)));
};

/** Half-width of a unit circle at height v — the baseline every fruit bends. */
const circle = (v) => (v > -1 && v < 1 ? Math.sqrt(1 - v * v) : 0);

/**
 * A silhouette authored as *multipliers on that circle*, optionally squashed
 * and widened. Authoring absolute half-widths instead interpolates the circle
 * into a rounded box, and a boxy melon is the first thing that betrays
 * generated art — the deviation from round is the part worth hand-authoring.
 */
function shaped(mult, squash = 1, width = 1) {
  const f = mult && interp(mult);
  return profileLut((v) => {
    const t = v / squash;
    return circle(t) * width * (f ? f(t) : 1);
  }, -squash, squash, 6);
}

/** Barrel: a superellipse, flat-ish top and bottom with straight sides. */
const barrel = (p) => profileLut((v) => (1 - Math.abs(v) ** p) ** (1 / p), -1, 1);

/** Absolute half-width table, for shapes no circle multiplier can describe. */
const absProfile = (pts) => profileLut(interp(pts), pts[0][0], pts[pts.length - 1][0], 8);

/** One texel either side, for the profile slope. Smaller just samples noise. */
const DV = 0.006;

/**
 * Spin a half-width profile around the vertical axis into a height field.
 *
 * At (u, v) the surface of the solid of revolution sits at
 * `sqrt(w(v)^2 - u^2)`, zero outside the silhouette. Feeding the plain circle
 * profile through this returns exactly a unit sphere, so every fruit's shading
 * and its silhouette are derived from the same function and can never
 * disagree — which is what stops a hand-tweaked outline from reading as a
 * decal stuck on a ball.
 *
 * The gradient comes with it in closed form: differencing the height field
 * itself costs four extra profile lookups per texel for the same answer.
 */
function revolve(profile) {
  const H = (u, v) => {
    const w = profile(v);
    if (w <= 0) return 0;
    const q = w * w - u * u;
    return q > 0 ? Math.sqrt(q) : 0;
  };
  H.grad = (u, v, h, out) => {
    const w = profile(v);
    out[0] = -u / h;
    out[1] = (w * (profile(v + DV) - profile(v - DV))) / (2 * DV * h);
  };
  return H;
}

/** Press a rounded well into a height field — stem and calyx sockets. */
function dip(h, u, v, cu, cv, rad, amt) {
  const du = u - cu;
  const dv = v - cv;
  const t = 1 - Math.sqrt(du * du + dv * dv) / rad;
  if (t <= 0) return h;
  return h * (1 - amt * t * t * (3 - 2 * t));
}

/** Longitude of an object-space point, for markings that must follow the form. */
const longitude = (u, v) => {
  const cosLat = Math.sqrt(Math.max(1e-4, 1 - v * v));
  return Math.asin(Math.max(-1, Math.min(1, u / cosLat)));
};

/**
 * Blue-noise scatter by best-candidate selection.
 *
 * A golden-angle spiral looks even in the abstract but lays its points on
 * phyllotaxis arcs, which a viewer reads as a crosshatch laid over the fruit.
 * Picking the farthest of a few candidates each time has no such structure.
 */
function scatter(n, salt, spread = 0.84) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    let best = null;
    let bestD = -1;
    for (let k = 0; k < 8; k++) {
      const a = hash1(i * 64 + k, salt) * Math.PI * 2;
      const rr = Math.sqrt(hash1(i * 64 + k, salt + 977)) * spread;
      const p = [Math.cos(a) * rr, Math.sin(a) * rr];
      let d = 1e9;
      for (const q of pts) d = Math.min(d, (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2);
      if (d > bestD) { bestD = d; best = p; }
    }
    pts.push(best);
  }
  return pts;
}

/**
 * Jittered-lattice Worley noise, returning the gap between the two nearest
 * seeds — near zero exactly on a cell wall. Nine candidates per lookup, so
 * netting can be as fine as real muskmelon rind without the cost of a global
 * point set.
 */
function worley(x, y, freq, salt) {
  const fx = x * freq;
  const fy = y * freq;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  let d1 = 1e9;
  let d2 = 1e9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i;
      const cy = iy + j;
      const px = cx + hash1(cx * 7919 + cy, salt);
      const py = cy + hash1(cx * 104729 + cy, salt + 31);
      const d = Math.hypot(fx - px, fy - py);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
  }
  return d2 - d1;
}

/* ---- shared part colours ------------------------------------------ *
 * One green, one brown, one outline for the whole sprite sheet. Every extra
 * tone an appendage introduces counts against the fruit's colour budget. */

const LEAF_D = hex(0x1b3a14);
const LEAF_M = hex(0x37701f);
const LEAF_L = hex(0x63a832);
const BROWN_D = hex(0x35240f);
const BROWN_L = hex(0x7d5a28);
const PART_OUTLINE = 0x0e1a09;

/* ---- silhouettes --------------------------------------------------- */

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

/**
 * The pear: a head sphere and a belly sphere joined by a smooth union.
 *
 * Its whole identity is the *concave* shoulder between the two. Any profile
 * authored as a single monotonic curve stays convex from apex to belly and
 * comes out a spinning top, which is exactly what the first attempt did.
 */
const pearHead = interp([
  [-1, 0], [-0.94, 0.24], [-0.86, 0.37], [-0.76, 0.44], [-0.64, 0.475],
  [-0.52, 0.49], [-0.4, 0.51], [-0.3, 0.55], [-0.2, 0.62], [-0.1, 0.55], [0, 0],
]);
const pearProf = profileLut((v) => {
  const belly = 0.7 * 0.7 - (v - 0.3) ** 2;
  return Math.max(pearHead(v), belly > 0 ? Math.sqrt(belly) * 1.428 : 0);
}, -1, 1, 25);

const peachProf = shaped([
  [-1, 0.97], [-0.4, 1.03], [0, 1.03], [0.5, 0.99], [0.8, 0.95], [1, 0.86],
], 0.99);

const pineProf = barrel(2.35);

const melonH = revolve(shaped(null, 0.99));

const PEAR_DOTS = scatter(46, 0x9a13, 0.82);
const DEKO_PORES = scatter(74, 0x33ab, 0.88);
const STRAW_SEEDS = scatter(24, 0x77c1, 0.76);

/* ---- fruit table --------------------------------------------------- */

export const FRUIT_ART = [
  /* 0 cherry ---------------------------------------------------------- *
   * Deep crimson and darker than the strawberry above it, per the bible's
   * danger pair. Three stops, no markings at all, all identity in the stem. */
  {
    name: 'cherry',
    pad: 10,
    ramp: [0x30040e, 0x5e0818, 0x8e1028, 0xb81f3c, 0xd94a5c],
    outlineHex: 0x1a0208,
    hiHex: 0xf08494,
    height(u, v) {
      return dip(cherryH(u, v), u, v, 0.04, -0.88, 0.34, 0.55);
    },
    parts(ov, c) {
      // Brown, not green: the strawberry owns the green topper in this pair.
      stroke(ov, bezier(c.proj(0.06, -0.86), c.proj(0.42, -1.6), c.proj(0.88, -1.86), 14), 1, 1, BROWN_L);
    },
  },

  /* 1 strawberry ------------------------------------------------------ *
   * Lighter and more scarlet than the cherry, cone silhouette, pale seeds
   * and a wide green calyx. */
  {
    name: 'strawberry',
    pad: 8,
    ramp: [0x6e0f14, 0xa81a1c, 0xdc3020, 0xf05a34, 0xff8f5e],
    outlineHex: 0x39060a,
    hiHex: 0xffc890,
    height: strawH,
    surf(c) {
      for (const [su, sv] of STRAW_SEEDS) {
        const du = c.u - su;
        const dv = c.v - sv;
        if (du * du + dv * dv < 0.005) return 2;
        const dw = dv - 0.085;
        if (du * du + dw * dw < 0.005) return -1.4;
      }
      return 0;
    },
    parts(ov, c) {
      const [hx, hy] = c.proj(0, -0.9);
      const spread = [[-0.78, -0.28], [-0.42, -0.62], [0.05, -0.78], [0.5, -0.6], [0.82, -0.26]];
      for (const [du, dv] of spread) {
        leaf(ov, hx, hy, ...c.proj(du * 0.72, -0.9 + dv * 0.46), Math.max(1.2, c.R * 0.15), LEAF_D, LEAF_M, LEAF_L);
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
    ramp: [0x220b3a, 0x3f1568, 0x62279a, 0x8b4ac4, 0xb87ee4],
    outlineHex: 0x110520,
    hiHex: 0xd9b6f7,
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
      return h2 > 0 && h1 - h2 < 0.05 ? -1.5 : 0;
    },
    parts(ov, c) {
      stroke(ov, bezier(c.proj(-0.02, -0.9), c.proj(0.1, -1.2), c.proj(0.3, -1.34), 8), 2, 1, BROWN_L);
    },
  },

  /* 3 dekopon --------------------------------------------------------- *
   * Pushed to gold so tiers 3/4/5 read as gold -> orange -> red instead of
   * one orange mass. The bump on the crown is in the height field, so it
   * catches its own highlight and shadows the shoulder below it. */
  {
    name: 'dekopon',
    pad: 6,
    ramp: [0x8a4a02, 0xc27a06, 0xe8a80e, 0xffc832, 0xffe884],
    outlineHex: 0x472301,
    hiHex: 0xfff6cc,
    height(u, v) {
      const p = Math.max(dekoBody(v), dekoBump(v));
      const q = p * p - u * u;
      return q > 0 ? Math.sqrt(q) : 0;
    },
    surf(c) {
      for (const [su, sv] of DEKO_PORES) {
        const du = c.u - su;
        const dv = c.v - sv;
        if (du * du + dv * dv < 0.0022) return -1.5;
      }
      return 0;
    },
    parts(ov, c) {
      const [bx, by] = c.proj(0, -0.98);
      leaf(ov, bx, by, ...c.proj(-0.62, -1.16), Math.max(1.3, c.R * 0.12), LEAF_D, LEAF_M, LEAF_L);
      leaf(ov, bx, by, ...c.proj(0.5, -1.24), Math.max(1.3, c.R * 0.12), LEAF_D, LEAF_M, LEAF_L);
    },
  },

  /* 4 persimmon ------------------------------------------------------- *
   * Squat body, vivid orange, and the four-lobed green calyx on the crown is
   * the whole reason this never gets mistaken for the dekopon below it. */
  {
    name: 'persimmon',
    pad: 6,
    ramp: [0x6b1e04, 0xa33a06, 0xd85c0c, 0xf5842a, 0xffae5c],
    outlineHex: 0x360d01,
    hiHex: 0xffd9a2,
    height(u, v) {
      return dip(persimmonH(u, v), u, v, 0, -0.8, 0.5, 0.3);
    },
    surf(c) {
      // Four soft vertical facets, the way a real persimmon creases.
      return Math.cos(longitude(c.u, c.v) * 4) * 0.35;
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
    },
  },

  /* 5 apple ----------------------------------------------------------- */
  {
    name: 'apple',
    pad: 8,
    ramp: [0x4e0c1c, 0x841426, 0xb81e34, 0xdc3a48, 0xf76e70],
    outlineHex: 0x28050f,
    hiHex: 0xffb0aa,
    height(u, v) {
      const p = appleProf(v);
      const q = p * p - u * u;
      if (q <= 0) return 0;
      let h = Math.sqrt(q);
      h = dip(h, u, v, 0, -0.86, 0.42, 0.62);
      return dip(h, u, v, 0, 0.9, 0.34, 0.4);
    },
    surf(c) {
      // Longitudinal streaks, faded out at the poles so they converge with
      // the form instead of running as parallel lines down a cylinder.
      const taper = Math.cos(Math.asin(Math.max(-1, Math.min(1, c.v)))) ** 1.4;
      const lon = longitude(c.u, c.v);
      const s = Math.sin(lon * 5.4 + Math.sin(c.v * 2.1) * 0.6);
      return s > 0.3 ? -1.4 * taper : 0;
    },
    parts(ov, c) {
      stroke(ov, bezier(c.proj(0, -0.84), c.proj(0.06, -1.08), c.proj(0.16, -1.24), 8), 2, 2, BROWN_L);
      leaf(ov, ...c.proj(0.14, -1.16), ...c.proj(0.86, -1.16), Math.max(2, c.R * 0.13), LEAF_D, LEAF_M, LEAF_L);
    },
  },

  /* 6 pear ------------------------------------------------------------ */
  {
    name: 'pear',
    pad: 14,
    ramp: [0x445211, 0x6d8619, 0x9ab52c, 0xc4d75e, 0xe8f099],
    outlineHex: 0x1f2a08,
    hiHex: 0xfaffd0,
    height: revolve(pearProf),
    surf(c) {
      for (const [su, sv] of PEAR_DOTS) {
        const du = c.u - su;
        const dv = c.v - sv;
        if (du * du + dv * dv < 0.0016) return -1.6;
      }
      return 0;
    },
    parts(ov, c) {
      // Straight up out of the apex and thick enough to survive at 1x: the
      // side-mounted stub it replaced read as no stem at all.
      stroke(ov, [c.proj(0, -0.94), c.proj(0.04, -1.36)], 3, 3, BROWN_L);
      leaf(ov, ...c.proj(0.05, -1.2), ...c.proj(0.7, -1.26), Math.max(1.8, c.R * 0.11), LEAF_D, LEAF_M, LEAF_L);
    },
  },

  /* 7 peach ----------------------------------------------------------- *
   * One ramp that runs deep crimson -> coral -> warm cream. The blush is a
   * region shifted *down that same ramp*, not a second palette: two ramps
   * meeting on a chord is what produced the flat ochre wedge before. */
  {
    name: 'peach',
    pad: 12,
    ramp: [0x6e1526, 0xa8303c, 0xd85f56, 0xf2996e, 0xffdaa8],
    outlineHex: 0x38091a,
    hiHex: 0xfff0d4,
    height(u, v) {
      const p = peachProf(v);
      const q = p * p - u * u;
      if (q <= 0) return 0;
      const h = Math.sqrt(q);
      // The cleft follows a meridian, so it bows with the surface and narrows
      // toward the poles. Centred on the axis it would project to a
      // dead-straight line and read as a UV seam rather than a crease.
      const cl = Math.sqrt(Math.max(0.02, 1 - v * v));
      const du = (u + 0.41 * cl) / (0.17 * cl);
      if (du * du >= 1) return h;
      const g = (1 - du * du) ** 2 * Math.max(0, Math.min(1, (0.72 - v) / 1.2));
      return h * (1 - 0.34 * g);
    },
    surf(c) {
      // Blush: centred, so a spinning peach keeps its colour, with a wobbly
      // edge and a soft falloff the ramp quantiser dithers on its own.
      const du = c.u - 0.05;
      const dv = c.v - 0.04;
      const a = Math.atan2(dv, du);
      const edge = 0.76 + Math.sin(a * 2 + 0.5) * 0.05 + Math.sin(a * 3 - 1.2) * 0.03;
      // Wide falloff: the ramp quantiser turns it into two soft-edged bands
      // rather than the hard-rimmed patch a tight one reads as a stain.
      return -0.95 * Math.max(0, Math.min(1, (edge - Math.hypot(du, dv)) / 0.42));
    },
    parts(ov, c) {
      stroke(ov, [c.proj(-0.06, -0.98), c.proj(-0.02, -1.16)], 2, 2, BROWN_D);
      leaf(ov, ...c.proj(0, -1.1), ...c.proj(0.74, -1.32), Math.max(2, c.R * 0.12), LEAF_D, LEAF_M, LEAF_L);
    },
  },

  /* 8 pineapple ------------------------------------------------------- *
   * Barrel body, diamond lattice in spherical coordinates so the cells
   * compress toward the silhouette, spiky crown on top. */
  {
    name: 'pineapple',
    pad: 22,
    ramp: [0x5e3406, 0x8a5209, 0xb87c10, 0xd9a428, 0xf5cc60],
    outlineHex: 0x2b1802,
    hiHex: 0xffefb0,
    height(u, v) {
      const p = pineProf(v);
      const q = p * p - u * u;
      return q > 0 ? Math.sqrt(q) : 0;
    },
    surf(c) {
      const lat = Math.asin(Math.max(-1, Math.min(1, c.v)));
      const lon = longitude(c.u, c.v);
      const a = lon * 2.6 + lat * 3;
      const b = lon * 2.6 - lat * 3;
      const fa = Math.abs(a - Math.round(a));
      const fb = Math.abs(b - Math.round(b));
      if (fa < 0.13 || fb < 0.13) return -1.7;
      // A raised pip at the centre of every scale.
      return fa > 0.38 && fb > 0.38 ? 0.7 : 0;
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
   * Fine sinuous netting from jittered Worley cells, sampled in warped
   * coordinates so the web tightens toward the silhouette. */
  {
    name: 'melon',
    pad: 9,
    ramp: [0x54622a, 0x7f9046, 0xa8b86e, 0xcdd89c, 0xecf2c8],
    outlineHex: 0x252c11,
    hiHex: 0xfdffe0,
    height: melonH,
    surf(c) {
      const e = worley(c.uw, c.vw, 9.5, 0x51ce);
      if (e < 0.17) return 1.6;
      // One texel of shadow just inside each ridge sells the net as raised.
      return e < 0.34 ? -0.8 : 0;
    },
    parts(ov, c) {
      stroke(ov, [c.proj(0, -0.96), c.proj(0.02, -1.16)], 3, 3, BROWN_L);
      stroke(ov, [c.proj(-0.24, -1.16), c.proj(0.26, -1.16)], 3, 3, BROWN_D);
    },
  },

  /* 10 watermelon ----------------------------------------------------- *
   * Stripes wander with latitude instead of running as clean sine bands —
   * the wobble is the difference between a melon and a beach ball. */
  {
    name: 'watermelon',
    pad: 10,
    ramp: [0x0f3418, 0x1d5c26, 0x2e8a38, 0x4fb04e, 0x86d472],
    outlineHex: 0x041408,
    hiHex: 0xcdf0a4,
    height: melonH,
    surf(c) {
      const lat = Math.asin(Math.max(-1, Math.min(1, c.v)));
      const s = longitude(c.u, c.v) * 1.7
        + Math.sin(lat * 3.3) * 0.26
        + Math.sin(lat * 7.1 + 1.3) * 0.12
        + Math.sin(lat * 12.7 + 0.4) * 0.05;
      return Math.abs(s - Math.round(s)) < 0.2 ? -2.4 : 0;
    },
    parts(ov, c) {
      stroke(ov, bezier(c.proj(0, -0.94), c.proj(0.16, -1.16), c.proj(0.42, -1.06), 10), 3, 2, BROWN_L);
    },
  },
];

/* Derived fields. `shadow`/`light`/`hueShift`/`outline` are the contract the
 * FX module reads to tint debris, so they stay anchored to the authored ramp. */
for (const art of FRUIT_ART) {
  art.stops = stopsOf(art.ramp);
  art.shadow = art.stops[0];
  art.light = art.stops[4];
  art.hueShift = art.stops[2];
  art.outline = hex(art.outlineHex);
  art.hi = hex(art.hiHex);
  art.partOutline = hex(PART_OUTLINE);
}
