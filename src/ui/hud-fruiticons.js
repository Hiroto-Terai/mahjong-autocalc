import { PixBuf } from '../art/canvas.js';
import { mix } from '../art/palette.js';

/**
 * Hand-authored miniature fruit, drawn at icon size.
 *
 * The art bible's fifth rule cuts both ways: a 9px icon cannot be a 100px
 * watermelon resampled, because box-filtering a dithered ramp averages it into
 * grey mud and throws away the only two things an icon can carry — a hue and
 * one identifying mark. So these are drawn from scratch: a three-stop disc, a
 * 1px outline, and one gesture per fruit, gated on how many texels there are
 * to spend.
 *
 * The palettes are pushed further apart than the full-size art deliberately.
 * At 9px the only separation between cherry, strawberry, apple, persimmon and
 * dekopon is hue plus the mark on top, so they run crimson / scarlet / red /
 * red-orange / amber, as far apart as each fruit can honestly be taken.
 */

/** Margin for stems, crowns and the outline. */
const PAD = 2;

const STEM = 0x6d4a20;
const LEAF = 0x54992f;

const ICON_ART = [
  { // cherry — the darkest red in the set, and the only bare stem.
    ramp: [0x59091d, 0x9c1130, 0xd63550], line: 0x2c0410,
    mark: (a) => {
      a.set(a.mx, a.top - 1, STEM);
      a.set(a.mx + 1, a.top - 2, STEM);
      if (a.d >= 11) a.set(a.mx + 2, a.top - 3, LEAF);
    },
  },
  { // strawberry — scarlet, seeded, with a calyx that breaks the silhouette.
    ramp: [0x93101f, 0xdd2f38, 0xff6a5c], line: 0x470713,
    mark: (a) => {
      for (const dx of [-1, 0, 1]) a.set(a.mx + dx, a.top, 0x4f9c2c);
      a.set(a.mx, a.top - 1, 0x67b83a);
      if (a.d >= 10) { a.set(a.mx - 2, a.top, 0x3f7f22); a.set(a.mx + 2, a.top, 0x3f7f22); }
      if (a.d >= 9) for (const [u, v] of [[-0.34, 0.02], [0.28, 0.3], [-0.06, 0.52], [0.42, -0.3]]) a.ink(u, v, 0xffe6ac);
    },
  },
  { // grape — the only violet; lobe seams instead of a smooth ball.
    ramp: [0x361a63, 0x6533a8, 0x9a63d8], line: 0x1d0d38,
    mark: (a) => {
      a.set(a.mx, a.top - 1, STEM);
      a.seam(-0.34, a.stops[0]);
      if (a.d >= 10) a.seam(0.42, a.stops[0]);
    },
  },
  { // dekopon — amber-gold, and the only fruit with a knob on its crown.
    ramp: [0xa85705, 0xef9412, 0xffc94f], line: 0x51290a,
    mark: (a) => {
      a.set(a.mx, a.top - 1, a.stops[1]);
      a.set(a.mx - 1, a.top - 1, a.stops[1]);
      a.set(a.mx, a.top - 2, a.stops[0]);
      if (a.d >= 10) for (const [u, v] of [[-0.4, 0.3], [0.3, 0.45], [0.5, -0.1]]) a.ink(u, v, a.stops[0]);
    },
  },
  { // persimmon — red-orange under a four-leaf green star.
    ramp: [0x93300a, 0xdd5b12, 0xfb8f2e], line: 0x461504,
    mark: (a) => {
      for (const dx of [-1, 0, 1]) a.set(a.mx + dx, a.top, 0x3d7a22);
      a.ink(0, -0.4, 0x4c9129);
      a.set(a.mx, a.top - 1, 0x5a4020);
      if (a.d >= 10) { a.set(a.mx - 2, a.top + 1, 0x3d7a22); a.set(a.mx + 2, a.top + 1, 0x3d7a22); }
    },
  },
  { // apple — clean mid red, identified by stem and leaf rather than by hue.
    ramp: [0x7d0f1f, 0xc42032, 0xe85a58], line: 0x3d0611,
    mark: (a) => {
      a.set(a.mx, a.top - 1, STEM);
      a.set(a.mx, a.top - 2, STEM);
      if (a.d >= 10) { a.set(a.mx + 1, a.top - 2, LEAF); a.set(a.mx + 2, a.top - 2, LEAF); }
      a.streak(-0.3, a.stops[2]);
    },
  },
  { // pear — yellow-green, and the only silhouette that is not a circle.
    ramp: [0x5e8214, 0x9dc226, 0xd4e764], line: 0x2c4109,
    shape: (u, v) => {
      const s = 0.62 + 0.38 * ((v + 1) / 2);
      return (u / s) * (u / s) + v * v <= 1;
    },
    mark: (a) => {
      a.set(a.mx, a.top - 1, STEM);
      if (a.d >= 10) for (const [u, v] of [[-0.3, 0.35], [0.24, 0.5], [0.1, 0.05]]) a.ink(u, v, a.stops[0]);
    },
  },
  { // peach — pink with a warm blush and a cleft.
    ramp: [0xb54254, 0xf07f92, 0xffbcb6], line: 0x5c1c2c,
    mark: (a) => {
      a.cleft(-0.16, a.stops[0]);
      a.blush(0xffd98a);
      a.set(a.mx, a.top - 1, LEAF);
    },
  },
  { // pineapple — gold with a green crown and a crosshatched rind.
    ramp: [0x9a6a0a, 0xd9a01c, 0xf3d155], line: 0x4c3208,
    mark: (a) => {
      a.set(a.mx, a.top - 3, 0x67b83a);
      for (const dx of [-1, 0, 1]) a.set(a.mx + dx, a.top - 2, dx ? 0x3f8f28 : 0x67b83a);
      for (const dx of [-2, -1, 0, 1, 2]) a.set(a.mx + dx, a.top - 1, Math.abs(dx) > 1 ? 0x2f7020 : 0x4f9c2c);
      a.hatch(a.stops[0]);
    },
  },
  { // melon — pale green with raised netting.
    ramp: [0x5f9450, 0x9ccb7d, 0xd8ecab], line: 0x2c5030,
    mark: (a) => {
      a.set(a.mx, a.top - 1, STEM);
      a.net(0xcfe8a8);
    },
  },
  { // watermelon — deep green, carved by stripes; the trophy of the ladder.
    ramp: [0x156630, 0x2f9a45, 0x66c464], line: 0x0b3419,
    mark: (a) => {
      a.stripes(0x0f4a25);
      a.set(a.mx, a.top - 1, STEM);
    },
  },
];

