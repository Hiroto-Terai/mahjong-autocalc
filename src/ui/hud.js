import { Container, Graphics, Sprite } from 'pixi.js';
import { VIRTUAL_W } from '../config.js';
import { THEME, RAMP_VALUE, RAMP_VALUE_SMALL } from './hud-theme.js';
import { well, px } from './panel-frame.js';
import { BitmapText, SMALL, DISPLAY } from './font.js';
import { FruitIcons, previewDiameter, ICON_PAD } from './hud-icons.js';
import { EvolutionChain } from './hud-chain.js';
import { Claw } from './hud-claw.js';
import { Screens } from './panel-screens.js';

/**
 * Top deck geometry. Three wells on one baseline grid: labels top-aligned on
 * row 5, values bottom-aligned on row 22, one texel of air inside each rim.
 */
const BAR_H = 28;
const WELL_Y = 2;
const WELL_H = 24;
const LABEL_Y = 5;
const VALUE_BOTTOM = 22;
const SCORE_WELL = { x: 4, w: 116 };
const BEST_WELL = { x: 126, w: 106 };
const NEXT_WELL = { x: 238, w: 78 };
/** Column the NEXT fruit is centred on. */
const NEXT_CX = 293;
/** Leading zeros the score plate always shows, arcade-style. */
const SCORE_DIGITS = 6;

/**
 * The head-up display: score deck, next-up preview, evolution chain, dropper
 * and the two full-screen panels.
 *
 * Everything is drawn with the in-house bitmap faces and the frame primitives
 * at integer coordinates — no system font and no fractional position anywhere
 * in the UI, which is what keeps it in the same world as the sprites.
 */
export class Hud {
  constructor(ctx) {
    this.ctx = ctx;
    this.icons = new FruitIcons();

    this.root = new Container();
    ctx.layers.ui.addChild(this.root);

    this.bar = new Graphics();
    this.root.addChild(this.bar);
    this._drawBar();

    const label = (text, x) => {
      const t = new BitmapText({ text, face: SMALL, colour: THEME.dim, shadow: THEME.ink });
      t.x = x; t.y = LABEL_Y;
      return t;
    };
    // The pad is the same face and tracking as the value, so the live digits
    // land exactly on top of the zeros they replace.
    const pad = (face, x, y, digits) => {
      const t = new BitmapText({
        text: '0'.repeat(digits), face, colour: THEME.panelLite, align: 'right', mono: true,
      });
      t.x = x; t.y = y;
      return t;
    };

    const scoreRight = SCORE_WELL.x + SCORE_WELL.w - 7;
    const scoreY = VALUE_BOTTOM - (DISPLAY.h - 1);
    this.scorePad = pad(DISPLAY, scoreRight, scoreY, SCORE_DIGITS);
    this.score = new BitmapText({ face: DISPLAY, ramp: RAMP_VALUE, outline: THEME.ink, align: 'right', mono: true });
    this.score.x = scoreRight; this.score.y = scoreY;

    const bestRight = BEST_WELL.x + BEST_WELL.w - 7;
    const bestY = VALUE_BOTTOM - (SMALL.h - 1);
    this.bestPad = pad(SMALL, bestRight, bestY, SCORE_DIGITS);
    this.best = new BitmapText({ face: SMALL, ramp: RAMP_VALUE_SMALL, outline: THEME.ink, align: 'right', mono: true });
    this.best.x = bestRight; this.best.y = bestY;

    this.nextIcon = new Sprite();
    this.root.addChild(
      label('SCORE', SCORE_WELL.x + 7), this.scorePad, this.score,
      label('BEST', BEST_WELL.x + 7), this.bestPad, this.best,
      label('NEXT', NEXT_WELL.x + 7), this.nextIcon,
    );

    this.chain = new EvolutionChain(ctx, this.icons);
    this.claw = new Claw(ctx);
    this.screens = new Screens(ctx, this.icons);

    this.startBest = 0;
    this._nextKey = -1;

    const e = ctx.events;
    e.on('reset', (game) => this._onReset(game));
    e.on('start', (game) => this._onReset(game));
    e.on('merge', ({ tier, isNew }) => {
      if (isNew) this.chain.flash(tier, this.ctx.game?.time ?? 0);
    });
    e.on('gameover', ({ score }) => {
      this.screens.newRecord = score > 0 && score >= this.startBest;
    });
  }

  _onReset(game) {
    this.startBest = game.best;
    this.screens.newRecord = false;
    this.chain.reset();
  }

  _drawBar() {
    const g = this.bar;
    px(g, 0, 0, VIRTUAL_W, BAR_H - 4, THEME.panel);
    px(g, 0, 0, VIRTUAL_W, 1, THEME.panelLite);
    px(g, 0, BAR_H - 4, VIRTUAL_W, 1, THEME.panelDark);
    px(g, 0, BAR_H - 3, VIRTUAL_W, 1, THEME.ink);
    // The deck's only ornament, and the same warm hairline the chain shelf uses.
    px(g, 0, BAR_H - 2, VIRTUAL_W, 1, THEME.gold, 0.35);
    px(g, 0, BAR_H - 1, VIRTUAL_W, 1, THEME.ink, 0.35);

    for (const w of [SCORE_WELL, BEST_WELL, NEXT_WELL]) well(g, w.x, WELL_Y, w.w, WELL_H);
  }

  update(dtMs, game) {
    this.score.text = String(game.score);
    this.best.text = String(game.best);

    if (game.next !== this._nextKey) {
      this._nextKey = game.next;
      const d = previewDiameter(game.next);
      this.nextIcon.texture = this.icons.texture(game.next, d);
      // Preview icons stand on the same baseline as the values beside them,
      // so a bigger fruit grows upward instead of drifting off the grid.
      this.nextIcon.x = Math.round(NEXT_CX - (d - 1) / 2) - ICON_PAD;
      this.nextIcon.y = VALUE_BOTTOM + 1 - ICON_PAD - d;
    }

    // The attract screen owns the whole frame; a live scoreboard reading zero
    // behind it is a debug state, not a title screen.
    const playing = game.state !== 'title';
    this.root.visible = playing;
    this.chain.root.visible = playing;

    if (playing) this.chain.update(game);
    this.claw.update(game);
    this.screens.update(dtMs, game);
  }
}
