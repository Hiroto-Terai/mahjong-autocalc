import { Graphics, Sprite } from 'pixi.js';
import { BOARD } from '../config.js';
import { mix, hex, toHex } from '../art/palette.js';
import {
  buildBackground, buildJarBack, buildJarFront,
  buildDangerGlow, buildDangerArrow, toTexture,
} from './scene-textures.js';

/**
 * The room, the jar, and the danger line.
 *
 * The static art is three baked textures — background, jar interior, jar
 * glass — so the per-frame cost is only the danger line, which is the one
 * thing here that actually animates.
 */

const DANGER_Y = BOARD.dangerY;
/**
 * Cool at rest, amber as the grace timer bites, red at the end of it. The
 * resting colour is deliberately light: this line is the single most important
 * read on the board and it sits on the darkest surface in the game, so a
 * tasteful mid-blue disappears into the interior.
 */
const COLD = hex(0xa8bcf0);
const WARM = hex(0xffb03c);
const HOT = hex(0xff4038);
/** Hazard markers: two texels of clearance above the line, inset from the glass. */
const ARROW_X = [40, 273];
const ARROW_Y = DANGER_Y - 7;
/** Dash period: 6 lit, 4 dark. */
const DASH = 6;
const GAP = 4;

const dangerColour = (r) => (r < 0.5 ? mix(COLD, WARM, r * 2) : mix(WARM, HOT, (r - 0.5) * 2));

export class Scene {
  constructor(ctx) {
    const layers = ctx.layers;
    this.dangerRatio = 0;
    this.t = 0;

    ctx.events.on('danger', ({ ratio }) => { this.dangerRatio = ratio; });
    ctx.events.on('reset', () => { this.dangerRatio = 0; });

    layers.background.addChild(sprite(buildBackground()));
    layers.jarBack.addChild(sprite(buildJarBack()));
    layers.jarFront.addChild(sprite(buildJarFront()));

    // Haze that builds above the line: baked white, driven entirely by tint
    // and alpha so escalating it costs nothing per frame.
    this.glow = sprite(buildDangerGlow());
    this.glow.x = BOARD.left;
    this.glow.y = DANGER_Y - this.glow.height;
    this.glow.alpha = 0;
    layers.jarFront.addChild(this.glow);

    // Each marker is a shadow plate under a face. Without the plate the glyph
    // dissolves into whatever fruit happens to be sitting under the glass.
    const arrowTex = toTexture(buildDangerArrow());
    this.arrowPlates = [];
    this.arrowFaces = [];
    for (const list of [this.arrowPlates, this.arrowFaces]) {
      for (const x of ARROW_X) {
        const s = new Sprite(arrowTex);
        s.x = x;
        list.push(s);
        layers.jarFront.addChild(s);
      }
    }

    this.line = new Graphics();
    layers.jarFront.addChild(this.line);
  }

  update(dtMs, game) {
    this.t += dtMs;
    // A finished run holds the line at full alarm rather than snapping it back
    // to calm the instant the grace timer stops being read.
    const r = game.state === 'over' ? 1 : this.dangerRatio;

    // Breathes slowly when idle, hammers when the run is about to end.
    const pulse = 0.5 + 0.5 * Math.sin(this.t * (0.004 + r * 0.017));
    const colour = toHex(dangerColour(r));
    const alpha = Math.min(1, 0.72 + r * 0.16 + pulse * (0.08 + r * 0.12));

    this.glow.tint = colour;
    this.glow.alpha = r * 0.5 * (0.5 + pulse * 0.5);

    const bob = Math.round(pulse * 2 * r);
    const face = Math.min(1, 0.6 + r * (0.2 + pulse * 0.2));
    for (const a of this.arrowPlates) {
      a.tint = 0x05070f;
      a.alpha = face * 0.7;
      a.y = ARROW_Y - bob + 1;
    }
    for (const a of this.arrowFaces) {
      a.tint = colour;
      a.alpha = face;
      a.y = ARROW_Y - bob;
    }

    const g = this.line;
    g.clear();

    // End ticks: they anchor the line to the glass and give it a designed
    // terminal instead of a dash that happens to stop.
    for (const x of [BOARD.left, BOARD.right - 2]) {
      g.rect(x, DANGER_Y - 3, 2, 7).fill({ color: colour, alpha: 1 });
    }

    // Marching ants, and they march faster the closer the run is to over.
    const period = DASH + GAP;
    const phase = Math.floor(this.t * r * 0.055) % period;
    const x0 = BOARD.left + 4;
    const x1 = BOARD.right - 4;
    for (let x = x0 - phase; x < x1; x += period) {
      const a = Math.max(x0, x);
      const b = Math.min(x1, x + DASH);
      if (b <= a) continue;
      g.rect(a, DANGER_Y + 1, b - a, 1).fill({ color: 0x04060d, alpha: 0.75 });
      g.rect(a, DANGER_Y, b - a, 1).fill({ color: colour, alpha });
    }
  }
}

function sprite(buf) {
  return new Sprite(toTexture(buf));
}
