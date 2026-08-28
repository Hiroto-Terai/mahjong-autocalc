import { Sprite, Container } from 'pixi.js';
import { bakeFruitTextures, ROT_FRAMES } from '../art/bake.js';
import { FRUITS } from '../config.js';

/** Duration of the spawn overshoot, ms. */
const POP_MS = 220;

/**
 * Contact shadow, cast down-right because the key light sits upper-left.
 *
 * A sprite cannot darken itself *because a neighbour is there*, so without
 * this a packed jar reads as a sticker sheet: every fruit shows its brightest
 * stop right up against the next one, and the crevice — physically the
 * darkest point on the pile — comes out at full brightness. Each fruit draws
 * its own silhouette in black immediately beneath itself, so the shadow lands
 * on whatever was drawn earlier and the pile gains real depth.
 */
const SHADOW = { dx: 3, dy: 4, alpha: 0.5 };

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
        const shadow = new Sprite(this.frames[rec.tier][0]);
        shadow.anchor.set(0.5);
        shadow.tint = 0x000000;
        shadow.alpha = SHADOW.alpha;
        s = new Sprite(this.frames[rec.tier][0]);
        s.anchor.set(0.5);
        s.shadow = shadow;
        // Added as a pair, shadow first, so a fruit's shadow falls on the
        // fruit drawn before it rather than sitting under the whole pile.
        this.container.addChild(shadow, s);
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
      if (s.texture !== tex) {
        s.texture = tex;
        s.shadow.texture = tex;
      }

      s.x = Math.round(x);
      s.y = Math.round(y);
      s.shadow.x = s.x + SHADOW.dx;
      s.shadow.y = s.y + SHADOW.dy;

      // Sprite scale composes two independent channels so neither stomps the
      // other: the spawn pop-in owned here, and `rec.fxSquash`, the impact
      // deformation owned by the FX module.
      let sx = 1, sy = 1;

      const age = nowMs - rec.bornAt;
      if (age < POP_MS) {
        const t = age / POP_MS;
        const pop = Math.sin(t * Math.PI) * 0.18 * (1 - t);
        sx *= 1 + pop;
        sy *= 1 - pop;
      }

      const sq = rec.fxSquash;
      if (sq) {
        sx *= sq.x;
        sy *= sq.y;
      }

      s.scale.set(sx, sy);
      s.shadow.scale.set(sx, sy);
    }

    for (const [uid, s] of this.sprites) {
      if (!seen.has(uid)) {
        s.shadow.destroy();
        s.destroy();
        this.sprites.delete(uid);
      }
    }
  }

  /** Texture for a tier at rest — used by the claw and the next-up preview. */
  texture(tier, frame = 0) { return this.frames[tier][frame % ROT_FRAMES]; }

  clear() {
    for (const s of this.sprites.values()) {
      s.shadow.destroy();
      s.destroy();
    }
    this.sprites.clear();
  }
}

export { FRUITS };
