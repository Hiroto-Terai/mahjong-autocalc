import { Graphics } from 'pixi.js';
import { VIRTUAL_W, VIRTUAL_H, BOARD } from '../config.js';

/**
 * Background and jar chrome. BASELINE — owned by the scene/art pass.
 * Draws a flat backdrop, the jar interior, and the danger line.
 */
export class Scene {
  constructor(ctx) {
    this.ctx = ctx;
    const layers = ctx.layers;
    this.layers = layers;
    ctx.events.on('danger', ({ ratio }) => { this.dangerRatio = ratio; });
    this.bg = new Graphics();
    this.front = new Graphics();
    layers.background.addChild(this.bg);
    layers.jarFront.addChild(this.front);
    this.dangerRatio = 0;
    this.redraw();
  }

  redraw() {
    const g = this.bg;
    g.clear();
    g.rect(0, 0, VIRTUAL_W, VIRTUAL_H).fill(0x141a2b);
    // Jar interior
    g.rect(BOARD.left, BOARD.top, BOARD.right - BOARD.left, BOARD.floor - BOARD.top).fill(0x1c2440);
    // Jar walls
    g.rect(BOARD.left - 3, BOARD.top, 3, BOARD.floor - BOARD.top + 3).fill(0x4a5a86);
    g.rect(BOARD.right, BOARD.top, 3, BOARD.floor - BOARD.top + 3).fill(0x4a5a86);
    g.rect(BOARD.left - 3, BOARD.floor, BOARD.right - BOARD.left + 6, 3).fill(0x4a5a86);
  }

  update(dtMs, game) {
    void dtMs; void game;
    const g = this.front;
    g.clear();
    // Danger line: dashed, and it heats up as the grace timer runs down.
    const alpha = 0.35 + this.dangerRatio * 0.65;
    const colour = this.dangerRatio > 0 ? 0xff5a5a : 0xffffff;
    for (let x = BOARD.left; x < BOARD.right; x += 8) {
      g.rect(x, BOARD.dangerY, 4, 1).fill({ color: colour, alpha });
    }
  }
}
