import { Container, Graphics } from 'pixi.js';

/** Particles, shake and merge bursts. BASELINE — owned by the FX pass. */
export class Fx {
  constructor(ctx) {
    this.ctx = ctx;
    this.layer = new Container();
    ctx.layers.fx.addChild(this.layer);
    this.root = ctx.root;
    ctx.events.on('merge', ({ x, y, tier }) => this.burst(x, y, tier));
    this.parts = [];
    this.shake = 0;
  }

  burst(x, y, tier) {
    const n = 6 + tier;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const g = new Graphics().rect(0, 0, 2, 2).fill(0xffffff);
      g.x = x; g.y = y;
      this.layer.addChild(g);
      this.parts.push({ g, vx: Math.cos(a) * 60, vy: Math.sin(a) * 60 - 20, life: 380, age: 0 });
    }
    this.shake = Math.min(6, 1.5 + tier * 0.4);
  }

  update(dt, game) {
    void game;
    const s = dt / 1000;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.age += dt;
      if (p.age >= p.life) { p.g.destroy(); this.parts.splice(i, 1); continue; }
      p.vy += 420 * s;
      p.g.x += p.vx * s;
      p.g.y += p.vy * s;
      p.g.alpha = 1 - p.age / p.life;
    }
    if (this.shake > 0.05) {
      this.shake *= Math.pow(0.001, s);
      this.root.x = Math.round((Math.random() - 0.5) * this.shake);
      this.root.y = Math.round((Math.random() - 0.5) * this.shake);
    } else {
      this.root.x = 0; this.root.y = 0;
    }
  }
}
