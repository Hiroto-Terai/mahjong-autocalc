import { THEME } from './hud-theme.js';

/**
 * Pixel-art frame primitives — the UI's single border language.
 *
 * There are exactly two containers in this game: a `panel`, which is raised
 * and lit from the top-left, and a `well`, which is recessed and lit from the
 * bottom-right. Every box on screen is one of the two, so the HUD, the chain
 * bar and both dialogs read as parts of one machine. Everything is drawn as
 * 1px rectangles on integer coordinates, which Pixi rasterises exactly.
 */

const px = (g, x, y, w, h, colour, alpha = 1) => {
  g.rect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)).fill({ color: colour, alpha });
};

/**
 * Raised plaque. The border itself is two-tone — light along the top and left,
 * dark along the bottom and right — so the frame agrees with the key light
 * used by the jar rim and the fruit.
 */
export function panel(g, x, y, w, h, {
  light = THEME.goldLite,
  dark = THEME.goldDark,
  body = THEME.panel,
  shadow = THEME.ink,
} = {}) {
  px(g, x + 2, y + 2, w, h, shadow, 0.5);
  px(g, x, y, w, h, dark);
  px(g, x, y, w - 1, 1, light);
  px(g, x, y, 1, h - 1, light);
  px(g, x + 1, y + 1, w - 2, h - 2, body);
  // Mitred corners: a rectangle with square corners reads as a debug box.
  for (const [cx, cy] of [[x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1]]) {
    px(g, cx, cy, 1, 1, THEME.ink);
  }
  // Inner bevel.
  px(g, x + 1, y + 1, w - 2, 1, THEME.panelLite);
  px(g, x + 1, y + 2, 1, h - 4, THEME.panelLite);
  px(g, x + 1, y + h - 2, w - 2, 1, THEME.panelDark);
  px(g, x + w - 2, y + 2, 1, h - 4, THEME.panelDark);
}

/**
 * Recessed well — the inverse light, for anything that holds data: score,
 * best, next-up. Same rim colour everywhere, no decoration.
 */
export function well(g, x, y, w, h, { body = THEME.panelDark } = {}) {
  px(g, x, y, w, h, THEME.ink);
  px(g, x + 1, y + 1, w - 2, h - 2, body);
  px(g, x + 1, y + 1, w - 2, 1, 0x0e1322);
  px(g, x + 1, y + 2, 1, h - 3, 0x0e1322);
  px(g, x + 1, y + h - 2, w - 2, 1, THEME.panelLite, 0.45);
  px(g, x + w - 2, y + 2, 1, h - 4, THEME.panelLite, 0.35);
}

/**
 * The one divider. Gold, engraved, tapered at both ends so it reads as an
 * ornament rather than a crack in the panel.
 */
export function rule(g, x, y, w) {
  px(g, x + 2, y, w - 4, 1, THEME.goldDark);
  px(g, x + 2, y + 1, w - 4, 1, THEME.ink, 0.45);
  px(g, x, y, 2, 1, THEME.goldDark, 0.45);
  px(g, x + w - 2, y, 2, 1, THEME.goldDark, 0.45);
  // Centre pip, the classic engraved-plate ornament.
  px(g, x + (w >> 1) - 1, y - 1, 3, 3, THEME.panel);
  px(g, x + (w >> 1), y - 1, 1, 3, THEME.gold);
  px(g, x + (w >> 1) - 1, y, 3, 1, THEME.gold);
}

/** Primary call to action: dark plate, gold border, lit from the top-left. */
export function button(g, x, y, w, h) {
  px(g, x + 1, y + 1, w, h, THEME.ink, 0.55);
  px(g, x, y, w, h, THEME.goldDark);
  px(g, x, y, w - 1, 1, THEME.gold);
  px(g, x, y, 1, h - 1, THEME.gold);
  px(g, x + 1, y + 1, w - 2, h - 2, 0x1b2138);
  for (const [cx, cy] of [[x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1]]) {
    px(g, cx, cy, 1, 1, THEME.ink);
  }
}

/** Dashed vertical run, optionally fading toward the far end. */
export function dashV(g, x, y0, y1, { on = 3, off = 4, colour = THEME.gold, alpha = 0.9, fade = 0 } = {}) {
  for (let y = y0; y < y1; y += on + off) {
    const t = (y - y0) / Math.max(1, y1 - y0);
    const a = alpha * (1 - fade * t);
    if (a <= 0.02) break;
    px(g, x, y, 1, Math.min(on, y1 - y), colour, a);
  }
}

/** Small filled triangle pointing down — the drop marker. */
export function markerDown(g, cx, y, size, colour, alpha = 1) {
  for (let i = 0; i < size; i++) px(g, cx - (size - 1 - i), y + i, (size - i) * 2 - 1, 1, colour, alpha);
}

export { px };
