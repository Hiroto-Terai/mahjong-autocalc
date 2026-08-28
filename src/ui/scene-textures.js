import { Texture, ImageSource, Rectangle } from 'pixi.js';
import { VIRTUAL_W, VIRTUAL_H, BOARD, BOARD_W } from '../config.js';
import { PixBuf } from '../art/canvas.js';
import { hex, mix } from '../art/palette.js';

/**
 * Baked pixel art for the playfield: the room behind the jar, the jar's
 * interior, and the glass that sits in front of the fruit.
 *
 * All of it is plotted into a PixBuf at 1:1 texel scale and uploaded with
 * nearest filtering. Graphics primitives were the obvious alternative and the
 * wrong one — the GPU resolves every ellipse edge its own way, and a jar
 * assembled from stacked rects cannot carry a curved lip at all.
 *
 * Three rules run through the whole file:
 *   - Large surfaces (wall, tabletop, jar interior) are flat ramp stops with
 *     ordered dithering confined to a narrow band at each stop boundary, and
 *     every plateau in the shading function lands on a whole stop. A plateau
 *     that lands halfway between two stops dithers 50/50 across its entire
 *     area, which is how the interior became a checkerboard.
 *   - Small chrome (rim, glass walls, base) is never dithered. A 3-texel-tall
 *     lip has room for three decisions, not a probability distribution.
 *   - The jar is one silhouette. Rim, wall and base share an outer edge and a
 *     single rasterised curve, so nothing overhangs anything else.
 */

/**
 * 8x8 Bayer. The 4x4 in palette.js is tuned for 8px fruit; a wall band 90
 * texels tall needs the finer matrix or the transition reads as plaid.
 */
const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
].map((row) => row.map((v) => (v + 0.5) / 64));

const b8 = (x, y) => BAYER8[y & 7][x & 7];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Quantise a continuous ramp position onto flat stops.
 *
 * The fractional part is contrast-stretched before it meets the Bayer
 * threshold, so only `band` of each stop's extent carries mixed texels and the
 * rest is genuinely flat. Callers must keep their flat regions on whole values
 * of `s`: the stretch is centred on the half-stop, so a surface that sits at
 * exactly n + 0.5 dithers everywhere no matter how narrow the band is.
 */
function pick(stops, s, x, y, band = 0.14) {
  const lo = Math.floor(s);
  const f = clamp((s - lo - 0.5) / band + 0.5, 0, 1);
  return stops[clamp(lo + (f > b8(x, y) ? 1 : 0), 0, stops.length - 1)];
}

/** Ordered-dithered alpha, for haze and contact shadows. */
function qAlpha(x, y, a, steps = 5) {
  const s = clamp(a, 0, 1) * steps;
  const lo = Math.floor(s);
  return clamp(lo + (s - lo > b8(x, y) ? 1 : 0), 0, steps) / steps;
}

/* ------------------------------------------------------------------ *
 * Jar geometry.
 *
 * The playfield is 264 texels wide starting at BOARD.left, so its columns
 * are 28..291 and its true centre is 159.5. Everything here is built on
 * that half-texel centre: rounding it to 160 is what previously left the
 * left glass covering a column of fruit that the right glass did not.
 * ------------------------------------------------------------------ */
const CX = (BOARD.left + BOARD.right - 1) / 2;
/** Columns of the mouth — exactly the columns the physics board occupies. */
const MOUTH_X0 = BOARD.left;
const MOUTH_X1 = BOARD.right - 1;
/** Glass thickness, and therefore the jar's outer silhouette. */
const WALL_W = 8;
const RX = BOARD_W / 2 + WALL_W - 0.5;
const RY = 12;
const RIM_Y = 76;
/** Depth of the rim's top face, constant all the way round. */
const RIM_T = 4;
/** Rows of front glass visible below the lip before it turns transparent. */
const LIP_H = 6;
const BASE_H = 10;
const FOOT_H = 4;
/** Where the back wall meets the tabletop. */
const TABLE_Y = 402;

