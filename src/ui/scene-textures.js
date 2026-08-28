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
 * Two rules run through the whole file:
 *   - Large surfaces (wall, tabletop, jar interior) are flat ramp stops with
 *     ordered dithering confined to a narrow band at each stop boundary.
 *   - Small chrome (rim, glass walls, base) is never dithered. A 4-texel-tall
 *     lip has room for four decisions, not a probability distribution.
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
 * threshold, so only `band` of each stop's extent contains mixed texels and
 * the rest is genuinely flat. Feeding the raw fraction straight to the
 * threshold — the obvious implementation — dithers the entire surface, which
 * is the "downsampled 3D render" failure the art bible names.
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

/** Half-height of an ellipse at column x, or null outside its span. */
function arc(x, cx, rx, ry) {
  const u = (x - cx) / rx;
  if (u < -1 || u > 1) return null;
  return ry * Math.sqrt(1 - u * u);
}

/* ------------------------------------------------------------------ *
 * Jar geometry. rxIn is pinned so the inner faces of the glass land
 * exactly on BOARD.left/right — the fruit must touch the glass, not
 * hover a texel away from it.
 * ------------------------------------------------------------------ */
const JAR = {
  cx: 160,
  /** Centre of the mouth ellipse. */
  rimY: 76,
  rxOut: 141, ryOut: 11,
  rxIn: BOARD_W / 2, ryIn: 7,
  /** How far the outside of the lip is extruded below the mouth. */
  lipH: 7,
  /** Outer edge of the side glass; the inner face is BOARD.left/right. */
  wallOut: 21,
  baseH: 10,
  footH: 4,
  /** Where the back wall meets the tabletop. */
  tableY: 402,
};

/* ---- palettes ---------------------------------------------------- */

const WALL = [0x090d1a, 0x0f1528, 0x161e3c, 0x1d2750, 0x242f63].map(hex);
const WOOD = [0x1c1422, 0x2a1e2e, 0x3a293a, 0x4a3446, 0x5b4053].map(hex);
const INNER = [0x080b18, 0x0c1024, 0x101632, 0x151d40, 0x1b254e].map(hex);
/** One ramp for every piece of glass, so the jar reads as one material. */
const GLASS = [0x0a0e1c, 0x151c39, 0x232c52, 0x374472, 0x54649c, 0x8391cb].map(hex);
const SHADOW = hex(0x06060f);
/** Board joints in the tabletop. */
const PLANKS = [419, 447, 472];

/** Side glass as GLASS indices. Left: outer edge inward, ending on BOARD.left. */
const WALL_L = [0, 3, 4, 5, 4, 2, 1, 1];
/** Right: inner face outward. Dimmer throughout — the key light is upper-left. */
const WALL_R = [1, 1, 2, 3, 4, 4, 2, 0];
const SPEC_L = 3;
const SPEC_R = 5;

/** The lip's outer skirt, top row down. Wide enough to read as thickness. */
const SKIRT_ROWS = [4, 4, 3, 2, 2, 1, 0];
/** Glass floor, top row down: dark against the fruit, then thickness, then edge. */
const BASE_ROWS = [1, 3, 4, 4, 3, 2, 2, 1, 1, 0];
const FOOT_ROWS = [3, 2, 1, 0];
/**
 * Horizontal falloff of the lip's specular run, stepped rather than faded. A
 * highlight that dims smoothly across 250 texels is a gradient, and one that
 * stops dead mid-rim reads as a bug; two hard steps read as a decision.
 */
