import { Container, Sprite } from 'pixi.js';
import { SMALL, DISPLAY, measure, textBuf, bufTexture } from '../ui/font.js';

/**
 * Score popups and banners, drawn in the game's one bitmap face.
 *
 * This module used to carry its own glyph set, which is why popups and the
 * HUD disagreed about what the game's typeface was. It now adapts the UI
 * face and keeps only what the FX layer actually needs on top: a silhouette
 * behind the ink, and recolouring without a texture rebuild.
 *
 * The ink is rendered white and tinted, so a popup can flash through several
 * colours per frame without re-rasterising a single glyph.
 */

const FACES = { small: SMALL, display: DISPLAY };

/** Cache keyed by string + face + outline: popups repeat the same few words. */
const cache = new Map();

function textures(str, faceName, outline) {
  const key = `${faceName}|${outline}|${str}`;
  let entry = cache.get(key);
  if (entry) return entry;

  const face = FACES[faceName];
  // Halo and ink are separate textures so the ink stays tintable; baking the
  // outline into one texture would tint the outline along with the letters.
  const halo = bufTexture(textBuf(str, { face, colour: outline, outline }));
  const ink = bufTexture(textBuf(str, { face, colour: 0xffffff }));
  entry = { halo, ink, w: measure(str, face), h: face.h };
  cache.set(key, entry);
  return entry;
}

export function makeText(str, { fill = 0xffffff, outline = 0x1a0e20, face = 'small' } = {}) {
  const t = textures(str, face, outline);
  const box = new Container();

  const halo = new Sprite(t.halo);
  // textBuf pads by one texel for the outline; the ink is unpadded, so the
  // halo shifts back by that pad to keep the two in register.
  halo.x = -1;
  halo.y = -1;
  const inkSprite = new Sprite(t.ink);
  inkSprite.tint = fill;
  box.addChild(halo, inkSprite);

  box.fxWidth = t.w;
  box.fxHeight = t.h;
  box.fxFills = inkSprite;
  return box;
}

/** Recolour a string built by `makeText` without rebuilding its texture. */
export function tintText(box, fill) {
  box.fxFills.tint = fill;
}
