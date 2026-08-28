import { Container, Graphics, Sprite } from 'pixi.js';
import { VIRTUAL_W, BOARD } from '../config.js';
import { THEME, RAMP_SCORE } from './hud-theme.js';
import { inset, px } from './panel-frame.js';
import { BitmapText, SMALL, DISPLAY } from './font.js';
import { FruitIcons, previewDiameter } from './hud-icons.js';
import { EvolutionChain } from './hud-chain.js';
import { Claw } from './hud-claw.js';
import { Screens } from './panel-screens.js';

/** Top deck. Everything above the gantry rail belongs to it. */
const BAR_H = 28;
const SCORE_PLATE = { x: 4, y: 2, w: 148, h: 24 };
const BEST_PILL = { x: 158, y: 6, w: 94, h: 16 };
const NEXT_WELL = { x: 285, y: 2, w: 30, h: 24 };

/**
 * The head-up display: score deck, next-up preview, evolution chain, dropper
 * and the two full-screen panels.
 *
 * Everything is drawn with the in-house bitmap faces and 1px frame primitives
 * at integer coordinates — there is no system font and no fractional position
 * anywhere in the UI, which is what keeps it in the same world as the sprites.
 */
export class Hud {
  constructor(ctx) {
    this.ctx = ctx;
    this.icons = new FruitIcons(ctx.renderer);

    this.root = new Container();
    ctx.layers.ui.addChild(this.root);

    this.bar = new Graphics();
    this.root.addChild(this.bar);
    this._drawBar();

    this.scoreLabel = new BitmapText({ text: 'SCORE', face: SMALL, colour: THEME.dim, shadow: THEME.ink });
    this.scoreLabel.x = SCORE_PLATE.x + 7; this.scoreLabel.y = 4;
    this.score = new BitmapText({
      face: DISPLAY, ramp: RAMP_SCORE, outline: THEME.ink, align: 'right',
    });
    this.score.x = SCORE_PLATE.x + SCORE_PLATE.w - 6; this.score.y = 13;

    this.bestLabel = new BitmapText({ text: 'BEST', face: SMALL, colour: THEME.dim, shadow: THEME.ink });
    this.bestLabel.x = BEST_PILL.x + 6; this.bestLabel.y = 10;
    this.best = new BitmapText({ face: SMALL, colour: THEME.cream, shadow: THEME.ink, align: 'right' });
    this.best.x = BEST_PILL.x + BEST_PILL.w - 6; this.best.y = 10;

    this.nextLabel = new BitmapText({ text: 'NEXT', face: SMALL, colour: THEME.dim, shadow: THEME.ink });
    this.nextLabel.x = 257; this.nextLabel.y = 10;
    this.nextIcon = new Sprite();
    this.root.addChild(this.scoreLabel, this.score, this.bestLabel, this.best, this.nextLabel, this.nextIcon);

    this.hint = new BitmapText({
      text: 'DRAG TO AIM   SPACE TO DROP', face: SMALL, colour: THEME.dim,
      shadow: THEME.ink, align: 'center',
    });
    this.hint.x = VIRTUAL_W >> 1;
    this.hint.y = BOARD.floor - 60;
    this.root.addChild(this.hint);

    this.chain = new EvolutionChain(ctx, this.icons);
    this.claw = new Claw(ctx);
    this.screens = new Screens(ctx);

    this.dropped = false;
    this.startBest = 0;
    this._nextKey = -1;

    const e = ctx.events;
    e.on('reset', (game) => this._onReset(game));
    e.on('start', (game) => this._onReset(game));
    e.on('drop', () => { this.dropped = true; });
    e.on('merge', ({ tier, isNew }) => {
      if (isNew) this.chain.flash(tier, this.ctx.game?.time ?? 0);
    });
    e.on('gameover', ({ score }) => {
      this.screens.newRecord = score > 0 && score >= this.startBest;
    });
  }

  _onReset(game) {
    this.dropped = false;
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
    // A warm hairline is the only saturated element on the deck; it ties the
    // HUD to the gold used for score and chain progress.
    px(g, 0, BAR_H - 2, VIRTUAL_W, 1, THEME.gold, 0.35);
    px(g, 0, BAR_H - 1, VIRTUAL_W, 1, THEME.ink, 0.35);

    inset(g, SCORE_PLATE.x, SCORE_PLATE.y, SCORE_PLATE.w, SCORE_PLATE.h);
    // Accent tab on the score plate's leading edge.
    px(g, SCORE_PLATE.x + 2, SCORE_PLATE.y + 3, 2, SCORE_PLATE.h - 6, THEME.gold, 0.85);
    px(g, SCORE_PLATE.x + 2, SCORE_PLATE.y + 3, 2, 1, THEME.goldLite, 0.9);

    inset(g, BEST_PILL.x, BEST_PILL.y, BEST_PILL.w, BEST_PILL.h);
    inset(g, NEXT_WELL.x, NEXT_WELL.y, NEXT_WELL.w, NEXT_WELL.h);
    // Corner ticks on the preview well so it reads as a viewfinder.
    for (const [dx, dy] of [[1, 1], [-2, 1], [1, -2], [-2, -2]]) {
      const cx = dx > 0 ? NEXT_WELL.x + dx : NEXT_WELL.x + NEXT_WELL.w + dx;
      const cy = dy > 0 ? NEXT_WELL.y + dy : NEXT_WELL.y + NEXT_WELL.h + dy;
      px(g, cx, cy, 1, 1, THEME.gold, 0.5);
    }
  }

  update(dtMs, game) {
    this.score.text = String(game.score);
    this.best.text = String(game.best);

    if (game.next !== this._nextKey) {
      this._nextKey = game.next;
      const d = previewDiameter(game.next);
      this.nextIcon.texture = this.icons.texture(game.next, d);
      this.nextIcon.x = Math.round(NEXT_WELL.x + NEXT_WELL.w / 2 - 1 - (d - 1) / 2);
      this.nextIcon.y = Math.round(NEXT_WELL.y + NEXT_WELL.h / 2 - 1 - (d - 1) / 2);
    }

    this.hint.visible = game.state === 'playing' && !this.dropped;
    this.chain.update(game);
    this.claw.update(game);
    this.screens.update(dtMs, game);
  }
}