/** Draw one fruit icon `d` texels across into a padded buffer. */
export function iconBuf(tier, d) {
  const art = ICON_ART[tier];
  const size = d + PAD * 2;
  const buf = new PixBuf(size, size);
  const cx = PAD + (d - 1) / 2;
  const cy = cx;
  const R = d / 2;
  const stops = art.ramp.map(chan);
  const shape = art.shape || ((u, v) => u * u + v * v <= 1);
  const inside = (bx, by) => shape((bx - cx) / R, (by - cy) / R);

  for (let by = 0; by < size; by++) {
    for (let bx = 0; bx < size; bx++) {
      const u = (bx - cx) / R, v = (by - cy) / R;
      if (!shape(u, v)) continue;
      // Quantised three-stop lambert. No dithering: at this size a dither
      // pattern is indistinguishable from noise.
      const lam = -(u * 0.44 + v * 0.62);
      const rr = Math.hypot(u, v);
      const t = 0.5 + lam * 0.62 - Math.max(0, rr - 0.74) * 0.85;
      buf.set(bx, by, stops[t < 0.38 ? 0 : t < 0.68 ? 1 : 2]);
    }
  }

  const api = {
    d, stops, top: PAD, mx: Math.round(cx), cx, cy, R,
    set(bx, by, colour) {
      if (bx < 0 || by < 0 || bx >= size || by >= size) return;
      buf.set(bx, by, chan(colour));
    },
    /** Set at normalised disc coordinates, but only where the fruit is. */
    ink(u, v, colour) {
      const bx = Math.round(cx + u * R), by = Math.round(cy + v * R);
      if (inside(bx, by)) api.set(bx, by, colour);
    },
    seam(u, colour) {
      const bx = Math.round(cx + u * R);
      for (let by = 0; by < size; by++) if (inside(bx, by)) api.set(bx, by, colour);
    },
    /** Half-strength seam: a hard line at this size reads as damage. */
    cleft(u, colour) {
      const bx = Math.round(cx + u * R);
      const c = chan(colour);
      for (let by = 0; by <= Math.round(cy + R * 0.2); by++) {
        if (inside(bx, by)) buf.set(bx, by, mix(read(buf, bx, by), c, 0.55));
      }
    },
    streak(u, colour) {
      const bx = Math.round(cx + u * R);
      for (let by = Math.round(cy - R * 0.5); by <= Math.round(cy + R * 0.3); by++) {
        if (inside(bx, by)) api.set(bx, by, colour);
      }
    },
    /** Warm wash over the existing shading — a flat fill here reads as a
     *  hole punched in the fruit rather than as a blush. */
    blush(colour) {
      const warm = chan(colour);
      for (let by = 0; by < size; by++) {
        for (let bx = 0; bx < size; bx++) {
          const u = (bx - cx) / R, v = (by - cy) / R;
          if (!shape(u, v)) continue;
          const t = 0.55 - Math.hypot(u + 0.45, v - 0.4) * 0.5;
          if (t > 0.05) buf.set(bx, by, mix(read(buf, bx, by), warm, Math.min(0.6, t)));
        }
      }
    },
    hatch(colour) {
      for (let by = 0; by < size; by++) {
        for (let bx = 0; bx < size; bx++) {
          const u = (bx - cx) / R, v = (by - cy) / R;
          if (!shape(u, v) || Math.hypot(u, v) > 0.72) continue;
          if ((bx + by) % 3 === 0) api.set(bx, by, colour);
        }
      }
    },
    net(colour) {
      for (let by = 0; by < size; by++) {
        for (let bx = 0; bx < size; bx++) {
          const u = (bx - cx) / R, v = (by - cy) / R;
          if (!shape(u, v) || Math.hypot(u, v) > 0.78) continue;
          if (bx % 4 === 0 || (by + 1) % 4 === 0) api.set(bx, by, colour);
        }
      }
    },
    stripes(colour) {
      for (let by = 0; by < size; by++) {
        for (let bx = 0; bx < size; bx++) {
          const u = (bx - cx) / R, v = (by - cy) / R;
          if (!shape(u, v)) continue;
          // Spherical longitude, so the stripes compress toward the rim
          // exactly like the full-size melon's do.
          const lon = Math.asin(Math.max(-1, Math.min(1, u)));
          // Blended, not painted over: the stripes have to sit on the sphere's
          // shading or the fruit flattens into a beach ball.
          if (Math.abs(Math.sin(lon * 3.4)) > 0.74) {
            buf.set(bx, by, mix(read(buf, bx, by), chan(colour), 0.8));
          }
        }
      }
    },
  };

  art.mark(api);

  // One specular texel, once there are enough texels for it to read as gloss
  // rather than as a hole.
  if (d >= 8) {
    const hx = Math.round(cx - R * 0.34), hy = Math.round(cy - R * 0.42);
    if (inside(hx, hy)) buf.set(hx, hy, mix(chan(stops[2]), [255, 255, 255], 0.55));
  }

  buf.outline(chan(art.line));
  return buf;
}

/** Undiscovered slot: a struck token, not an empty hole. */
export function lockedBuf(d) {
  const size = d + PAD * 2;
  const buf = new PixBuf(size, size);
  const c = PAD + (d - 1) / 2;
  const R = d / 2;
  for (let by = 0; by < size; by++) {
    for (let bx = 0; bx < size; bx++) {
      const u = (bx - c) / R, v = (by - c) / R;
      if (u * u + v * v > 1) continue;
      // Lit from the same top-left key as everything else, so the blanks sit
      // in the same world as the fruit they will become.
      buf.set(bx, by, -(u * 0.44 + v * 0.62) > 0.42 ? [59, 68, 112] : [40, 47, 80]);
    }
  }
  buf.outline([21, 26, 45]);
  return buf;
}

const chan = (h) => (Array.isArray(h) ? h : [(h >> 16) & 255, (h >> 8) & 255, h & 255]);

/** Read a texel back out of a buffer, without assuming the art module keeps
 *  an accessor on PixBuf. */
function read(buf, x, y) {
  const i = (y * buf.w + x) * 4;
  return [buf.data[i], buf.data[i + 1], buf.data[i + 2]];
}
