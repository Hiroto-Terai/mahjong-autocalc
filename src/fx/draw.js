import { Texture, Rectangle, ImageSource } from 'pixi.js';
import { FRUIT_ART } from '../art/fruits.js';
import { ramp, toHex, mix, hex, BAYER4 } from '../art/palette.js';

/**
 * Rasterisation helpers shared by every effect.
 *
 * Everything here emits axis-aligned integer rectangles. Pixi's circle/arc
 * primitives tessellate to triangles and land on fractional coordinates, which
 * produces the soft, half-lit edge texels that instantly read as "modern
 * engine glow" instead of pixel art — so rings are scan-converted by
 * hand into whole-texel spans instead.
 */

/** Alpha is quantised to this many levels: a continuous fade across 60 frames
 *  is a gradient in time, which reads just as smooth as one in space. */
const ALPHA_STEPS = 5;

export function quantAlpha(a) {
  if (a <= 0) return 0;
  return Math.min(1, Math.ceil(Math.min(1, a) * ALPHA_STEPS) / ALPHA_STEPS);
}

/**
 * Pixel annulus between `ri` and `ro`. Two rects per scanline (the left and
 * right arcs), collapsing to one across the rows that clear the inner circle.
 */
export function ring(g, cx, cy, ro, ri, colour, alpha = 1) {
  const a = quantAlpha(alpha);
  if (a <= 0 || ro < 1) return;
  const RO = Math.round(ro);
  const RI = Math.max(0, Math.round(ri));
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  for (let y = -RO; y <= RO; y++) {
    const wo = Math.round(Math.sqrt(Math.max(0, RO * RO - y * y)));
    if (wo <= 0) continue;
    const inner = RI * RI - y * y;
    if (inner <= 0) {
      g.rect(x0 - wo, y0 + y, wo * 2 + 1, 1).fill({ color: colour, alpha: a });
      continue;
    }
    const wi = Math.round(Math.sqrt(inner));
    const span = wo - wi;
    if (span <= 0) continue;
    g.rect(x0 - wo, y0 + y, span, 1).fill({ color: colour, alpha: a });
    g.rect(x0 + wi + 1, y0 + y, span, 1).fill({ color: colour, alpha: a });
  }
}

/**
 * A shockwave drawn as separated blocks rather than a continuous line.
 *
 * A 1px circle is the most vector-looking mark a pixel game can make; the same
 * radius struck as a ring of 2x2 chunks with gaps between them reads as
 * deliberate, hand-placed art at any size.
 */
export function beadRing(g, cx, cy, r, colour, alpha = 1, chunk = 2) {
  const a = quantAlpha(alpha);
  if (a <= 0 || r < 3) return;
  const R = Math.round(r);
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  // Gap of roughly two and a half chunks: any tighter and the beads fuse back
  // into the 1px circle this exists to avoid.
  const n = Math.max(8, Math.round((R * Math.PI * 2) / (chunk * 3.4)));
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const px = x0 + Math.round(Math.cos(t) * R) - (chunk >> 1);
    const py = y0 + Math.round(Math.sin(t) * R) - (chunk >> 1);
    g.rect(px, py, chunk, chunk).fill({ color: colour, alpha: a });
  }
}

/**
 * One tapered radial spike, stamped as whole squares along the ray.
 *
 * The taper is the whole point: a constant-width bar reads as a laser, while a
 * wedge that narrows to a single texel reads as a shard of light — and a star
 * of those is the burst shape hand-drawn pixel games actually use, instead of
 * yet another concentric circle.
 */
export function spike(g, cx, cy, angle, from, to, w0, w1, colour, alpha = 1) {
  const a = quantAlpha(alpha);
  if (a <= 0 || to <= from) return;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const span = to - from;
  let prev = -1;
  let d = from;
  while (d <= to) {
    const w = Math.max(1, Math.round(w0 + (w1 - w0) * ((d - from) / span)));
    const px = Math.round(cx + dx * d) - (w >> 1);
    const py = Math.round(cy + dy * d) - (w >> 1);
    const key = px * 4096 + py;
    if (key !== prev) {
      prev = key;
      g.rect(px, py, w, w).fill({ color: colour, alpha: a });
    }
    // Consecutive stamps only need to overlap, not abut: a wide wedge costs a
    // fraction of the rectangles a 1px march would, and a 200px watermelon ray
    // marched at 1px is thousands of them per frame.
    d += Math.max(1, w >> 1);
  }
}

/**
 * An eight-step ordered-dither ramp, as 4x4 tileable masks.
 *
 * Full-screen veils are the one place a fade genuinely wants to be continuous,
 * and the one place a continuous fade is most obviously wrong. Tiling a Bayer
 * mask and stepping its coverage gives the same range of "darkness" using only
 * fully-opaque texels, which is how a real palette-limited game did it.
 */
export const DITHER_LEVELS = 8;

let DITHER = null;

export function ditherTextures() {
  if (DITHER) return DITHER;
  DITHER = [];
  for (let level = 1; level <= DITHER_LEVELS; level++) {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const img = canvas.getContext('2d').createImageData(4, 4);
    const cut = level / DITHER_LEVELS;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        if (BAYER4[y][x] >= cut) continue;
        const i = (y * 4 + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; img.data[i + 3] = 255;
      }
    }
    canvas.getContext('2d').putImageData(img, 0, 0);
    const source = new ImageSource({
      resource: canvas,
      scaleMode: 'nearest',
      alphaMode: 'premultiply-alpha-on-upload',
      addressMode: 'repeat',
    });
    DITHER.push(new Texture({ source, frame: new Rectangle(0, 0, 4, 4) }));
  }
  return DITHER;
}

/* ------------------------------------------------------------------ *
 * Fruit-derived palettes.
 *
 * Debris tinted white is the single laziest particle choice available; taking
 * the colours straight from the fruit's own baked ramp means every burst is
 * recognisably *that fruit* exploding.
 * ------------------------------------------------------------------ */
/**
 * The skin ramp, plus whatever marking ramps the fruit carries.
 *
 * `art.shadow`/`light`/`hueShift` are the documented contract, but the full
 * authored ramp gives four usable debris colours instead of two endpoints, and
 * a second ramp (a watermelon stripe, a peach blush) is exactly the accent
 * chunk that stops a burst from being one flat hue.
 */
function rampsOf(art) {
  const raw = art.ramps || (Array.isArray(art.stops?.[0]?.[0]) ? art.stops : null);
  if (raw) {
    return raw.map((r) => r.map((c) => (Array.isArray(c) ? c : hex(c))));
  }
  return [ramp(art.shadow, art.light, 5, art.hueShift)];
}

const PALETTES = FRUIT_ART.map((art) => {
  const ramps = rampsOf(art);
  const skin = ramps[0];
  const light = skin[skin.length - 1];
  const shadow = skin[0];
  // Skip both endpoints of the marking ramps: their shadow vanishes into the
  // jar and their highlight is indistinguishable from the skin's.
  const marks = ramps.slice(1).flatMap((r) => r.slice(2, 4));
  return {
    /** darkest -> lightest, as 0xRRGGBB */
    stops: skin.map(toHex),
    marks: marks.map(toHex),
    shadow: toHex(shadow),
    light: toHex(light),
    /** Halfway to white: the flash colour, still hue-anchored to the fruit. */
    hot: toHex(mix(light, [255, 255, 255], 0.55)),
  };
});

export const paletteFor = (tier) => PALETTES[Math.max(0, Math.min(PALETTES.length - 1, tier))];
