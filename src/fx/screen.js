import { Container, Graphics } from 'pixi.js';
import { VIRTUAL_W, VIRTUAL_H } from '../config.js';
import { THEME } from '../ui/hud-theme.js';
import { quantAlpha } from './draw.js';

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const outQuad = (t) => 1 - (1 - t) ** 2;

/** Alarm red, matching the HUD's danger stop. */
const ALARM = THEME.danger;
/** The cold wash that drains the board as the grace timer runs down. */
const DRAIN = 0x1a2340;
/** The game-over sweep, in the same ink the panel scrim uses. */
const CURTAIN = 0x0b1024;

/**
 * Effects that act on the whole screen rather than on a point in it.
 *
 * Two surfaces, and the split matters more than anything else in this file:
 *
 *   boardDim  everything that washes the playfield — the danger drain, the
 *             game-over sweep, blowouts. It sits *under* the HUD, so none of
 *             it can touch the score deck or the chain bar.
 *   overlay   the danger frame alone: a few texels of solid colour hugging the
 *             screen edge, which never lands on a glyph.
 *
 * The washes are flat tints at quantised alpha, not ordered-dither screens.
 * A dither mask over the entire board is the art bible's cardinal sin at
 * maximum scale, it shreds any text it covers, and — worse for the game — it
 * strips the hue out of the pile the player just spent a run building.
 */
export class ScreenFx {
  constructor(ctx) {
    this.dim = new Graphics();
    ctx.layers.boardDim.addChild(this.dim);

    this.frame = new Container();
    ctx.layers.overlay.addChild(this.frame);
    this.gfx = new Graphics();
    this.frame.addChild(this.gfx);

    this.reset();
  }

  reset() {
    this.ratio = 0;
    this.target = 0;
    this.phase = 0;
    this.overAge = -1;
    this.flash = null;
    this.dim.clear();
    this.gfx.clear();
  }

  /** Rising 0..1 as the overflow grace timer runs out. */
  danger(ratio) { this.target = ratio; }

  gameOver() {
    this.overAge = 0;
    this.target = 0;
  }

  /**
   * A whole-screen hit of light, `peak` being its opening alpha. The board
   * whites out for a watermelon and merely lifts for a big merge.
   */
  blast(colour, life, peak) {
    this.flash = { colour, life, peak, age: 0 };
  }

  update(dt) {
    this.dim.clear();
    this.gfx.clear();
    this._danger(dt);
    this._curtain(dt);
    this._blowout(dt);
  }

  _danger(dt) {
    // Eased toward the reported ratio so a fruit rocking across the line does
    // not strobe the whole screen on and off.
    this.ratio += (this.target - this.ratio) * clamp(dt / 90, 0, 1);
    if (this.target === 0 && this.ratio < 0.01) this.ratio = 0;

    const d = this.ratio;
    if (d <= 0.02 || this.overAge >= 0) return;

    this.phase += dt * (0.0016 + d * 0.0056);
    const pulse = 0.5 + 0.5 * Math.sin(this.phase * TAU);
    const lit = quantAlpha(0.25 + d * 0.75 * (0.45 + pulse * 0.55));
    const thick = 1 + Math.round(d * 3 + pulse * 2);
    const g = this.gfx;

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

    // Cold drain, kept light on purpose: the point is that the board loses its
    // warmth, not that it becomes unreadable at the moment it matters most.
    this.dim.rect(0, 0, VIRTUAL_W, VIRTUAL_H)
      .fill({ color: DRAIN, alpha: quantAlpha(d * 0.16) });
  }

  _curtain(dt) {
    if (this.overAge < 0) return;
    this.overAge += dt;
    // Held for a beat, then swept down in whole 8px rows. An instant cut to
    // the results panel throws away the one moment the player wants to sit
    // with, so this is the transition into the panel's own scrim — and it
    // relaxes to nothing once that scrim has taken over, because two stacked
    // dims would bury the pile the panel is there to show off.
    const t = clamp((this.overAge - 180) / 620, 0, 1);
    const h = Math.round((outQuad(t) * VIRTUAL_H) / 8) * 8;
    if (h <= 0) return;

    const handover = clamp((this.overAge - 900) / 500, 0, 1);
    const alpha = quantAlpha(0.34 * (1 - handover));
    if (alpha > 0) this.dim.rect(0, 0, VIRTUAL_W, h).fill({ color: CURTAIN, alpha });
    // A lit leading edge makes the sweep a moving object rather than a
    // rectangle that happens to be getting taller.
    if (h < VIRTUAL_H) {
      this.dim.rect(0, h - 2, VIRTUAL_W, 1).fill({ color: 0x59204a, alpha: 0.8 });
      this.dim.rect(0, h - 1, VIRTUAL_W, 1).fill({ color: 0xb8446a, alpha: 1 });
    }
  }

  _blowout(dt) {
    const f = this.flash;
    if (!f) return;
    f.age += dt;
    const t = f.age / f.life;
    if (t >= 1) { this.flash = null; return; }
    // Squared falloff through hard alpha steps: a flash is a handful of frames
    // at near-full opacity, not a long dissolve that parks a grey sheet on the
    // board for half a second.
    const a = quantAlpha(f.peak * (1 - t) ** 2);
    if (a > 0) this.dim.rect(0, 0, VIRTUAL_W, VIRTUAL_H).fill({ color: f.colour, alpha: a });
  }
}