const WALL_X0 = Math.round(CX - RX);
const WALL_X1 = Math.round(CX + RX);

/**
 * Row offset of the jar's outer silhouette at column x, or null off the ends.
 * One curve, rasterised once: the rim's inner edge is this curve offset by
 * RIM_T rather than a second ellipse, so the top face is exactly RIM_T texels
 * everywhere instead of wobbling between two and four.
 */
function rimArc(x) {
  const u = (x - CX) / RX;
  if (u < -1 || u > 1) return null;
  return RY * Math.sqrt(1 - u * u);
}

/** Rows of the lip at column x: outer edges, inner edges, and whether it is open. */
function rimRows(x) {
  const a = rimArc(x);
  if (a === null) return null;
  const oT = Math.round(RIM_Y - a);
  const oB = Math.round(RIM_Y + a);
  const open = x >= MOUTH_X0 && x <= MOUTH_X1;
  return { oT, oB, iT: oT + RIM_T, iB: oB - RIM_T, open };
}

/* ---- palettes ---------------------------------------------------- */

const WALL = [0x090d1a, 0x0f1528, 0x161e3c, 0x1d2750, 0x242f63].map(hex);
/**
 * Cool, so the tabletop stays in the indigo family instead of going plum. The
 * two darkest stops exist for the jar's cast shadow, which is shaded on this
 * ramp rather than blended over it.
 */
const WOOD = [0x0b0916, 0x100e1e, 0x161528, 0x201d35, 0x2a2644, 0x353053, 0x413b63].map(hex);
const INNER = [0x070a16, 0x0a0e20, 0x0d1329, 0x111834, 0x151d40, 0x1a234d].map(hex);
/** One ramp for every piece of glass, so the jar reads as one material. */
const GLASS = [0x0a0e1c, 0x151c39, 0x232c52, 0x374472, 0x54649c, 0x8391cb].map(hex);
/** Board joints in the tabletop. */
const PLANKS = [419, 447, 472];

/**
 * Side glass as GLASS indices, outer edge inward. One profile, mirrored, so
 * the two walls are the same width with their highlight at the same inset —
 * the key light is carried by DIM_R alone, not by a different profile.
 */
const WALL_PROFILE = [0, 3, 4, 5, 4, 2, 1, 1];
/** The right wall turns away from the light: same shape, one stop down. */
const DIM_R = [0, 2, 3, 4, 3, 2, 1, 1];

/** Near rim top face, inner edge outward: into the mouth, then the lit edge. */
const RIM_ROWS = [1, 4, 5, 5];
/** Far rim top face, outer edge inward: silhouette, lit face, then the mouth. */
const RIM_BACK = [1, 4, 4, 3];
/** Lip skirt, top row down — the front glass curving away under the rim. */
const SKIRT_ROWS = [5, 4, 3, 2, 1, 0];
/** Glass floor, top row down: dark against the fruit, thickness, dark edge. */
const BASE_ROWS = [1, 3, 4, 5, 4, 3, 2, 1, 1, 0];
const FOOT_ROWS = [4, 3, 1, 0];

/* ------------------------------------------------------------------ *
 * Background: wall, recessed alcove, light pool, vignette, tabletop.
 * ------------------------------------------------------------------ */
