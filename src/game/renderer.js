import { Sprite, Container } from 'pixi.js';
import { bakeFruitTextures, ROT_FRAMES } from '../art/bake.js';
import { FRUITS } from '../config.js';

/**
 * Draws physics bodies as pixel sprites.
 *
 * Two rules keep the art crisp:
 *   - positions snap to whole virtual pixels (no sub-texel smearing)
 *   - rotation picks a pre-baked frame instead of rotating the sprite, so the
 *     GPU never resamples the art
 */
export class FruitRenderer {
  constructor(ctx) {
    this.ctx = ctx;
    const layer = ctx.layers.fruit;
    this.layer = layer;
    this.container = new Container();
    layer.addChild(this.container);
    const baked = bakeFruitTextures();
    this.frames = baked.frames;
    this.sprites = new Map();
  }

  sync(game, alpha, nowMs) {
    const physics = game.physics;
    const seen = new Set();

    for (const rec of physics.fruits.values()) {
      seen.add(rec.uid);
      let s = this.sprites.get(rec.uid);
      if (!s) {
        s = new Sprite(this.frames[rec.tier][0]);
        s.anchor.set(0.5);
        this.container.addChild(s);
        this.sprites.set(rec.uid, s);
      }

      const b = rec.body;
      // Interpolate between the last two physics transforms.
      const x = rec.px + (b.position.x - rec.px) * alpha;
      const y = rec.py + (b.position.y - rec.py) * alpha;
      let a = b.angle;
      const da = ((a - rec.pa + Math.PI) % (Math.PI * 2)) - Math.PI;
      a = rec.pa + da * alpha;

      let frame = Math.round((a / (Math.PI * 2)) * ROT_FRAMES) % ROT_FRAMES;
      if (frame < 0) frame += ROT_FRAMES;
      const tex = this.frames[rec.tier][frame];
      if (s.texture !== tex) s.texture = tex;

      s.x = Math.round(x);
      s.y = Math.round(y);

      // Pop-in: a brief overshoot so spawns and merges have weight.
      const age = nowMs - rec.bornAt;
      if (age < 220) {
        const t = age / 220;
        const pop = 1 + Math.sin(t * Math.PI) * 0.18 * (1 - t);
        s.scale.set(pop, 2 - pop);
      } else if (s.scale.x !== 1) {
        s.scale.set(1);
      }
    }

    for (const [uid, s] of this.sprites) {
      if (!seen.has(uid)) {
        s.destroy();
        this.sprites.delete(uid);
      }
    }
  }

  /** Texture for a tier at rest — used by the claw and the next-up preview. */
  texture(tier, frame = 0) { return this.frames[tier][frame % ROT_FRAMES]; }

  clear() {
    for (const s of this.sprites.values()) s.destroy();
    this.sprites.clear();
  }
}

export { FRUITS };
