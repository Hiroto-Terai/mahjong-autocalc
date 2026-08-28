import { Container, Graphics, TilingSprite } from 'pixi.js';
import { VIRTUAL_W, VIRTUAL_H } from '../config.js';
import { quantAlpha, ditherTextures, DITHER_LEVELS } from './draw.js';

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const outQuad = (t) => 1 - (1 - t) ** 2;

/** Alarm red. The only fully saturated colour the game ever puts on screen. */
const ALARM = 0xff3b52;
/** The cold wash that drains the board as the grace timer runs down. */
const DRAIN = 0x2a3050;

/**
 * Everything that happens to the whole screen rather than to a point on it:
 * the danger alarm, the game-over curtain, and full-viewport blowouts.
 *
 * All three are drawn as tiled ordered-dither masks rather than translucent
 * sheets. A 40%-alpha white rectangle over pixel art reads as fog; a Bayer
 * mask at 40% coverage reads as light, because every texel it touches is still
 * a fully-opaque colour from the palette — which is how a palette-limited
 * machine had to do it, and why it still looks right.
 */
export class ScreenFx {
  constructor(parent) {
    this.layer = new Container();
    parent.addChild(this.layer);

    const veils = ditherTextures();
    this.drain = new TilingSprite({ texture: veils[0], width: VIRTUAL_W, height: VIRTUAL_H });
    this.curtain = new TilingSprite({ texture: veils[0], width: VIRTUAL_W, height: VIRTUAL_H });
    this.blowout = new TilingSprite({ texture: veils[0], width: VIRTUAL_W, height: VIRTUAL_H });
    this.gfx = new Graphics();
    // Drain, then curtain, then blowout: the three can overlap during a run
    // that ends on a big merge, and this is the order they resolve in.
    this.layer.addChild(this.drain, this.curtain, this.blowout, this.gfx);

    this.reset();
  }

  reset() {
    this.ratio = 0;
    this.target = 0;
    this.phase = 0;
    this.overAge = -1;
    this.flash = null;
    this.drain.visible = false;
    this.curtain.visible = false;
    this.blowout.visible = false;
    this.gfx.clear();
  }

  /** Rising 0..1 as the overflow grace timer runs out. */
  danger(ratio) { this.target = ratio; }

  gameOver() {
    this.overAge = 0;
    this.target = 0;
  }

  /**
   * A whole-screen hit of light. `level` caps how much of the dither ramp it
   * is allowed to reach — a watermelon whites the board out at the full eight,
   * a big merge lifts it by one.
   */
  blast(colour, life, level) {
    this.flash = { colour, life, level, age: 0 };
  }

  update(dt) {
    const g = this.gfx;
    g.clear();
    this._danger(dt, g);
    this._curtain(dt, g);
    this._blowout(dt);
  }

  _danger(dt, g) {
    // Eased toward the reported ratio so a fruit rocking across the line does
    // not strobe the whole screen on and off.
    this.ratio += (this.target - this.ratio) * clamp(dt / 90, 0, 1);
    if (this.target === 0 && this.ratio < 0.01) this.ratio = 0;

    const d = this.ratio;
    if (d <= 0.02 || this.overAge >= 0) {
      if (this.drain.visible) this.drain.visible = false;
      return;
    }

    this.phase += dt * (0.0016 + d * 0.0056);
    const pulse = 0.5 + 0.5 * Math.sin(this.phase * TAU);
    const lit = quantAlpha(0.25 + d * 0.75 * (0.45 + pulse * 0.55));
    const thick = 1 + Math.round(d * 3 + pulse * 2);

    g.rect(0, 0, VIRTUAL_W, thick).fill({ color: ALARM, alpha: lit });
    g.rect(0, VIRTUAL_H - thick, VIRTUAL_W, thick).fill({ color: ALARM, alpha: lit });
    g.rect(0, 0, thick, VIRTUAL_H).fill({ color: ALARM, alpha: lit });
    g.rect(VIRTUAL_W - thick, 0, thick, VIRTUAL_H).fill({ color: ALARM, alpha: lit });

    // Corner brackets that lengthen with the threat. A frame that only gets
    // brighter is easy to stop noticing; one that grows teeth is not.
    const tooth = 6 + Math.round(d * 14);
    for (const [cx, cy] of [[0, 0], [VIRTUAL_W, 0], [0, VIRTUAL_H], [VIRTUAL_W, VIRTUAL_H]]) {
      const right = cx > 0;
      const bottom = cy > 0;
      g.rect(right ? cx - tooth : cx, bottom ? cy - 3 : cy, tooth, 3).fill({ color: ALARM, alpha: lit });
      g.rect(right ? cx - 3 : cx, bottom ? cy - tooth : cy, 3, tooth).fill({ color: ALARM, alpha: lit });
    }

    const level = Math.round(d * 2);
    this.drain.visible = level > 0;
    if (level > 0) {
      this.drain.texture = ditherTextures()[clamp(level, 1, DITHER_LEVELS) - 1];
      this.drain.tint = DRAIN;
    }
  }

  _curtain(dt, g) {
    if (this.overAge < 0) {
      if (this.curtain.visible) this.curtain.visible = false;
      return;
    }
    this.overAge += dt;
    // Held for a beat, then wiped down in whole 8px rows. An instant cut to
    // black throws away the one moment the player wants to sit with.
    const t = clamp((this.overAge - 180) / 620, 0, 1);
    const h = Math.round((outQuad(t) * VIRTUAL_H) / 8) * 8;
    if (h <= 0) return;

    this.curtain.visible = true;
    this.curtain.texture = ditherTextures()[clamp(Math.round(2 + t * 4), 1, DITHER_LEVELS) - 1];
    this.curtain.height = h;
    this.curtain.tint = 0x0a0713;
    // A lit leading edge makes the wipe a moving object rather than a
    // rectangle that happens to be getting taller.
    if (h < VIRTUAL_H) {
      g.rect(0, h - 2, VIRTUAL_W, 1).fill({ color: 0x59204a, alpha: 0.8 });
      g.rect(0, h - 1, VIRTUAL_W, 1).fill({ color: 0xb8446a, alpha: 1 });
    }
  }

  _blowout(dt) {
    const f = this.flash;
    if (!f) {
      if (this.blowout.visible) this.blowout.visible = false;
      return;
    }
    f.age += dt;
    const t = f.age / f.life;
    if (t >= 1) {
      this.flash = null;
      this.blowout.visible = false;
      return;
    }
    // Squared falloff, or the blowout spends most of its life as a visible
    // screen door instead of as a flash.
    this.blowout.visible = true;
    this.blowout.texture = ditherTextures()[clamp(Math.ceil((1 - t) ** 2 * f.level), 1, DITHER_LEVELS) - 1];
    this.blowout.tint = f.colour;
  }
}
