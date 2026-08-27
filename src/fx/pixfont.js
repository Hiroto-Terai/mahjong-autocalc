import { Texture, Rectangle, ImageSource, Sprite, Container } from 'pixi.js';

/**
 * A 3x5 bitmap font, baked once at boot.
 *
 * The HUD can afford a system font; floating combat text cannot — it sits
 * directly on top of the fruit at 1:1 texel scale, where anti-aliased glyph
 * edges are the most obvious "this is not pixel art" tell in the whole frame.
 * 3x5 is the smallest cell that still keeps every digit distinct at scale 1.
 */
const GLYPHS = {
  0: '###|#.#|#.#|#.#|###',
  1: '.#.|##.|.#.|.#.|###',
  2: '###|..#|###|#..|###',
  3: '###|..#|.##|..#|###',
  4: '#.#|#.#|###|..#|..#',
  5: '###|#..|###|..#|###',
  6: '###|#..|###|#.#|###',
  7: '###|..#|..#|..#|..#',
  8: '###|#.#|###|#.#|###',
  9: '###|#.#|###|..#|###',
  A: '.#.|#.#|###|#.#|#.#',
  B: '##.|#.#|##.|#.#|##.',
  C: '.##|#..|#..|#..|.##',
  D: '##.|#.#|#.#|#.#|##.',
  E: '###|#..|##.|#..|###',
  F: '###|#..|##.|#..|#..',
  G: '.##|#..|#.#|#.#|.##',
  H: '#.#|#.#|###|#.#|#.#',
  I: '###|.#.|.#.|.#.|###',
  J: '..#|..#|..#|#.#|.#.',
  K: '#.#|#.#|##.|#.#|#.#',
  L: '#..|#..|#..|#..|###',
  M: '#.#|###|###|#.#|#.#',
  N: '##.|#.#|#.#|#.#|#.#',
  O: '###|#.#|#.#|#.#|###',
  P: '##.|#.#|##.|#..|#..',
  Q: '###|#.#|#.#|###|..#',
  R: '##.|#.#|##.|#.#|#.#',
  S: '.##|#..|.#.|..#|##.',
  T: '###|.#.|.#.|.#.|.#.',
  U: '#.#|#.#|#.#|#.#|###',
  V: '#.#|#.#|#.#|#.#|.#.',
  W: '#.#|#.#|###|###|#.#',
  X: '#.#|#.#|.#.|#.#|#.#',
  Y: '#.#|#.#|.#.|.#.|.#.',
  Z: '###|..#|.#.|#..|###',
  '+': '...|.#.|###|.#.|...',
  '-': '...|...|###|...|...',
  '!': '.#.|.#.|.#.|...|.#.',
  '.': '...|...|...|...|.#.',
  ' ': '...|...|...|...|...',
};

export const GLYPH_W = 3;
export const GLYPH_H = 5;
/** 1px letterspacing keeps 3-wide glyphs from fusing into a solid bar. */
export const TRACKING = 1;

/** Two masks per glyph: the fill, and a 1px-dilated silhouette behind it.
 *  Baking the outline separately means the caller can tint body and outline
 *  independently instead of re-drawing the string four times at offsets. */
let CACHE = null;

function maskTexture(cells, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c2d = canvas.getContext('2d');
  const img = c2d.createImageData(w, h);
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) continue;
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = 255;
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = 255;
  }
  c2d.putImageData(img, 0, 0);
  const source = new ImageSource({
    resource: canvas,
    scaleMode: 'nearest',
    alphaMode: 'premultiply-alpha-on-upload',
  });
  return new Texture({ source, frame: new Rectangle(0, 0, w, h) });
}

function bake() {
  const out = new Map();
  for (const [ch, spec] of Object.entries(GLYPHS)) {
    const rows = spec.split('|');
    const fill = new Uint8Array(GLYPH_W * GLYPH_H);
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) {
        if (rows[y][x] === '#') fill[y * GLYPH_W + x] = 1;
      }
    }
    // Dilate by one texel in all eight directions for the drop-out outline.
    const ow = GLYPH_W + 2, oh = GLYPH_H + 2;
    const halo = new Uint8Array(ow * oh);
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) {
        if (!fill[y * GLYPH_W + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) halo[(y + 1 + dy) * ow + (x + 1 + dx)] = 1;
        }
      }
    }
    out.set(ch, {
      fill: maskTexture(fill, GLYPH_W, GLYPH_H),
      halo: maskTexture(halo, ow, oh),
    });
  }
  return out;
}

export function glyphs() {
  if (!CACHE) CACHE = bake();
  return CACHE;
}

export const textWidth = (str, scale = 1) =>
  Math.max(0, str.length * (GLYPH_W + TRACKING) - TRACKING) * scale;

/**
 * Build a container holding one string. Scale must stay integral — a 1.5x
 * bitmap glyph produces uneven stem widths, which is exactly the artefact the
 * whole art direction exists to avoid.
 *
 * The container's own position is the string's top-left; `centre()` recentres.
 */
export function makeText(str, { scale = 1, fill = 0xffffff, outline = 0x1a0e20 } = {}) {
  const box = new Container();
  const g = glyphs();
  const step = (GLYPH_W + TRACKING) * scale;
  const halos = new Container();
  const fills = new Container();
  box.addChild(halos, fills);

  for (let i = 0; i < str.length; i++) {
    const glyph = g.get(str[i]) || g.get(' ');
    const x = i * step;

    const h = new Sprite(glyph.halo);
    h.x = x - scale;
    h.y = -scale;
    h.scale.set(scale);
    h.tint = outline;
    halos.addChild(h);

    const f = new Sprite(glyph.fill);
    f.x = x;
    f.scale.set(scale);
    f.tint = fill;
    fills.addChild(f);
  }

  box.fxWidth = textWidth(str, scale);
  box.fxHeight = GLYPH_H * scale;
  box.fxFills = fills;
  box.fxHalos = halos;
  return box;
}

/** Recolour a string built by `makeText` without rebuilding its sprites. */
export function tintText(box, fill, outline) {
  for (const s of box.fxFills.children) s.tint = fill;
  if (outline !== undefined) for (const s of box.fxHalos.children) s.tint = outline;
}
