import { Container, Graphics, Sprite } from 'pixi.js';
import { VIRTUAL_W, VIRTUAL_H, FRUITS } from '../config.js';
import { THEME } from './hud-theme.js';
import { px } from './panel-frame.js';
import { BitmapText, SMALL } from './font.js';
import { chainDiameter } from './hud-icons.js';

/** Deck under the jar. Everything below the floor chrome belongs to it. */
const DECK_Y = 455;
/** Icons stand on this row; they grow upward from it. */
const BASELINE = 476;
const GAP = 8;

/** How long a newly discovered tier stays lit up, in ms of game time. */
const FLASH_MS = 1100;

/**
 * The evolution ladder along the bottom deck.
 *
 * Undiscovered tiers are flat silhouettes: the chain is a collection meter as
 * much as a reference chart, and revealing one is the reward the genre runs
 * on, so a reveal gets its own flash rather than silently swapping textures.
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
      // The icon buffer carries a 1px outline margin; offset by it so the disc
      // itself lands exactly on the baseline.
      s.x = x - 1;
      s.y = BASELINE - d;
      this.root.addChild(s);
      this.slots.push({ tier, d, x, sprite: s, lit: false, flashAt: -1e9 });
      x += d + GAP;
    }
    this.spanLeft = this.slots[0].x;
    this.spanRight = x - GAP;

    this.label = new BitmapText({ text: 'CHAIN', face: SMALL, colour: THEME.dim, shadow: THEME.ink });
    this.label.x = 9; this.label.y = 465;
    this.count = new BitmapText({ align: 'right', face: SMALL, colour: THEME.text, shadow: THEME.ink });
    this.count.x = VIRTUAL_W - 9; this.count.y = 465;
    this.root.addChild(this.label, this.count);

    this._drawDeck();
  }

  _drawDeck() {
    const g = this.deck;
    const h = VIRTUAL_H - DECK_Y;
    px(g, 0, DECK_Y, VIRTUAL_W, 1, THEME.ink);
    px(g, 0, DECK_Y + 1, VIRTUAL_W, 1, THEME.panelLite, 0.55);
    px(g, 0, DECK_Y + 2, VIRTUAL_W, h - 2, THEME.panelDark);
    // Shelf the icons stand on.
    px(g, this.spanLeft - 3, BASELINE + 1, this.spanRight - this.spanLeft + 6, 1, THEME.dimmer);
    px(g, this.spanLeft - 3, BASELINE + 2, this.spanRight - this.spanLeft + 6, 1, THEME.ink, 0.6);
  }

  flash(tier, at) {
    const slot = this.slots[tier];
    if (slot) slot.flashAt = at;
  }

  reset() {
    for (const s of this.slots) s.flashAt = -1e9;
  }

  update(game) {
    const g = this.deck;
    let known = 0;

    for (const slot of this.slots) {
      const lit = game.discovered.has(slot.tier);
      if (lit) known++;
      if (lit !== slot.lit) {
        slot.lit = lit;
        slot.sprite.texture = this.icons.texture(slot.tier, slot.d, !lit);
      }
      const age = game.time - slot.flashAt;
      if (age >= 0 && age < FLASH_MS) {
        // Two hard blinks, then a lift that settles — no smooth fade, which at
        // this size just reads as a texture bug.
        const blink = age < 360 && Math.floor(age / 60) % 2 === 0;
        slot.sprite.tint = blink ? 0xffffff : 0xffffff;
        slot.sprite.alpha = blink ? 1 : 0.85;
        slot.sprite.y = BASELINE - slot.d - (age < 360 ? 2 : 1);
      } else {
        slot.sprite.alpha = lit ? 1 : 0.9;
        slot.sprite.y = BASELINE - slot.d;
      }
    }

    // Chevrons live in the gutters and only light where the ladder is known.
    g.clear();
    this._drawDeck();
    for (let i = 0; i < this.slots.length - 1; i++) {
      const a = this.slots[i], b = this.slots[i + 1];
      const on = a.lit && b.lit;
      const cx = a.x + a.d + Math.floor((GAP - 3) / 2);
      const cy = BASELINE - 5;
      const colour = on ? THEME.gold : THEME.dimmer;
      const alpha = on ? 0.85 : 0.7;
      px(g, cx, cy, 1, 1, colour, alpha);
      px(g, cx + 1, cy + 1, 1, 1, colour, alpha);
      px(g, cx + 2, cy + 2, 1, 1, colour, alpha);
      px(g, cx + 1, cy + 3, 1, 1, colour, alpha);
      px(g, cx, cy + 4, 1, 1, colour, alpha);
    }

    this.count.text = `${known}/${FRUITS.length}`;
    this.count.tint = known === FRUITS.length ? THEME.gold : 0xffffff;
  }
}
