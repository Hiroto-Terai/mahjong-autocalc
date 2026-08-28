import { Container, Sprite, Texture } from 'pixi.js';
import { quantAlpha } from './draw.js';

/**
 * Pooled chunky texel particles.
 *
 * Every particle is a 1x1 white texture scaled to a whole number of texels and
 * tinted — never a soft blob. Sprites are recycled rather than destroyed
 * because a watermelon merge spawns ~150 of them in a single frame and the
 * allocation spike is visible as a hitch at 60fps.
 */
export class Particles {
  constructor(parent, limit = 200) {
    this.container = new Container();
    parent.addChild(this.container);
    this.live = [];
    this.pool = [];
    this.limit = limit;
  }

  _sprite() {
    const s = this.pool.pop();
    if (s) { s.visible = true; return s; }
    const n = new Sprite(Texture.WHITE);
    this.container.addChild(n);
    return n;
  }

  /**
   * `shrink` steps the particle down through whole texel sizes over its life,
   * which is what makes debris look like it is receding rather than dissolving.
   */
  spawn({
    x, y, vx = 0, vy = 0, size = 2, colour = 0xffffff, life = 400,
    gravity = 380, drag = 0, shrink = true, blink = 0, floorY = null,
  }) {
    if (this.live.length >= this.limit) {
      // Drop the oldest rather than refusing the new one: a fresh burst always
      // matters more than the tail of the previous one.
      const oldest = this.live.reduce((a, p, i) => (p.age / p.life > a.r ? { i, r: p.age / p.life } : a), { i: 0, r: -1 });
      this._retire(oldest.i);
    }
    const s = this._sprite();
    s.tint = colour;
    s.alpha = 1;
    s.x = Math.round(x);
    s.y = Math.round(y);
    s.scale.set(size);
    this.live.push({
      s, x, y, vx, vy, size, life, age: 0, gravity, drag, shrink, blink, floorY,
    });
  }

  _retire(i) {
    const p = this.live[i];
    p.s.visible = false;
    this.pool.push(p.s);
    this.live.splice(i, 1);
  }

  update(dtMs) {
    const dt = dtMs / 1000;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += dtMs;
      if (p.age >= p.life) { this._retire(i); continue; }

      p.vy += p.gravity * dt;
      if (p.drag) {
        const k = Math.max(0, 1 - p.drag * dt);
        p.vx *= k;
        p.vy *= k;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Debris that reaches the pile floor skids instead of sinking through it.
      if (p.floorY !== null && p.y > p.floorY) {
        p.y = p.floorY;
        p.vy *= -0.32;
        p.vx *= 0.6;
      }

      const t = p.age / p.life;
      const size = p.shrink ? Math.max(1, Math.round(p.size * (1 - t * 0.85))) : p.size;
      const s = p.s;
      s.x = Math.round(p.x);
      s.y = Math.round(p.y);
      if (s.scale.x !== size) s.scale.set(size);
      // Hold full opacity for the first half: particles that start fading the
      // instant they are born never read as solid matter.
      const fade = t < 0.5 ? 1 : 1 - (t - 0.5) * 2;
      s.alpha = p.blink && t > 0.35
        ? (Math.floor(p.age / p.blink) % 2 ? 0 : quantAlpha(fade))
        : quantAlpha(fade);
    }
  }

  clear() {
    for (let i = this.live.length - 1; i >= 0; i--) this._retire(i);
  }
}
