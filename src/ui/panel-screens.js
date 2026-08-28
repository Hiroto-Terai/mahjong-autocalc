import { Container, Graphics, Sprite } from 'pixi.js';
import { VIRTUAL_W, VIRTUAL_H } from '../config.js';
import { THEME, RAMP_VALUE, RAMP_TITLE } from './hud-theme.js';
import { panel, button, rule, px } from './panel-frame.js';
import { BitmapText, SMALL, DISPLAY, measure } from './font.js';
import { chainDiameter, ICON_PAD } from './hud-icons.js';

const CX = VIRTUAL_W >> 1;
/** Prompt blink; the lit phase is longer, so a still frame is nearly always on. */
const BLINK = 900;
/** Tiers shown in the title screen's teaser ladder. */
const TEASER = [0, 2, 5, 8, 10];

/**
 * The two full-screen states: attract and score screen.
 *
 * Both use the same dialog language — a gold two-tone plaque, gold engraved
 * dividers, dim labels, gold values — so they read as two pages of one book.
 * The board behind them is dimmed on `boardDim`, which sits under the HUD, so
 * the dim never touches the score deck or the chain bar.
 */
export class Screens {
  constructor(ctx, icons) {
    this.icons = icons;
    this.dim = new Graphics();
    ctx.layers.boardDim.addChild(this.dim);

    this.root = new Container();
    ctx.layers.overlay.addChild(this.root);
    this.gfx = new Graphics();
    this.text = new Container();
    this.root.addChild(this.gfx, this.text);

    this.t = 0;
    this.mode = null;
    this.newRecord = false;

    // Logo: each word is a face over two extruded shadow copies, which is what
    // turns display lettering into a logotype rather than big text.
    this.logo = [];
    for (const word of ['FRUIT', 'CASCADE']) {
      const layers = [];
      for (let i = 2; i >= 0; i--) {
        const t = new BitmapText({
          text: word, face: DISPLAY, align: 'center',
          ...(i === 0 ? { ramp: RAMP_TITLE, outline: THEME.ink } : { colour: i === 1 ? 0x7a4a12 : 0x3d2308 }),
        });
        t.scale.set(2);
        layers.push(t);
      }
      this.logo.push(layers);
      this.text.addChild(...layers);
    }

    this.teaser = TEASER.map(() => new Sprite());
    this.text.addChild(...this.teaser);

    this.headline = new BitmapText({ face: DISPLAY, ramp: RAMP_TITLE, outline: THEME.ink, align: 'center' });
    this.scoreLabel = new BitmapText({ face: SMALL, colour: THEME.dim, shadow: THEME.ink, align: 'center' });
    this.score = new BitmapText({ face: DISPLAY, ramp: RAMP_VALUE, outline: THEME.ink, align: 'center', mono: true });
    // The score screen's number is the whole point of the screen: twice the
    // size of the deck's, which is hierarchy the HUD itself cannot spend.
    this.score.scale.set(2);
    this.bestLabel = new BitmapText({ text: 'BEST', face: SMALL, colour: THEME.dim, shadow: THEME.ink });
    this.best = new BitmapText({ face: SMALL, ramp: RAMP_VALUE, outline: THEME.ink, mono: true });
    this.badge = new BitmapText({ text: 'NEW RECORD', face: SMALL, colour: 0x40270a, align: 'center' });
    this.caption = new BitmapText({ face: SMALL, colour: THEME.dim, shadow: THEME.ink, align: 'center' });
    this.prompt = new BitmapText({ face: SMALL, colour: THEME.cream, shadow: THEME.ink, align: 'center' });
    this.hint = new BitmapText({ face: SMALL, colour: THEME.dimmer, align: 'center' });
    this.text.addChild(
      this.headline, this.scoreLabel, this.score, this.bestLabel, this.best,
      this.badge, this.caption, this.prompt, this.hint,
    );
  }

  _hideAll() {
    for (const c of this.text.children) c.visible = false;
  }

  _word(i, y) {
    const [back, midShade, face] = this.logo[i];
    // Extrusion falls down-right, the same key light the panels and the fruit
    // are lit by; a straight-down shadow reads as a print misregistration.
    for (const [t, d] of [[back, 4], [midShade, 2], [face, 0]]) {
      t.x = CX - 2 + d; t.y = y + d; t.visible = true;
    }
    return face;
  }

