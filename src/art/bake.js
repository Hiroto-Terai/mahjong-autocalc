import { Texture, Rectangle, ImageSource } from 'pixi.js';
import { FRUITS } from '../config.js';
import { FRUIT_ART, detailFor } from './fruits.js';
import { quantIndex, pick, bayer, toHex } from './palette.js';
import { PixBuf } from './canvas.js';

/** Rotation frames baked per fruit. Higher = smoother spin, more VRAM. */
export const ROT_FRAMES = 24;

/** Fixed key light, in screen space. Up-left-front, the pixel-art default. */
const LIGHT = (() => {
  const v = [-0.46, -0.62, 0.64];
  const len = Math.hypot(...v);
  return v.map((c) => c / len);
})();

/** Ambient floor. Below this the unlit side stops holding its silhouette. */
const AMBIENT = 0.17;

/**
 * The key light's response curve, tabulated. It is evaluated once per texel of
 * every rotation frame — a fractional `pow` there costs more than the shading
 * maths around it, and the result is quantised to five stops regardless.
 */
const KEY_CURVE = (() => {
  const t = new Float32Array(258);
  for (let i = 0; i <= 257; i++) t[i] = (Math.min(1, i / 256)) ** 0.85;
  return t;
})();

/* Per size bracket (tiny .. huge). Detail has to scale with the sprite: an
 * 8px-radius cherry has room for three shades and one highlight texel, and
 * handing it the watermelon's settings is what turns small fruit into mud. */
const STOPS = [3, 4, 5, 5, 5];
/** Width, in texels, of the dithered ribbon either side of a stop boundary. */
const DITHER_TEXELS = [0, 1.6, 2.2, 2.6, 3];
/** Depth, in texels, of the occluded band around the silhouette. */
const RIM_TEXELS = [1, 1.5, 2, 2.5, 3];

/** Object-space extent the marking grid covers, and its cells per texel. */
const GRID_SPAN = 2.4;
const GRID_DENSITY = 2;

/**
 * Evaluate a fruit's surface markings once into an object-space grid.
 *
 * Markings are a pure function of object space — that is the whole point of
 * sampling them there — so paying for asin, Worley and lattice maths on every
 * texel of all 24 rotations is 24x more work than the answer needs. Two cells
 * per texel keeps a stripe edge inside half a texel of where it belongs.
 */
function markingGrid(art, R, d) {
  const n = Math.max(24, Math.round(GRID_SPAN * R * GRID_DENSITY));
  const off = new Float32Array(n * n);
  const c = { d, R, u: 0, v: 0, uw: 0, vw: 0 };
  const half = GRID_SPAN / 2;
  for (let j = 0; j < n; j++) {
    const v = -half + (GRID_SPAN * (j + 0.5)) / n;
    for (let i = 0; i < n; i++) {
      const u = -half + (GRID_SPAN * (i + 0.5)) / n;
      c.u = u;
      c.v = v;
      // Sphere-warped coordinates: markings tighten toward the silhouette
      // like a real surface curving away, instead of sliding off flat.
      const rr = Math.hypot(u, v);
      const w = rr > 1e-4 ? Math.asin(Math.min(1, rr)) / (rr * Math.PI * 0.5) : 2 / Math.PI;
      c.uw = u * w;
      c.vw = v * w;
      off[j * n + i] = art.surf(c);
    }
  }
  const scale = n / GRID_SPAN;
  return {
    off,
    at(u, v) {
      const i = Math.max(0, Math.min(n - 1, ((u + half) * scale) | 0));
      const j = Math.max(0, Math.min(n - 1, ((v + half) * scale) | 0));
      return j * n + i;
    },
  };
}

/**
 * Farthest point of a fruit's height field from its centre, in radii.
 *
 * Sprites are padded for stems, so a third of the buffer can lie outside any
 * possible body; probing the field once lets the render loop reject those
 * texels before it does any object-space work for them.
 */
function reachOf(art) {
  let far = 0;
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    for (let r = 1.6; r > 0; r -= 0.02) {
      if (art.height(dx * r, dy * r) > 0) { far = Math.max(far, r); break; }
    }
  }
  return far + 0.04;
}

/**
 * Render one fruit at one rotation into a PixBuf.
 *
 *   1. object-space height field -> normal (so silhouette and shading agree)
 *   2. lambert against the fixed key light -> continuous luminance
 *   3. markings nudge that luminance, in whole ramp stops
 *   4. occlude the silhouette, then quantise onto the ramp, dithering *only*
 *      across each stop boundary
 *   5. hard specular, 1px outline, then stems and leaves on top
 *
 * Every colour on the body comes out of the fruit's one authored ramp. No
 * blend, no glow, no second palette: a sprite that carries thirty shades is a
 * downsampled render no matter how it was produced.
 */
