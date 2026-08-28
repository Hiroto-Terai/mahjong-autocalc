/**
 * A tiny indexed-pixel canvas. Everything is authored here at 1:1 texel scale
 * and only uploaded to the GPU at the end, so no filtering ever touches it.
 */
export class PixBuf {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }

  set(x, y, [r, g, b], a = 255) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = a;
  }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return [0, 0, 0, 0];
    const i = (y * this.w + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  alpha(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.data[(y * this.w + x) * 4 + 3];
  }

  /** Paint only where something opaque already is — clips decoration to a body. */
  over(x, y, colour) {
    if (this.alpha(x, y) > 0) this.set(x, y, colour, 255);
  }

  /** Wrap a 1px outline around every opaque texel that borders transparency. */
  outline(colour, alphaThreshold = 8) {
    const copy = new Uint8ClampedArray(this.data);
    const opaque = (x, y) => {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
      return copy[(y * this.w + x) * 4 + 3] > alphaThreshold;
    };
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (opaque(x, y)) continue;
        if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) {
          this.set(x, y, colour, 255);
        }
      }
    }
  }

  /** Composite another buffer of the same size on top, transparency skipped. */
  blit(src) {
    for (let i = 0; i < this.data.length; i += 4) {
      if (src.data[i + 3] === 0) continue;
      this.data[i] = src.data[i];
      this.data[i + 1] = src.data[i + 1];
      this.data[i + 2] = src.data[i + 2];
      this.data[i + 3] = src.data[i + 3];
    }
  }

  toCanvas() {
    const c = document.createElement('canvas');
    c.width = this.w; c.height = this.h;
    const ctx = c.getContext('2d');
    ctx.putImageData(new ImageData(this.data, this.w, this.h), 0, 0);
    return c;
  }
}

/* ------------------------------------------------------------------ *
 * Shape primitives.
 *
 * Stems, leaves and crowns are the parts that break the circular silhouette,
 * and a fruit is unrecognisable without them. They are drawn as explicit
 * geometry rather than falling out of the sphere shader, because their whole
 * job is to *not* look like part of the sphere.
 * ------------------------------------------------------------------ */

/**
 * Square brush swept along a polyline, width tapering from w0 to w1.
 *
 * The segments are walked a texel at a time rather than stamped at the given
 * vertices: a two-point stem otherwise renders as two disconnected blobs with
 * a gap where the stem should be.
 */
export function stroke(buf, pts, w0, w1, colour) {
  const total = pts.length - 1;
  if (total < 0) return;
  const stamp = (x, y, w) => {
    const o = (w - 1) >> 1;
    for (let dy = 0; dy < w; dy++) {
      for (let dx = 0; dx < w; dx++) buf.set(x - o + dx, y - o + dy, colour, 255);
    }
  };
  if (total === 0) {
    stamp(Math.round(pts[0][0]), Math.round(pts[0][1]), Math.max(1, Math.round(w0)));
    return;
  }
  for (let i = 0; i < total; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let k = 0; k <= steps; k++) {
      const f = k / steps;
      const t = (i + f) / total;
      stamp(
        Math.round(ax + (bx - ax) * f),
        Math.round(ay + (by - ay) * f),
        Math.max(1, Math.round(w0 + (w1 - w0) * t)),
      );
    }
  }
}

/** Sample a quadratic bezier into a point list dense enough to have no gaps. */
export function bezier(p0, p1, p2, steps = 24) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s = 1 - t;
    out.push([
      s * s * p0[0] + 2 * s * t * p1[0] + t * t * p2[0],
      s * s * p0[1] + 2 * s * t * p1[1] + t * t * p2[1],
    ]);
  }
  return out;
}

const LIGHT2 = [-0.6, -0.8];

/**
 * A pointed leaf between two points, shaded in three tones.
 *
 * The lit half is chosen from the leaf's own screen-space orientation against
 * the same key light the body uses, so a leaf never contradicts the sphere it
 * sits on. Leaves longer than a few texels also get a midrib, which is what
 * stops them reading as green blobs.
 */
export function leaf(buf, ax, ay, bx, by, halfW, dark, mid, light) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular, pointed toward the key light so `lit` picks a real side.
  const px = -uy;
  const py = ux;
  const litSign = px * LIGHT2[0] + py * LIGHT2[1] >= 0 ? 1 : -1;
  const rib = halfW >= 2.2 && len >= 7;

  const x0 = Math.floor(Math.min(ax, bx) - halfW - 1);
  const x1 = Math.ceil(Math.max(ax, bx) + halfW + 1);
  const y0 = Math.floor(Math.min(ay, by) - halfW - 1);
  const y1 = Math.ceil(Math.max(ay, by) + halfW + 1);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const rx = x - ax;
      const ry = y - ay;
      const t = (rx * ux + ry * uy) / len;
      if (t < 0 || t > 1) continue;
      const d = rx * px + ry * py;
      // Lens profile: full width at the middle, a point at each end.
      const w = halfW * Math.sin(Math.PI * t) ** 0.62;
      if (Math.abs(d) > w) continue;
      const s = (d * litSign) / Math.max(0.001, w);
      let c = mid;
      if (s < -0.28) c = light;
      else if (s > 0.34) c = dark;
      if (rib && Math.abs(d) < 0.7 && t > 0.12 && t < 0.92) c = dark;
      buf.set(x, y, c, 255);
    }
  }
}

/** Filled disc clipped to texels that are already opaque (decoration on a body). */
export function discOver(buf, cx, cy, r, colour) {
  const R = Math.max(0, r);
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  const n = Math.ceil(R);
  for (let y = -n; y <= n; y++) {
    for (let x = -n; x <= n; x++) {
      if (x * x + y * y <= R * R) buf.over(x0 + x, y0 + y, colour);
    }
  }
}
