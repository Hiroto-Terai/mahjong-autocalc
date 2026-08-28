import { Texture, Rectangle, ImageSource } from 'pixi.js';
import { FRUITS } from '../config.js';
import { FRUIT_ART, detailFor } from './fruits.js';
import { quantIndex, pick, bayer, mix, toHex } from './palette.js';
import { PixBuf } from './canvas.js';

/** Rotation frames baked per fruit. Higher = smoother spin, more VRAM. */
export const ROT_FRAMES = 24;

/** Fixed key light, in screen space. Up-left-front, the pixel-art default. */
const LIGHT = (() => {
  const v = [-0.46, -0.62, 0.64];
  const len = Math.hypot(...v);
  return v.map((c) => c / len);
})();

/** Direction of the cool bounce rim: opposite the key, in screen space. */
const BOUNCE = [0.64, 0.77];

/** Ambient floor. Below this the unlit side stops holding its silhouette. */
const AMBIENT = 0.17;

/* Per size bracket (tiny .. huge). Detail has to scale with the sprite: an
 * 8px-radius cherry has room for three shades and one highlight texel, and
 * handing it the watermelon's settings is what turns small fruit into mud. */
const STOPS = [3, 4, 5, 5, 5];
/** Width, in texels, of the dithered ribbon either side of a stop boundary. */
const DITHER_TEXELS = [0, 1.6, 2.2, 2.6, 3.0];
/** Thickness of the bounce rim along the shadow edge, in texels. */
const RIM_TEXELS = [1, 1, 1.5, 2, 2];

/**
 * Render one fruit at one rotation into a PixBuf.
 *
 *   1. object-space height field -> normal (so silhouette and shading agree)
 *   2. lambert against the fixed key light -> continuous luminance
 *   3. the fruit's own surface function picks a ramp and nudges luminance
 *   4. quantise onto the ramp, dithering *only* across each stop boundary
 *   5. bounce rim, specular blob, clipped surface markings, 1px outline
 *   6. stems and leaves, outlined separately, composited on top
 */
function renderFruit(tier, angle) {
  const def = FRUITS[tier];
  const art = FRUIT_ART[tier];
  const R = def.radius;
  const d = detailFor(R);
  const n = STOPS[d];
  const ramps = art.stops.map((s) => pick(s, n));
  const size = 2 * (R + art.pad);
  const cx = size / 2 - 0.5;
  const cy = size / 2 - 0.5;
  const buf = new PixBuf(size, size);
  const lit = new Float32Array(size * size);

  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const proj = (u, v) => [cx + (u * ca - v * sa) * R, cy + (u * sa + v * ca) * R];

  // A dither ribbon a fixed number of *texels* wide, whatever the sprite size:
  // one ramp step spans about R/(n-1) texels down the terminator.
  const band = Math.min(0.45, (0.4 * DITHER_TEXELS[d] * (n - 1)) / R);
  const rimNz = Math.sqrt(Math.max(0, 1 - (1 - RIM_TEXELS[d] / R) ** 2));
  const eps = 1 / R;
  const H = art.height;
  const surf = art.surf;

  const c = {
    d, R, u: 0, v: 0, px: 0, py: 0, lon: 0, lat: 0, uw: 0, vw: 0, add: 0,
    proj,
    solid: (x, y) => buf.alpha(x, y) > 0,
    lit: (x, y) => lit[y * size + x] || 0,
    ramp: (i) => ramps[Math.min(ramps.length - 1, i)],
  };

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = (px - cx) / R;
      const dy = (py - cy) / R;
      // Object space: the body's decoration spins, the key light does not.
      const u = dx * ca + dy * sa;
      const v = -dx * sa + dy * ca;

      const h = H(u, v);
      if (h <= 0) continue;

      let hu = (H(u + eps, v) - H(u - eps, v)) / (2 * eps);
      let hv = (H(u, v + eps) - H(u, v - eps)) / (2 * eps);
      hu = Math.max(-12, Math.min(12, hu));
      hv = Math.max(-12, Math.min(12, hv));
      const inv = 1 / Math.sqrt(1 + hu * hu + hv * hv);
      // Gradient back to screen space; the light must not rotate with the body.
      const nx = (-hu * ca + hv * sa) * inv;
      const ny = (-hu * sa - hv * ca) * inv;
      const nz = inv;

      const ndl = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2];
      let lum = AMBIENT + Math.max(0, ndl) ** 0.85 * (1 - AMBIENT);

      let rampIdx = 0;
      if (surf) {
        c.u = u; c.v = v; c.px = px; c.py = py; c.add = 0;
        const cosLat = Math.sqrt(Math.max(0, 1 - v * v));
        c.lat = Math.asin(Math.max(-1, Math.min(1, v)));
        c.lon = Math.asin(Math.max(-1, Math.min(1, u / Math.max(cosLat, 1e-3))));
        // Sphere-warped coordinates: markings compress toward the silhouette
        // like a real surface curving away, instead of sliding off flat.
        const rr = Math.hypot(u, v);
        const w = rr > 1e-4 ? Math.asin(Math.min(1, rr)) / (rr * Math.PI * 0.5) : 0.6366;
        c.uw = u * w; c.vw = v * w;
        rampIdx = surf(c) | 0;
        lum += c.add;
      }

      lit[py * size + px] = lum;
      const idx = quantIndex(lum, n, px, py, band);
      let col = ramps[Math.min(ramps.length - 1, rampIdx)][idx];

      // Cool bounce along the shadow edge: without it a dark fruit dissolves
      // into the dark jar, and a flat dark edge is what kills the roundness.
      if (nz < rimNz && ndl < 0.3 && nx * BOUNCE[0] + ny * BOUNCE[1] > 0.4) {
        col = art.bounce;
      }

      buf.set(px, py, col, 255);
    }
  }

  specular(buf, art, R, cx, cy, d);
  if (art.surface) art.surface(buf, c);
  buf.outline(art.outline);

  if (art.parts) {
    const ov = new PixBuf(size, size);
    art.parts(ov, c);
    ov.outline(art.partOutline);
    buf.blit(ov);
  }
  return buf;
}

/**
 * A hard specular blob, fixed in screen space.
 *
 * Blending a soft white gaussian is the other half of the downsampled-render
 * look; this is a solid core with a single dithered fringe, sized by bracket.
 */
function specular(buf, art, R, cx, cy, d) {
  const hx = cx + LIGHT[0] * R * 0.52;
  const hy = cy + LIGHT[1] * R * 0.52;
  const core = Math.max(0.7, R * 0.13);
  const fringe = core + (d >= 2 ? 1.8 : 0.9);
  const x0 = Math.floor(hx - fringe);
  const x1 = Math.ceil(hx + fringe);
  const y0 = Math.floor(hy - fringe);
  const y1 = Math.ceil(hy + fringe);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (buf.alpha(x, y) === 0) continue;
      const dist = Math.hypot(x - hx, y - hy);
      if (dist <= core) {
        buf.set(x, y, art.hi, 255);
      } else if (dist <= fringe && bayer(x, y) < 0.45) {
        buf.set(x, y, mix(buf.get(x, y), art.hi, 0.55), 255);
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