export function buildBackground() {
  const buf = new PixBuf(VIRTUAL_W, VIRTUAL_H);
  const T = TABLE_Y;
  // The alcove the jar stands in. Its edges are the only hard lines on the
  // wall, and they are what stop the top of the frame reading as void.
  const NX0 = 9, NX1 = 310, NY = 46;

  for (let y = 0; y < T; y++) {
    for (let x = 0; x < VIRTUAL_W; x++) {
      // Base ramp: darkest at the ceiling so the white HUD keeps its contrast.
      let s = (y / (T - 1)) * 2.5 + 0.4;
      // Light pool, thrown from the upper left so the whole scene agrees with
      // the highlight running down the left-hand glass.
      s += Math.max(0, 1 - Math.hypot((x - 120) / 250, (y - 240) / 270)) * 2.0;
      // ...and the shadow the jar throws back onto the wall, down and to the
      // right of it. Only the right margin survives the jar occluding it, but
      // that asymmetry is what tells the eye there is a light source at all.
      s -= Math.max(0, 1 - Math.hypot((x - 200) / 152, (y - 300) / 215)) * 1.2;

      if (x >= NX0 && x <= NX1 && y >= NY) {
        s += 0.9;
        // Recess lit from the upper left: near edges shadowed, far edges lit.
        if (y <= NY + 2) s -= 2.0;
        else if (x <= NX0 + 1) s -= 1.4;
        else if (x >= NX1 - 1) s += 1.2;
      } else if (y >= NY - 2) {
        s += 0.7;
      }
      // Skirting board.
      if (y >= T - 9 && y < T - 2) s += y === T - 9 ? 1.9 : 1.1;

      // Vignette.
      const v = Math.hypot((x - CX) / 170, (y - 250) / 265);
      s -= Math.max(0, v - 0.72) * 3.2;
      // Contact darkening where the wall meets the table.
      s -= Math.max(0, 1 - (T - y) / 22) * 1.5;
      buf.set(x, y, pick(WALL, s, x, y, 0.2), 255);
    }
  }

  // Skirting: a hard shadow reveal, so the wall does not bleed into the wood.
  for (let x = 0; x < VIRTUAL_W; x++) {
    buf.set(x, T - 2, hex(0x070a14), 255);
    buf.set(x, T - 1, hex(0x04060c), 255);
  }

  // The shadow the jar casts on the table is part of the tabletop's shading,
  // not a wash laid over it, so it stays on the wood ramp: a cast shadow that
  // blends off-palette is the fastest way to make a pixel surface look
  // photographic. It has to be strong — the jar's own base hides the contact
  // point, and this pool is the only thing saying the vessel stands on
  // anything — but it hugs the foot rather than blanketing the surface, or it
  // swallows the plank seams that carry the floor from one margin to the other.
  const footBot = BOARD.floor + BASE_H + FOOT_H;
  for (let y = T; y < VIRTUAL_H; y++) {
    for (let x = 0; x < VIRTUAL_W; x++) {
      const t = (y - T) / (VIRTUAL_H - 1 - T);
      // The far edge catches the wall light; the near edge rolls into shadow.
      let s = 5.6 - t * 2.2;
      // Plank seams and nothing else. Every attempt at grain here — periodic
      // or hashed — turned the visible margin into brickwork; the joints alone
      // say "tabletop" and stay quiet.
      if (PLANKS.includes(y)) s -= 1.8;
      else if (PLANKS.includes(y - 1)) s += 0.8;
      s -= Math.max(0, Math.abs(x - CX) / 160 - 0.5) * 1.8;
      // Centred a few rows above the contact so the pool still reads in the
      // side margins: the rows directly in front of the foot are the ones the
      // HUD's bottom bar covers.
      const d = Math.hypot((x - CX) / 196, (y - (footBot - 6)) / 22);
      if (d < 1) s -= Math.min(3.4, (1 - d) * 6.5);
      buf.set(x, y, pick(WOOD, s, x, y, 0.2), 255);
    }
  }
  // The lit lip of the tabletop where it meets the wall.
  for (let x = 0; x < VIRTUAL_W; x++) buf.set(x, T, mix(WOOD[6], hex(0x6d6690), 0.5), 255);
  return buf;
}

/* ------------------------------------------------------------------ *
 * Jar interior + the far half of the rim, seen through the mouth.
 * ------------------------------------------------------------------ */