  _buildTitle() {
    const g = this.gfx;
    const x = 30, y = 138, w = 260, h = 104;
    panel(g, x, y, w, h);
    // Engraved inner keyline: the plaque reads as cast metal, not a rectangle.
    px(g, x + 3, y + 3, w - 6, 1, THEME.goldDark, 0.8);
    px(g, x + 3, y + h - 4, w - 6, 1, THEME.goldDark, 0.8);
    px(g, x + 3, y + 4, 1, h - 8, THEME.goldDark, 0.8);
    px(g, x + w - 4, y + 4, 1, h - 8, THEME.goldDark, 0.8);

    this._word(0, 150);
    this._word(1, 174);
    rule(g, x + 26, 203, w - 52);

    // Teaser ladder: five rungs of the real chain, standing on one baseline.
    const baseline = 229;
    // A shade larger than the chain bar's: on the attract screen these are
    // hero art, not a progress meter.
    const ds = TEASER.map((t) => chainDiameter(t) + 3);
    const total = ds.reduce((a, b) => a + b, 0) + 7 * (TEASER.length - 1);
    let ix = Math.round(CX - total / 2);
    TEASER.forEach((tier, i) => {
      const s = this.teaser[i];
      s.texture = this.icons.texture(tier, ds[i]);
      s.x = ix - ICON_PAD;
      s.y = baseline + 1 - ds[i] - ICON_PAD;
      s.visible = true;
      if (i < TEASER.length - 1) {
        const cx = ix + ds[i] + 2;
        for (const [dx, dy] of [[0, 0], [1, 1], [2, 2], [1, 3], [0, 4]]) {
          px(g, cx + dx, baseline - 8 + dy, 1, 1, THEME.gold, 0.8);
        }
      }
      ix += ds[i] + 7;
    });

    this.caption.text = 'MERGE TWO TO GROW ONE';
    this.caption.x = CX; this.caption.y = 250;
    this.caption.visible = true;

    const bw = measure('PRESS SPACE TO START', SMALL) + 30;
    button(g, CX - (bw >> 1), 266, bw, 20);
    this.prompt.text = 'PRESS SPACE TO START';
    this.prompt.x = CX; this.prompt.y = 273;
    this.prompt.visible = true;

    this.hint.text = 'ARROWS OR DRAG TO AIM';
    this.hint.x = CX; this.hint.y = 296;
    this.hint.visible = true;
  }

  _buildOver(game) {
    const g = this.gfx;
    const x = 52, y = 172, w = 216, h = 122;
    panel(g, x, y, w, h);

    this.headline.text = 'GAME OVER';
    this.headline.x = CX; this.headline.y = y + 12;
    rule(g, x + 20, y + 30, w - 40);
    this.scoreLabel.text = 'FINAL SCORE';
    this.scoreLabel.x = CX; this.scoreLabel.y = y + 40;
    this.score.text = String(game.score);
    this.score.x = CX; this.score.y = y + 50;

    // BEST is a label/value pair on one line, centred as a group so the two
    // roles keep their own colours without breaking the centre axis.
    const gap = 5;
    const bw = measure('BEST', SMALL) + gap + measure(String(game.best), SMALL, true);
    this.bestLabel.x = CX - Math.round(bw / 2); this.bestLabel.y = y + 79;
    this.best.text = String(game.best);
    this.best.x = this.bestLabel.x + measure('BEST', SMALL) + gap; this.best.y = y + 79;

    rule(g, x + 20, y + 94, w - 40);
    this.prompt.text = 'PRESS SPACE TO PLAY AGAIN';
    this.prompt.x = CX; this.prompt.y = y + 102;

    this.headline.visible = this.scoreLabel.visible = this.score.visible = true;
    this.bestLabel.visible = this.best.visible = this.prompt.visible = true;

    if (this.newRecord) this._badge(g, y);
  }

  /** Gold tab straddling the panel's top edge. Built from the centre out so
   *  the two ends are mirror-identical by construction. */
  _badge(g, panelY) {
    const half = Math.round((measure('NEW RECORD', SMALL) + 22) / 2);
    const top = panelY - 9;
    const h = 16;
    for (let i = -half; i < half; i++) {
      // Chamfer the outermost column top and bottom so the tab has shoulders.
      const inset = Math.abs(i) >= half - 1 ? 1 : 0;
      px(g, CX + i, top + inset, 1, h - inset * 2, THEME.ink);
    }
    for (let i = -half + 1; i < half - 1; i++) {
      const inset = Math.abs(i) >= half - 2 ? 1 : 0;
      px(g, CX + i, top + 1 + inset, 1, h - 2 - inset * 2, THEME.goldDark);
    }
    for (let i = -half + 2; i < half - 2; i++) {
      px(g, CX + i, top + 2, 1, h - 4, THEME.gold);
      px(g, CX + i, top + 2, 1, 1, THEME.goldLite);
    }
    this.badge.x = CX; this.badge.y = top + 5;
    this.badge.visible = true;
  }

  update(dtMs, game) {
    this.t += dtMs;
    const mode = game.state === 'title' ? 'title' : game.state === 'over' ? 'over' : null;
    const key = `${mode}:${game.score}:${game.best}:${this.newRecord ? 1 : 0}`;

    if (key !== this.mode) {
      this.mode = key;
      this.gfx.clear();
      this.dim.clear();
      this._hideAll();
      if (mode === 'title' || mode === 'over') {
        // Flat tint, not a dither screen: the pile behind is the player's work
        // and it has to keep its hue.
        px(this.dim, 0, 0, VIRTUAL_W, VIRTUAL_H, 0x0b1024, mode === 'title' ? 0.52 : 0.46);
      }
      if (mode === 'title') this._buildTitle();
      else if (mode === 'over') this._buildOver(game);
    }

    this.root.visible = mode !== null;
    if (!this.root.visible) return;
    // Quantised blink: the prompt is a light, not a dimmer.
    this.prompt.alpha = this.t % BLINK < BLINK * 0.66 ? 1 : 0.4;
  }
}
