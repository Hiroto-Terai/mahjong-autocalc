import { Texture, Rectangle, ImageSource } from 'pixi.js';
import { FRUITS } from '../config.js';
import { FRUIT_ART } from './fruits.js';
import { ramp, bayer, mix, toHex } from './palette.js';
import { PixBuf } from './canvas.js';

/** Rotation frames baked per fruit. Higher = smoother spin, more VRAM. */
export const ROT_FRAMES = 24;

/** Fixed key light, in screen space. Up-left-front, the pixel-art default. */
const LIGHT = (() => {
  const v = [-0.48, -0.62, 0.62];
  const len = Math.hypot(...v);
  return v.map((c) => c / len);
})();

/**
 * Render one fruit at one rotation into a PixBuf.
 *
 * The pipeline per texel:
 *   1. sphere normal from the disc coordinate
 *   2. lambert + rim term  -> continuous luminance
 *   3. multiply by the fruit's object-space albedo (rotated with the body)
 *   4. quantise onto a 5-stop ramp, Bayer-dithering across each boundary
 *   5. specular blob, then a 1px outline wrapped around the silhouette
 */
function renderFruit(tier, angle) {
  const def = FRUITS[tier];
  const art = FRUIT_ART[tier];
  const R = def.radius;
  const pad = 2;
  const size = R * 2 + pad * 2;
  const buf = new PixBuf(size, size);
  const cx = size / 2 - 0.5;
  const cy = size / 2 - 0.5;

  const stops = ramp(art.shadow, art.light, 5, art.hueShift);
  const ca = Math.cos(-angle), sa = Math.sin(-angle);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = (px - cx) / R;
      const dy = (py - cy) / R;
      const r2 = dx * dx + dy * dy;
      if (r2 > 1) continue;

      const nz = Math.sqrt(Math.max(0, 1 - r2));
      // Lambert against the fixed key light.
      let lum = dx * LIGHT[0] + dy * LIGHT[1] + nz * LIGHT[2];
      lum = Math.max(0, lum);
      // Ambient fill + a rim term so the dark side never goes flat.
      const rim = Math.pow(1 - nz, 3) * 0.35;
      lum = 0.18 + lum * 0.82 + rim;

      // Object-space lookup for decoration.
      const u = dx * ca - dy * sa;
      const v = dx * sa + dy * ca;
      lum *= art.albedo(u, v, { r: Math.sqrt(r2), nz });

      lum = Math.max(0, Math.min(1, lum));

      // Quantise with ordered dithering: find the ramp band, then let the
      // Bayer threshold decide whether this texel rounds up or down.
      const scaled = lum * (stops.length - 1);
      const lo = Math.floor(scaled);
      const frac = scaled - lo;
      const idx = Math.min(stops.length - 1, lo + (frac > bayer(px, py) ? 1 : 0));
      let col = stops[idx];

      // Specular: a small, hard highlight offset toward the light.
      const hx = dx + LIGHT[0] * 0.55;
      const hy = dy + LIGHT[1] * 0.55;
      const hd = Math.hypot(hx, hy);
      const specR = 0.30;
      if (hd < specR && nz > 0.35) {
        const t = 1 - hd / specR;
        if (t > 0.55 || (t > 0.28 && bayer(px, py) < t)) {
          col = mix(col, [255, 255, 255], Math.min(0.85, 0.35 + t * 0.6));
        }
      }

      buf.set(px, py, col, 255);
    }
  }

  decorate(buf, tier, angle, R, cx, cy);
  buf.outline(art.outline);
  return buf;
}

/** Overlays that are easier to draw explicitly than to express as albedo. */
function decorate(buf, tier, angle, R, cx, cy) {
  const art = FRUIT_ART[tier];
  const ca = Math.cos(-angle), sa = Math.sin(-angle);
  const size = buf.w;

  const objToScreen = (u, v) => {
    const c = Math.cos(angle), s = Math.sin(angle);
    return [cx + (u * c - v * s) * R, cy + (u * s + v * c) * R];
  };

  // Watermelon stripes: drawn as object-space vertical bands, wrapped around
  // the sphere so they taper correctly toward the silhouette.
  if (art.stripe) {
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        if (buf.alpha(px, py) === 0) continue;
        const dx = (px - cx) / R, dy = (py - cy) / R;
        const r2 = dx * dx + dy * dy;
        if (r2 > 1) continue;
        const u = dx * ca - dy * sa;
        const v = dx * sa + dy * ca;
        // Spherical longitude so stripes compress at the edges like a real melon.
        const lon = Math.asin(Math.max(-1, Math.min(1, u)));
        const band = Math.sin(lon * art.stripe.count);
        if (band > 0.55) {
          const cur = buf.get(px, py);
          buf.set(px, py, mix([cur[0], cur[1], cur[2]], art.stripe.colour, 0.72), 255);
        }
        void v;
      }
    }
  }

  // Melon netting.
  if (art.net) {
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        if (buf.alpha(px, py) === 0) continue;
        const dx = (px - cx) / R, dy = (py - cy) / R;
        if (dx * dx + dy * dy > 0.96) continue;
        const u = dx * ca - dy * sa;
        const v = dx * sa + dy * ca;
        const n = Math.abs(Math.sin(u * art.net.freq + Math.sin(v * 3.1)))
                + Math.abs(Math.sin(v * art.net.freq * 0.8));
        if (n > 1.72) {
          const cur = buf.get(px, py);
          buf.set(px, py, mix([cur[0], cur[1], cur[2]], art.net.colour, 0.6), 255);
        }
      }
    }
  }

  // Seeds / speckles: deterministic per fruit so they do not swim between
  // rotation frames — they are placed in object space and projected out.
  if (art.speckle) {
    const n = Math.max(4, Math.round(R * R * art.speckle.density));
    let s = 0x9e3779b9 ^ (tier * 2654435761);
    const rnd = () => {
      s = (s ^ (s << 13)) >>> 0; s = (s ^ (s >>> 17)) >>> 0; s = (s ^ (s << 5)) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd()) * 0.86;
      const [sx, sy] = objToScreen(Math.cos(a) * rr, Math.sin(a) * rr);
      buf.set(Math.round(sx), Math.round(sy), art.speckle.colour, 255);
    }
  }

  // Citrus pores: dithered darker texels, no rotation needed (isotropic).
  if (art.pore) {
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        if (buf.alpha(px, py) === 0) continue;
        if (bayer(px * 3 + tier, py * 5) < art.pore.density) {
          const cur = buf.get(px, py);
          buf.set(px, py, mix([cur[0], cur[1], cur[2]], art.pore.colour, 0.35), 255);
        }
      }
    }
  }
}

/**
 * Bake every fruit at every rotation into GPU textures.
 * Returns { frames: Texture[][] } indexed [tier][frame].
 */
export function bakeFruitTextures() {
  const frames = [];
  for (let tier = 0; tier < FRUITS.length; tier++) {
    const row = [];
    for (let f = 0; f < ROT_FRAMES; f++) {
      const angle = (f / ROT_FRAMES) * Math.PI * 2;
      const buf = renderFruit(tier, angle);
      const source = new ImageSource({
        resource: buf.toCanvas(),
        scaleMode: 'nearest',
        alphaMode: 'premultiply-alpha-on-upload',
      });
      row.push(new Texture({ source, frame: new Rectangle(0, 0, buf.w, buf.h) }));
    }
    frames.push(row);
  }
  return { frames, frameCount: ROT_FRAMES };
}

export { toHex };