function glintX(x) {
  const d = Math.abs(x - 116);
  return d < 58 ? 2 : d < 88 ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Background: wall, recessed alcove, light pool, vignette, tabletop.
 * ------------------------------------------------------------------ */
export function buildBackground() {
  const buf = new PixBuf(VIRTUAL_W, VIRTUAL_H);
  const T = JAR.tableY;
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
      const v = Math.hypot((x - JAR.cx) / 170, (y - 250) / 265);
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

  for (let y = T; y < VIRTUAL_H; y++) {
    for (let x = 0; x < VIRTUAL_W; x++) {
      const t = (y - T) / (VIRTUAL_H - 1 - T);
      // The far edge catches the wall light; the near edge rolls into shadow.
      let s = 3.6 - t * 3.0;
      // Plank seams and nothing else. Every attempt at grain here — periodic
      // or hashed — turned 19 texels of visible margin into brickwork; the
      // joints alone say "tabletop" and stay quiet.
      if (PLANKS.includes(y)) s -= 2.6;
      else if (PLANKS.includes(y - 1)) s += 1.2;
      s -= Math.max(0, Math.abs(x - JAR.cx) / 160 - 0.5) * 1.8;
      buf.set(x, y, pick(WOOD, s, x, y, 0.2), 255);
    }
  }
  // The lit lip of the tabletop where it meets the wall.
  for (let x = 0; x < VIRTUAL_W; x++) buf.set(x, T, mix(WOOD[4], hex(0x7a5b6b), 0.5), 255);

  // Contact shadow the jar casts on the table. The jar occludes most of it,
  // but the margins are exactly where the base needs to feel planted.
  for (let y = T; y < VIRTUAL_H; y++) {
    for (let x = 0; x < VIRTUAL_W; x++) {
      const d = Math.hypot((x - JAR.cx) / 178, (y - 466) / 17);
      if (d >= 1) continue;
      const a = qAlpha(x, y, Math.min(0.85, (1 - d) * 1.6));
      if (a <= 0) continue;
      const c = buf.get(x, y);
      buf.set(x, y, mix([c[0], c[1], c[2]], SHADOW, a), 255);
    }
  }
  return buf;
}

/* ------------------------------------------------------------------ *
 * Jar interior + the far half of the mouth, seen through the opening.
 * ------------------------------------------------------------------ */
export function buildJarBack() {
  const buf = new PixBuf(VIRTUAL_W, VIRTUAL_H);
  const L = BOARD.left, R = BOARD.right, F = BOARD.floor;

  for (let x = L; x < R; x++) {
    // The opening is an ellipse, so the interior starts higher at the centre
    // than at the sides. A flat top edge is what made the placeholder read as
    // a rectangle rather than a mouth.
    const top = Math.round(JAR.rimY - (arc(x, JAR.cx, JAR.rxIn, JAR.ryIn) ?? 0));
    const dEdge = Math.min(x - L, R - 1 - x);
    for (let y = top; y < F; y++) {
      // Deliberately dark through the middle: light spills a short way in
      // under the mouth, the glass floor throws a little back up, and between
      // those two the jar is a shadowed volume — which is the only reason an
      // 8px cherry reads against it. Both terms are functions of y alone; any
      // x term here lays a visible diagonal stop boundary across the playfield.
      let s = 0.5;
      s += Math.max(0, 1 - (y - top) / 34) * 2.4;
      s += Math.max(0, 1 - (F - 1 - y) / 78) * 2.0;
      s -= Math.max(0, 1 - dEdge / 26) * 1.4;
      s -= Math.max(0, 1 - (F - 1 - y) / 11) * 1.9;
      buf.set(x, y, pick(INNER, s, x, y, 0.2), 255);
    }
  }

  // Far half of the mouth: the annulus above the rim centreline. Seen almost
  // edge-on and lit from the front, so it sits a stop below the near half.
  eachRimColumn(({ x, oT, iT, split }) => {
    if (!split) return;
    const g = glintX(x);
    for (let y = oT; y < iT; y++) {
      // Outer row is the silhouette against the wall, inner row drops into the
      // mouth, and the band between is the far lip catching a little light.
      const i = y === oT || y === iT - 1 ? 1 : 2 + (g > 1 ? 1 : 0);
      buf.set(x, y, GLASS[i], 255);
    }
  });
  return buf;
}

/**
 * Walk every column of the mouth, handing back the rows of the outer and
 * inner ellipses. `split` is false out at the ends, where the mouth is past
 * the inner ellipse and the lip is solid glass all the way through.
 */
function eachRimColumn(fn) {
  for (let x = JAR.cx - JAR.rxOut; x <= JAR.cx + JAR.rxOut; x++) {
    const aOut = arc(x, JAR.cx, JAR.rxOut, JAR.ryOut);
    if (aOut === null) continue;
    const aIn = arc(x, JAR.cx, JAR.rxIn, JAR.ryIn);
    const oT = Math.round(JAR.rimY - aOut);
    const oB = Math.round(JAR.rimY + aOut);
    if (aIn === null) fn({ x, oT, oB, iT: oT, iB: oB, split: false });
    else fn({ x, oT, oB, iT: Math.round(JAR.rimY - aIn), iB: Math.round(JAR.rimY + aIn), split: true });
  }
}

/* ------------------------------------------------------------------ *
 * Everything in front of the fruit: near half of the mouth, the lip
 * skirt, the side glass, the base, and the shine.
 * ------------------------------------------------------------------ */
export function buildJarFront() {
  const buf = new PixBuf(VIRTUAL_W, VIRTUAL_H);
  const L = BOARD.left, R = BOARD.right, F = BOARD.floor;
  const baseBot = F + JAR.baseH;

  /** First row below the lip skirt for a given column. */
  const underLip = (x) =>
    Math.round(JAR.rimY + (arc(x, JAR.cx, JAR.rxOut, JAR.ryOut) ?? 0)) + JAR.lipH + 1;

  // --- side glass -------------------------------------------------
  for (let i = 0; i < WALL_L.length; i++) {
    for (const [x, idx, spec] of [[JAR.wallOut + i, WALL_L[i], i === SPEC_L],
                                  [R + i, WALL_R[i], i === SPEC_R]]) {
      const top = underLip(x);
      for (let y = top; y < baseBot; y++) {
        buf.set(x, y, GLASS[clamp(idx + (spec ? glint(y, top, baseBot) : 0), 0, 5)], 255);
      }
    }
  }

  // --- base -------------------------------------------------------
  for (let k = 0; k < JAR.baseH; k++) {
    // The bright rows fall off toward the ends, so the whole jar agrees with
    // the lip about where the light is coming from.
    const shaped = BASE_ROWS[k] >= 4;
    for (let x = L; x < R; x++) {
      const i = shaped && Math.abs(x - 124) > 96 ? BASE_ROWS[k] - 1 : BASE_ROWS[k];
      buf.set(x, F + k, GLASS[i], 255);
    }
  }
  // Foot: flares two texels wider than the walls so the jar sits, not floats.
  for (let k = 0; k < JAR.footH; k++) {
    const flare = k >= 2 ? 2 : 1;
    for (let x = JAR.wallOut - flare; x <= R + WALL_L.length - 1 + flare; x++) {
      buf.set(x, baseBot + k, GLASS[FOOT_ROWS[k]], 255);
    }
  }

  // --- near half of the mouth + the lip skirt ----------------------
  eachRimColumn(({ x, oT, oB, iB, split }) => {
    const g = glintX(x);
    const top = split ? iB : oT;
    for (let y = top; y <= oB; y++) {
      // Inner corner drops into the mouth, the row behind it is the ridge the
      // light catches, the outer row is the silhouette. That sequence is what
      // makes a lip read as thick glass instead of a painted band.
      let i;
      if (y === top) i = 1;
      else if (y === oB) i = clamp(4 + (g > 0 ? 1 : 0), 0, 5);
      else i = 3 + (g > 1 ? 1 : 0);
      buf.set(x, y, GLASS[i], 255);
    }
    for (let k = 0; k < JAR.lipH; k++) {
      const i = k < 2 ? clamp(SKIRT_ROWS[k] - 2 + g, 0, 5) : SKIRT_ROWS[k];
      buf.set(x, oB + 1 + k, GLASS[i], 255);
    }
  });

  // --- glass tint over the fruit -----------------------------------
  // A hard inner shadow would eat the fruit outline, so this is a three-texel
  // falloff: enough to say "behind glass", not enough to lose a cherry that
  // has settled against the wall.
  const tint = hex(0x0a0f22);
  const tintCols = [0.24, 0.12, 0.05];
  for (let i = 0; i < tintCols.length; i++) {
    for (let y = underLip(L + i); y < F; y++) setTint(buf, L + i, y, tint, tintCols[i]);
    for (let y = underLip(R - 1 - i); y < F; y++) setTint(buf, R - 1 - i, y, tint, tintCols[i]);
  }
  for (let x = L + 3; x < R - 3; x++) {
    for (let i = 0; i < tintCols.length; i++) setTint(buf, x, F - 1 - i, tint, tintCols[i]);
  }

  // --- shine -------------------------------------------------------
  // Flat alpha with hard edges. A dithered shine over a dithered background
  // reads as dead pixels, not glass.
  const shine = hex(0xd8e5ff);
  // Both highlights hug the inside of the left glass. Floated out into the
  // middle of the jar they read as scratches rather than as a reflection in
  // the wall the light is actually hitting.
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
 * texel at a time. A dithered highlight sitting over a dithered interior reads
 * as dead pixels, not as glass.
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
