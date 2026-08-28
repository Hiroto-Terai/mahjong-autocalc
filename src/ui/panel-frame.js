import { THEME } from './hud-theme.js';

/**
 * Pixel-art frame primitives.
 *
 * Everything here draws 1px rectangles at integer coordinates through Pixi's
 * Graphics, which rasterises them exactly — so a "border" is a real texel run,
 * not a stroked path that lands on a half pixel and goes soft.
 */

const px = (g, x, y, w, h, colour, alpha = 1) => {
  g.rect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)).fill({ color: colour, alpha });
};

/**
 * A raised panel: outer silhouette, border, chamfered corners, and an inner
 * bevel lit from the top-left. `w`/`h` are the full outer size.
 */
export function panel(g, x, y, w, h, {
  border = THEME.edge,
  body = THEME.panel,
  bodyDark = THEME.panelDark,
  shadow = THEME.ink,
  bevel = true,
  chamfer = true,
} = {}) {
  // Drop shadow, offset down-right by one texel.
  px(g, x + 1, y + 1, w, h, shadow, 0.55);
  px(g, x, y, w, h, border);
  px(g, x + 1, y + 1, w - 2, h - 2, body);

  if (chamfer) {
    // Knock the four corner texels back to the shadow colour: a mitred corner
    // is the cheapest way to stop a rectangle reading as a debug box.
    px(g, x, y, 1, 1, THEME.ink);
    px(g, x + w - 1, y, 1, 1, THEME.ink);
    px(g, x, y + h - 1, 1, 1, THEME.ink);
    px(g, x + w - 1, y + h - 1, 1, 1, THEME.ink);
  }

  if (bevel) {
    px(g, x + 1, y + 1, w - 2, 1, THEME.panelLite);
    px(g, x + 1, y + 2, 1, h - 4, THEME.panelLite);
    px(g, x + 1, y + h - 2, w - 2, 1, bodyDark);
    px(g, x + w - 2, y + 2, 1, h - 4, bodyDark);
  }
}

/** A recessed well — the inverse bevel, for preview boxes and score plates. */
export function inset(g, x, y, w, h, {
  body = THEME.panelDark,
  rim = THEME.ink,
  bevel = THEME.panelLite,
} = {}) {
  px(g, x, y, w, h, rim);
  px(g, x + 1, y + 1, w - 2, h - 2, body);
  px(g, x + 1, y + h - 2, w - 2, 1, bevel, 0.5);
  px(g, x + w - 2, y + 1, 1, h - 3, bevel, 0.5);
}

/** Horizontal rule with a 1px highlight under it. */
export function rule(g, x, y, w, colour = THEME.ink, under = THEME.panelLite, alpha = 0.4) {
  px(g, x, y, w, 1, colour);
  px(g, x, y + 1, w, 1, under, alpha);
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

/** Dashed horizontal run. */
export function dashH(g, x0, x1, y, { on = 2, off = 2, colour = THEME.dim, alpha = 1 } = {}) {
  for (let x = x0; x < x1; x += on + off) px(g, x, y, Math.min(on, x1 - x), 1, colour, alpha);
}

/** Small filled triangle pointing down — used as the drop marker. */
export function markerDown(g, cx, y, size, colour, alpha = 1) {
  for (let i = 0; i < size; i++) px(g, cx - (size - 1 - i), y + i, (size - i) * 2 - 1, 1, colour, alpha);
}

/** Chevron pointing right, 3x5, for the evolution chain. */
export function chevron(g, x, y, colour, alpha = 1) {
  px(g, x, y, 1, 1, colour, alpha);
  px(g, x + 1, y + 1, 1, 1, colour, alpha);
  px(g, x + 2, y + 2, 1, 1, colour, alpha);
  px(g, x + 1, y + 3, 1, 1, colour, alpha);
  px(g, x, y + 4, 1, 1, colour, alpha);
}

export { px };
