import { bufTexture } from './font.js';
import { iconBuf, lockedBuf } from './hud-fruiticons.js';

/** Texture cache for the authored icon art. Icons are tiny and few, so every
 *  size/state combination is baked once on first use and kept. */
export class FruitIcons {
  constructor() { this.cache = new Map(); }

  texture(tier, d, locked = false) {
    const key = `${tier}:${d}:${locked ? 1 : 0}`;
    let tex = this.cache.get(key);
    if (!tex) {
      tex = bufTexture(locked ? lockedBuf(d) : iconBuf(tier, d));
      this.cache.set(key, tex);
    }
    return tex;
  }
}

/** The icon buffers carry a 2px margin for stems and outlines; callers place
 *  sprites by the disc, not by the buffer. */
export const ICON_PAD = 2;

/** Chain icons grow one texel per tier: the row has to *show* the ladder. */
export const chainDiameter = (tier) => 8 + tier;

/** NEXT preview keeps relative size legible inside a fixed well. */
export const previewDiameter = (tier) => 12 + tier * 2;
