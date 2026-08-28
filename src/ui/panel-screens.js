import { Container, Graphics } from 'pixi.js';
import { VIRTUAL_W, VIRTUAL_H } from '../config.js';
import { THEME, RAMP_SCORE, RAMP_TITLE, RAMP_DANGER } from './hud-theme.js';
import { panel, inset, rule, px } from './panel-frame.js';
import { BitmapText, SMALL, DISPLAY, measure } from './font.js';

const CX = VIRTUAL_W >> 1;
/** Prompt blink period; the lit half is longer so the first frame is always on. */
const BLINK = 900;

/**
 * The two full-screen states: attract and score screen.
 *
 * Both are built as framed plaques rather than centred text, and both dim the
 * board behind them with a flat scrim so the panel is unambiguously in front
 * instead of tangled up with the fruit.
 */
export class Screens {
  constructor(ctx) {
    this.root = new Container();
    ctx.layers.overlay.addChild(this.root);
    this.gfx = new Graphics();
    this.text = new Container();
    this.root.addChild(this.gfx, this.text);

    this.t = 0;
    this.mode = null;
    this.newRecord = false;

    this.title = new BitmapText({ face: DISPLAY, ramp: RAMP_TITLE, outline: THEME.ink, align: 'center' });
    this.title2 = new BitmapText({ face: DISPLAY, ramp: RAMP_TITLE, outline: THEME.ink, align: 'center' });
    this.title.scale.set(2); this.title2.scale.set(2);
    this.headline = new BitmapText({ face: DISPLAY, ramp: RAMP_DANGER, outline: THEME.ink, align: 'center' });
    this.sub = new BitmapText({ face: SMALL, colour: THEME.dim, align: 'center' });
    this.scoreLabel = new BitmapText({ face: SMALL, colour: THEME.dim, align: 'center' });
    this.score = new BitmapText({ face: DISPLAY, ramp: RAMP_SCORE, outline: THEME.ink, align: 'center' });
    this.best = new BitmapText({ face: SMALL, colour: THEME.text, shadow: THEME.ink, align: 'center' });
    this.ribbon = new BitmapText({ face: SMALL, colour: 0x3a2408, align: 'center' });
    this.prompt = new BitmapText({ face: SMALL, colour: THEME.cream, shadow: THEME.ink, align: 'center' });
    this.hint = new BitmapText({ face: SMALL, colour: THEME.dimmer, align: 'center' });
    this.text.addChild(
      this.title, this.title2, this.headline, this.sub, this.scoreLabel,
      this.score, this.best, this.ribbon, this.prompt, this.hint,
    );
  }

  _hideAll() {
    for (const c of this.text.children) c.visible = false;
  }

  _scrim(alpha) {
    px(this.gfx, 0, 0, VIRTUAL_W, VIRTUAL_H, 0x080b14, alpha);
  }

  _buildTitle() {
    const g = this.gfx;
    this._scrim(0.62);
    const x = 34, y = 146, w = 252, h = 94;
    panel(g, x, y, w, h, { border: THEME.gold, body: THEME.panel });
    // Inner keyline: a second, darker rectangle inside the gold makes the
    // plaque read as engraved metal rather than a coloured box.
    px(g, x + 3, y + 3, w - 6, 1, THEME.goldDark, 0.7);
    px(g, x + 3, y + h - 4, w - 6, 1, THEME.goldDark, 0.7);
    px(g, x + 3, y + 4, 1, h - 8, THEME.goldDark, 0.7);
    px(g, x + w - 4, y + 4, 1, h - 8, THEME.goldDark, 0.7);
    rule(g, x + 20, y + 68, w - 40, THEME.goldDark, THEME.panelLite, 0.35);

    this.title.text = 'FRUIT';
    this.title.x = CX; this.title.y = 160;
    this.title2.text = 'CASCADE';
    this.title2.x = CX; this.title2.y = 184;
    this.sub.text = 'MERGE TWO TO GROW ONE';
    this.sub.x = CX; this.sub.y = 222;
    this.title.visible = this.title2.visible = this.sub.visible = true;

    const pw = measure('PRESS SPACE TO START', SMALL) + 22;
    inset(g, CX - (pw >> 1), 254, pw, 17, { body: THEME.panelDark });
    this.prompt.text = 'PRESS SPACE TO START';
    this.prompt.x = CX; this.prompt.y = 259;
    this.prompt.visible = true;

    this.hint.text = 'ARROWS OR DRAG TO AIM';
    this.hint.x = CX; this.hint.y = 280;
    this.hint.visible = true;
  }

  _buildOver(game) {
    const g = this.gfx;
    this._scrim(0.55);
    const x = 52, y = 148, w = 216, h = 92;
    panel(g, x, y, w, h, { border: THEME.edge, body: THEME.panel });
    rule(g, x + 14, y + 26, w - 28, THEME.ink, THEME.panelLite, 0.3);

    this.headline.text = 'GAME OVER';
    this.headline.x = CX; this.headline.y = 158;
    this.scoreLabel.text = 'FINAL SCORE';
    this.scoreLabel.x = CX; this.scoreLabel.y = 180;
    this.score.text = String(game.score);
    this.score.x = CX; this.score.y = 190;
    this.best.text = `BEST ${game.best}`;
    this.best.x = CX; this.best.y = 208;
    this.headline.visible = this.scoreLabel.visible = true;
    this.score.visible = this.best.visible = true;

    if (this.newRecord) {
      // The ribbon deliberately breaks the panel's top edge — an element that
      // overlaps its own frame is the cheapest way to sell depth.
      const rw = measure('NEW RECORD', SMALL) + 20;
      const rx = CX - (rw >> 1);
      px(g, rx - 1, 135, rw + 2, 17, THEME.ink);
      px(g, rx, 136, rw, 15, THEME.goldDark);
      px(g, rx + 1, 137, rw - 2, 13, THEME.gold);
      px(g, rx + 1, 137, rw - 2, 1, THEME.goldLite);
      // Swallowtail notches at both ends.
      for (const s of [0, 1]) {
        const ex = s ? rx + rw - 3 : rx;
        px(g, ex, 141, 3, 5, THEME.ink, 0.55);
      }
      this.ribbon.text = 'NEW RECORD';
      this.ribbon.x = CX; this.ribbon.y = 140;
      this.ribbon.visible = true;
    }

    this.prompt.text = 'PRESS SPACE TO PLAY AGAIN';
    this.prompt.x = CX; this.prompt.y = 224;
    this.prompt.visible = true;
  }

  update(dtMs, game) {
    this.t += dtMs;
    const mode = game.state === 'title' ? 'title' : game.state === 'over' ? 'over' : null;
    const key = `${mode}:${game.score}:${game.best}:${this.newRecord ? 1 : 0}`;

    if (key !== this.mode) {
      this.mode = key;
      this.gfx.clear();
      this._hideAll();
      if (mode === 'title') this._buildTitle();
      else if (mode === 'over') this._buildOver(game);
    }

    this.root.visible = mode !== null;
    if (!this.root.visible) return;
    // Quantised blink, not a fade: the prompt is a light, not a dimmer.
    this.prompt.alpha = this.t % BLINK < BLINK * 0.66 ? 1 : 0.35;
  }
}