export function buildJarBack() {
  const buf = new PixBuf(VIRTUAL_W, VIRTUAL_H);
  const F = BOARD.floor;
  const halfW = (MOUTH_X1 - MOUTH_X0) / 2;

  for (let x = MOUTH_X0; x <= MOUTH_X1; x++) {
    const rim = rimRows(x);
    const top = rim.iT;
    // Cylinder, not a box: the interior turns away from the viewer toward the
    // glass on both sides. Every term below peaks at a whole stop so the flat
    // middle of the jar is genuinely flat.
    const u = (x - CX) / halfW;
    const curve = 3 * Math.sqrt(Math.max(0, 1 - u * u));
    for (let y = top; y < F; y++) {
      let s = curve;
      s += Math.max(0, 1 - (y - top) / 30) * 2;
      s += Math.max(0, 1 - (F - 1 - y) / 70) * 2;
      s -= Math.max(0, 1 - (F - 1 - y) / 10) * 3;
      buf.set(x, y, pick(INNER, s, x, y, 0.16), 255);
    }
  }

  // Far half of the rim: seen almost edge-on and lit from the front, so it
  // sits below the near half rather than mirroring it.
  for (let x = MOUTH_X0; x <= MOUTH_X1; x++) {
    const { oT, iT } = rimRows(x);
    for (let y = oT; y < iT; y++) buf.set(x, y, GLASS[RIM_BACK[y - oT]], 255);
  }
  return buf;
}

/* ------------------------------------------------------------------ *
 * Everything in front of the fruit: side glass, base, near half of the
 * rim, the lip, and the shine.
 * ------------------------------------------------------------------ */
export function buildJarFront() {
  const buf = new PixBuf(VIRTUAL_W, VIRTUAL_H);
  const F = BOARD.floor;
  const baseBot = F + BASE_H;

  // --- side glass -------------------------------------------------
  // Each column starts one row under the lip's outer edge at that column, so
  // the wall and the rim cap are a single unbroken piece of glass.
  for (let i = 0; i < WALL_W; i++) {
    // Columns 2..4 carry the highlight on both sides, so the breaks in it are
    // the same width left and right.
    const lit = i >= 2 && i <= 4;
    for (const [x, idx] of [[WALL_X0 + i, WALL_PROFILE[i]], [WALL_X1 - i, DIM_R[i]]]) {
      const { oB } = rimRows(x);
      for (let y = oB + 1; y < baseBot; y++) {
        buf.set(x, y, GLASS[clamp(idx + (lit ? glint(y, oB, baseBot) : 0), 0, 5)], 255);
      }
    }
  }

  // --- base -------------------------------------------------------
  for (let k = 0; k < BASE_H; k++) {
    for (let x = MOUTH_X0; x <= MOUTH_X1; x++) buf.set(x, F + k, GLASS[BASE_ROWS[k]], 255);
  }
  // Foot: flares two texels wider than the walls so the jar sits, not floats.
  for (let k = 0; k < FOOT_H; k++) {
    const flare = k >= 2 ? 2 : 1;
    for (let x = WALL_X0 - flare; x <= WALL_X1 + flare; x++) {
      buf.set(x, baseBot + k, GLASS[FOOT_ROWS[k]], 255);
    }
  }

  // --- near half of the rim, and the lip below it ------------------
  for (let x = WALL_X0; x <= WALL_X1; x++) {
    const { oT, oB, iB, open } = rimRows(x);
    if (open) {
      // Across the mouth the lip is a RIM_T-deep annulus: it drops into the
      // opening, then climbs to the edge the light catches.
      for (let y = iB + 1; y <= oB; y++) buf.set(x, y, GLASS[RIM_ROWS[y - iB - 1]], 255);
      for (let k = 0; k < LIP_H; k++) buf.set(x, oB + 1 + k, GLASS[SKIRT_ROWS[k]], 255);
    } else {
      // Over the side glass the lip is solid glass end-on, and its bottom row
      // hands straight over to the wall column beneath it.
      for (let y = oT; y <= oB; y++) {
        const d = oB - y;
        buf.set(x, y, GLASS[y === oT && oB > oT ? 1 : d === 0 ? 5 : d === 1 ? 4 : 3], 255);
      }
    }
  }

  // --- glass tint over the fruit -----------------------------------
  // A hard inner shadow would eat the fruit outline, so this is a three-texel
  // falloff: enough to say "behind glass", not enough to lose a cherry that
  // has settled against the wall.
  const tint = hex(0x04060e);
  const tintCols = [0.24, 0.12, 0.05];
  for (let i = 0; i < tintCols.length; i++) {
    for (const x of [MOUTH_X0 + i, MOUTH_X1 - i]) {
      const top = rimRows(x).oB + LIP_H + 1;
      for (let y = top; y < F; y++) setTint(buf, x, y, tint, tintCols[i]);
    }
  }
  for (let x = MOUTH_X0 + 3; x <= MOUTH_X1 - 3; x++) {
    for (let i = 0; i < tintCols.length; i++) setTint(buf, x, F - 1 - i, tint, tintCols[i]);
  }

  // --- shine -------------------------------------------------------
  // Flat alpha with hard edges. A dithered shine over a dithered interior
  // reads as dead pixels, not glass. Both highlights hug the inside of the
  // left glass; floated into the middle of the jar they read as scratches.
  const shine = hex(0xd8e5ff);
  streak(buf, shine, 31, 4, 104, 268, 0.14);
  streak(buf, shine, 38, 2, 116, 214, 0.09);
  // A short cold reflection low on the right, so the glass reads as a cylinder
  // lit from one side rather than a decal stuck on the left.
  streak(buf, shine, 285, 3, 318, 430, 0.07);
  return buf;
}

