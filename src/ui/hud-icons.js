import { PixBuf } from '../art/canvas.js';
import { bufTexture } from './font.js';
import { FRUITS } from '../config.js';

/**
 * Miniature fruit icons for the NEXT preview and the evolution chain.
 *
 * A baked fruit is up to 104 texels across; letting the GPU shrink it to 12
 * would either resample it (banned) or point-sample it into confetti. Instead
 * the baked canvas is box-filtered down to the exact icon size on the CPU,
 * masked back to a clean disc and re-outlined, so a 9px cherry is a real 9px
 * sprite with its own silhouette rather than a downscaled photo of one.
 */
export class FruitIcons {
  constructor(renderer) {
    this.renderer = renderer;
    this.cache = new Map();
    this.pixels = new Map();
  }

  /** Lazily pull the baked canvas for a tier into a readable ImageData. */
  _source(tier) {
    let src = this.pixels.get(tier);
    if (!src) {
      const canvas = this.renderer.texture(tier, 0).source.resource;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      src = g.getImageData(0, 0, canvas.width, canvas.height);
      this.pixels.set(tier, src);
    }
    return src;
  }

  /**
   * Icon texture for `tier` at `d` texels across.
   * `locked` swaps the fruit for a flat silhouette — the undiscovered state
   * that makes filling the chain feel like collecting something.
   */
  texture(tier, d, locked = false) {
    const key = `${tier}:${d}:${locked ? 1 : 0}`;
    let tex = this.cache.get(key);
    if (tex) return tex;
    tex = bufTexture(locked ? this._silhouette(d) : this._shrink(tier, d));
    this.cache.set(key, tex);
    return tex;
  }

  _shrink(tier, d) {
    const src = this._source(tier);
    const S = src.width;
    const buf = new PixBuf(d + 2, d + 2);
    const c = (d - 1) / 2;
    const rr = (d / 2) * (d / 2);
    let sumR = 0, sumG = 0, sumB = 0, sumN = 0;

    for (let y = 0; y < d; y++) {
      for (let x = 0; x < d; x++) {
        const dx = x - c, dy = y - c;
        if (dx * dx + dy * dy > rr) continue;
        // Box-filter the source region this icon texel covers.
        const x0 = Math.floor((x * S) / d), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * S) / d));
        const y0 = Math.floor((y * S) / d), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * S) / d));
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = y0; sy < y1; sy++) {
          for (let sx = x0; sx < x1; sx++) {
            const i = (sy * S + sx) * 4;
            const w = src.data[i + 3] / 255;
            r += src.data[i] * w; g += src.data[i + 1] * w; b += src.data[i + 2] * w; a += w;
          }
        }
        if (a < 0.25) continue;
        // Averaging a dithered ramp desaturates it; push the chroma back out
        // or every icon converges on the same grey-brown at this size.
        let col = saturate([r / a, g / a, b / a], 1.35);
        buf.set(x + 1, y + 1, col);
        sumR += col[0]; sumG += col[1]; sumB += col[2]; sumN++;
      }
    }

    if (sumN) {
      const avg = [sumR / sumN, sumG / sumN, sumB / sumN];
      buf.outline([Math.round(avg[0] * 0.28) + 6, Math.round(avg[1] * 0.28) + 8, Math.round(avg[2] * 0.3) + 16]);
    }
    // A single specular texel up-left restores the roundness the box filter ate.
    if (d >= 8) {
      const hx = Math.round(c - d * 0.24) + 1, hy = Math.round(c - d * 0.26) + 1;
      if (buf.alpha(hx, hy)) {
        const cur = buf.get(hx, hy);
        buf.set(hx, hy, [Math.min(255, cur[0] + 90), Math.min(255, cur[1] + 84), Math.min(255, cur[2] + 70)]);
      }
    }
    return buf;
  }

  _silhouette(d) {
    const buf = new PixBuf(d + 2, d + 2);
    const c = (d - 1) / 2;
    const rr = (d / 2) * (d / 2);
    for (let y = 0; y < d; y++) {
      for (let x = 0; x < d; x++) {
        const dx = x - c, dy = y - c;
        if (dx * dx + dy * dy > rr) continue;
        buf.set(x + 1, y + 1, [44, 52, 88]);
      }
    }
    buf.outline([24, 29, 52]);
    return buf;
  }
}

function saturate([r, g, b], k) {
  const l = r * 0.299 + g * 0.587 + b * 0.114;
  return [
    Math.max(0, Math.min(255, Math.round(l + (r - l) * k))),
    Math.max(0, Math.min(255, Math.round(l + (g - l) * k))),
    Math.max(0, Math.min(255, Math.round(l + (b - l) * k))),
  ];
}

/** Icon diameter for a tier in the evolution chain: the chain must show the
 *  ladder getting bigger, but 11 fruit have to fit across 320 texels. */
export function chainDiameter(tier) {
  return 6 + Math.round((tier / (FRUITS.length - 1)) * 10);
}

/** Icon diameter for the NEXT preview: relative size is information, but the
 *  well is fixed, so the five spawnable tiers are compressed into it. */
export function previewDiameter(tier) {
  const r = FRUITS[tier].radius;
  return Math.min(18, Math.round(r * 0.9) + 2);
}