function renderFruit(tier, angle) {
  const def = FRUITS[tier];
  const art = FRUIT_ART[tier];
  const R = def.radius;
  const d = detailFor(R);
  const n = STOPS[d];
  const stops = pick(art.stops, n);
  // Memoised on first use: neither the marking grid nor the reach varies by
  // frame, and the grid is the most expensive thing in the whole bake.
  if (art.surf && !art.grid) art.grid = markingGrid(art, R, d);
  if (art.reach === undefined) art.reach = reachOf(art);

  // Padding for stems and crowns keeps the size even, so the sprite's centre
  // texel stays exactly on the physics centre at anchor 0.5.
  const size = 2 * (R + art.pad);
  const cx = size / 2 - 0.5;
  const cy = size / 2 - 0.5;
  const buf = new PixBuf(size, size);

  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const proj = (u, v) => [cx + (u * ca - v * sa) * R, cy + (u * sa + v * ca) * R];

  // A dither ribbon a fixed number of *texels* wide, whatever the sprite size:
  // one ramp step spans about R/(n-1) texels down the terminator.
  const band = Math.min(0.45, (0.4 * DITHER_TEXELS[d] * (n - 1)) / R);
  const rimNz = Math.sqrt(Math.max(0, 1 - (1 - RIM_TEXELS[d] / R) ** 2));
  const step = 1 / (n - 1);
  const eps = 1 / R;
  const H = art.height;
  const grad = H.grad;
  const g2 = [0, 0];
  const grid = art.grid;
  const reach2 = art.reach * art.reach;
  const data = buf.data;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = (px - cx) / R;
      const dy = (py - cy) / R;
      if (dx * dx + dy * dy > reach2) continue;
      // Object space: the body's decoration spins, the key light does not.
      const u = dx * ca + dy * sa;
      const v = -dx * sa + dy * ca;

      const h = H(u, v);
      if (h <= 0) continue;

      if (grad) grad(u, v, h, g2);
      else {
        g2[0] = (H(u + eps, v) - H(u - eps, v)) / (2 * eps);
        g2[1] = (H(u, v + eps) - H(u, v - eps)) / (2 * eps);
      }
      const hu = Math.max(-12, Math.min(12, g2[0]));
      const hv = Math.max(-12, Math.min(12, g2[1]));
      const inv = 1 / Math.sqrt(1 + hu * hu + hv * hv);
      // Gradient back to screen space; the light must not rotate with the body.
      const nx = (-hu * ca + hv * sa) * inv;
      const ny = (-hu * sa - hv * ca) * inv;
      const nz = inv;

      const ndl = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2];
      const key = ndl > 0 ? AMBIENT + KEY_CURVE[(ndl * 256) | 0] * (1 - AMBIENT) : AMBIENT;
      let lum = key;

      // Markings, in ramp stops. Scaling by the local key light keeps texture
      // contrast highest where the light is: constant-contrast markings make
      // the shadow side busier than the lit side, which inverts the form.
      if (grid) lum += grid.off[grid.at(u, v)] * step * (0.4 + 0.6 * key);

      // Occlude toward the silhouette, hardest on the shadow side. A fruit
      // whose brightest stop runs to its own edge reads as a sticker, and
      // where two of them touch the crevice comes out brighter than either.
      if (nz < rimNz) {
        const e = 1 - nz / rimNz;
        const away = Math.max(0, Math.min(1, (0.3 - ndl) / 0.55));
        lum -= step * e * (0.6 + 1.5 * away);
      }

      const col = stops[quantIndex(lum, n, px, py, band)];
      const o = (py * size + px) * 4;
      data[o] = col[0];
      data[o + 1] = col[1];
      data[o + 2] = col[2];
      data[o + 3] = 255;
    }
  }

  specular(buf, art, R, cx, cy, d);
  buf.outline(art.outline);

  if (art.parts) {
    const ov = new PixBuf(size, size);
    art.parts(ov, { d, R, proj });
    ov.outline(art.partOutline);
    buf.blit(ov);
  }
  return buf;
}

/**
 * The specular: a solid core plus one ordered-dithered ring, both in the same
 * single highlight colour.
 *
 * Blending a soft falloff toward white is the other half of the downsampled
 * render look — it spends five or six shades on one small feature and none of
 * them are in the ramp.
 */
function specular(buf, art, R, cx, cy, d) {
  const hx = cx + LIGHT[0] * R * 0.52;
  const hy = cy + LIGHT[1] * R * 0.52;
  const core = Math.max(0.7, R * 0.12);
  const fringe = core + (d >= 2 ? 1.6 : 0.8);
  for (let y = Math.floor(hy - fringe); y <= Math.ceil(hy + fringe); y++) {
    for (let x = Math.floor(hx - fringe); x <= Math.ceil(hx + fringe); x++) {
      if (buf.alpha(x, y) === 0) continue;
      const dist = Math.hypot(x - hx, y - hy);
      if (dist <= core || (dist <= fringe && bayer(x, y) < 0.4)) {
        buf.set(x, y, art.hi, 255);
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