/** Vertical specular breaks in the side glass — flat glass has no breaks. */
function glint(y, top, bot) {
  const t = (y - top) / (bot - top);
  if (t < 0.30) return 1;
  if (t < 0.32) return -2;
  if (t < 0.62) return 0;
  if (t < 0.635) return -2;
  if (t < 0.92) return -1;
  return 1;
}

function setTint(buf, x, y, colour, a) {
  const q = qAlpha(x, y, a);
  if (q > 0) buf.set(x, y, colour, Math.round(q * 255));
}

/**
 * Shine bar with a capsule profile: flat alpha, hard edges, ends stepped in a
 * texel at a time.
 */
function streak(buf, colour, x0, w, y0, y1, alpha) {
  const a = Math.round(alpha * 255);
  const steps = Math.max(1, w >> 1);
  for (let y = y0; y <= y1; y++) {
    const inset = Math.max(0, steps - Math.min(y - y0, y1 - y));
    if (w - inset * 2 <= 0) continue;
    for (let x = x0 + inset; x < x0 + w - inset; x++) buf.set(x, y, colour, a);
  }
}

/* ------------------------------------------------------------------ *
 * Danger line parts. Baked white so a Sprite tint can drive the whole
 * escalation from one colour ramp.
 * ------------------------------------------------------------------ */

/** Haze above the line: dithered alpha ramp, strongest at the line. */
export function buildDangerGlow() {
  const h = 16;
  const buf = new PixBuf(BOARD_W, h);
  for (let y = 0; y < h; y++) {
    const a = Math.pow(y / (h - 1), 2.1) * 0.85;
    for (let x = 0; x < BOARD_W; x++) {
      // Fade toward the glass so the haze does not butt into the walls.
      const edge = clamp(Math.min(x, BOARD_W - 1 - x) / 18, 0, 1);
      const q = qAlpha(x, y, a * (0.35 + edge * 0.65));
      if (q > 0) buf.set(x, y, [255, 255, 255], Math.round(q * 255));
    }
  }
  return buf;
}

/** A solid arrow aimed at the line. It has to read at 1x, so it is solid. */
export function buildDangerArrow() {
  const rows = ['XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
  const buf = new PixBuf(7, rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === 'X') buf.set(x, y, [255, 255, 255], 255);
  });
  return buf;
}

export function toTexture(buf) {
  const source = new ImageSource({
    resource: buf.toCanvas(),
    scaleMode: 'nearest',
    alphaMode: 'premultiply-alpha-on-upload',
  });
  return new Texture({ source, frame: new Rectangle(0, 0, buf.w, buf.h) });
}
