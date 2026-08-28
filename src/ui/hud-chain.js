import { Container, Graphics, Sprite } from 'pixi.js';
import { VIRTUAL_W, VIRTUAL_H, FRUITS } from '../config.js';
import { THEME, RAMP_VALUE_SMALL } from './hud-theme.js';
import { px } from './panel-frame.js';
import { BitmapText, SMALL } from './font.js';
import { chainDiameter, ICON_PAD } from './hud-icons.js';

/** Deck under the jar. Everything below the floor chrome belongs to it. */
const DECK_Y = 455;
/** Icons stand on this row and grow upward from it. */
const BASELINE = 476;
const GAP = 6;
/** How long a newly discovered tier stays lit, in ms of game time. */
const FLASH_MS = 1200;

/**
 * The evolution ladder along the bottom deck.
 *
 * Two things make it a chain rather than a row of stickers: the icons grow one
 * texel per tier, so the ladder is visible at a glance, and unearned tiers are
 * struck blanks rather than absent, so the row always shows how far there is
 * left to go. Discovering a tier lights it inside a gold bracket.
 */
export class EvolutionChain {
  constructor(ctx, icons) {
    this.icons = icons;
    this.root = new Container();
    ctx.layers.ui.addChild(this.root);

    this.deck = new Graphics();
    this.root.addChild(this.deck);

    this.slots = [];
    const total = FRUITS.reduce((a, f) => a + chainDiameter(f.id), 0) + GAP * (FRUITS.length - 1);
    let x = Math.round((VIRTUAL_W - total) / 2);

    for (let tier = 0; tier < FRUITS.length; tier++) {
      const d = chainDiameter(tier);
      const s = new Sprite(icons.texture(tier, d, true));
      // Sprites are placed by the disc, not the buffer: the 2px margin that
      // carries stems and outlines must not shift the icon off its baseline.
      s.x = x - ICON_PAD;
      s.y = BASELINE + 1 - d - ICON_PAD;
      this.root.addChild(s);
      this.slots.push({ tier, d, x, sprite: s, lit: false, flashAt: -1e9 });
      x += d + GAP;
    }
    this.left = this.slots[0].x;
    this.right = x - GAP;

    this.label = new BitmapText({ text: 'CHAIN', face: SMALL, colour: THEME.dim, shadow: THEME.ink });
    this.label.x = 9; this.label.y = 466;
    this.count = new BitmapText({
      align: 'right', face: SMALL, ramp: RAMP_VALUE_SMALL, outline: THEME.ink, mono: true,
    });
    this.count.x = VIRTUAL_W - 9; this.count.y = 466;
    this.root.addChild(this.label, this.count);
  }

  _drawDeck(game) {
    const g = this.deck;
    g.clear();
    const h = VIRTUAL_H - DECK_Y;
    px(g, 0, DECK_Y, VIRTUAL_W, 1, THEME.ink);
    px(g, 0, DECK_Y + 1, VIRTUAL_W, 1, THEME.gold, 0.28);
    px(g, 0, DECK_Y + 2, VIRTUAL_W, 1, THEME.panelLite, 0.4);
    px(g, 0, DECK_Y + 3, VIRTUAL_W, h - 3, THEME.panelDark);

    // Shelf, with turned-down end caps so the run terminates instead of
    // stopping mid-air.
    const x0 = this.left - 4, x1 = this.right + 4;
    px(g, x0, BASELINE + 1, x1 - x0, 1, THEME.dimmer);
    px(g, x0, BASELINE + 2, x1 - x0, 1, THEME.ink, 0.6);
    for (const cap of [x0, x1 - 1]) {
      px(g, cap, BASELINE + 1, 1, 2, THEME.dimmer);
      px(g, cap, BASELINE + 3, 1, 1, THEME.ink, 0.6);
    }

    for (let i = 0; i < this.slots.length - 1; i++) {
      const a = this.slots[i], b = this.slots[i + 1];
      const on = a.lit && b.lit;
      const cx = a.x + a.d + 1;
      const cy = BASELINE - 5;
      const colour = on ? THEME.gold : THEME.dimmer;
      const alpha = on ? 0.9 : 0.65;
      for (const [dx, dy] of [[0, 0], [1, 1], [2, 2], [1, 3], [0, 4]]) px(g, cx + dx, cy + dy, 1, 1, colour, alpha);
    }

    // Reveal bracket: corner ticks around the tier that just appeared.
    for (const slot of this.slots) {
      const age = game.time - slot.flashAt;
      if (age < 0 || age >= FLASH_MS || Math.floor(age / 90) % 2) continue;
      const bx = slot.x - 3, by = BASELINE - slot.d - 2, bw = slot.d + 6, bh = slot.d + 5;
      for (const [ox, oy, w, hh] of [
        [0, 0, 3, 1], [0, 0, 1, 3], [bw - 3, 0, 3, 1], [bw - 1, 0, 1, 3],
        [0, bh - 1, 3, 1], [0, bh - 3, 1, 3], [bw - 3, bh - 1, 3, 1], [bw - 1, bh - 3, 1, 3],
      ]) px(g, bx + ox, by + oy, w, hh, THEME.goldLite);
    }
  }

  flash(tier, at) {
    const slot = this.slots[tier];
    if (slot) slot.flashAt = at;
  }

  reset() {
    for (const s of this.slots) s.flashAt = -1e9;
  }

  update(game) {
    let known = 0;
    for (const slot of this.slots) {
      const lit = game.discovered.has(slot.tier);
      if (lit) known++;
      if (lit !== slot.lit) {
        slot.lit = lit;
        slot.sprite.texture = this.icons.texture(slot.tier, slot.d, !lit);
      }
      const age = game.time - slot.flashAt;
      const rising = age >= 0 && age < 320;
      slot.sprite.y = BASELINE + 1 - slot.d - ICON_PAD - (rising ? 2 : 0);
      slot.sprite.alpha = lit ? 1 : 0.85;
    }
    this._drawDeck(game);
    this.count.text = `${known}/${FRUITS.length}`;
  }
}
