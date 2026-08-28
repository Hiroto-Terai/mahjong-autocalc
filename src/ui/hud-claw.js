import { Container, Graphics, Sprite } from 'pixi.js';
import { VIRTUAL_W, BOARD, DROP, FRUITS } from '../config.js';
import { THEME } from './hud-theme.js';
import { px, dashV, markerDown } from './panel-frame.js';

/** Rail rows. The gantry hangs just under the HUD deck. */
const RAIL_Y = 30;
const RAIL_H = 5;
/** Carriage box, centred on the aim column. */
const CAR_W = 21;
const CAR_Y = 26;
const CAR_H = 13;

/**
 * The dropper: a gantry rail, a carriage that rides it, and a two-finger
 * gripper that resizes itself around whatever fruit is loaded.
 *
 * The arms are rebuilt every frame from the fruit radius rather than being one
 * fixed sprite, because a claw that visibly *fits* the cherry and *strains*
 * around the persimmon is the difference between a machine and a decal.
 */
export class Claw {
  constructor(ctx) {
    this.ctx = ctx;
    const layer = ctx.layers.fruit;

    // The aim guide belongs behind the pile: it is a floor marking, not an
    // overlay, so fruit must occlude it.
    this.guide = new Graphics();
    layer.addChildAt(this.guide, 0);

    this.root = new Container();
    layer.addChild(this.root);

    this.rail = new Graphics();
    this.fruit = new Sprite();
    this.fruit.anchor.set(0.5);
    this.gripper = new Graphics();
    // Fruit under the rail, gripper over both: the fruit hangs behind the
    // gantry and inside the claw, which is the only order that reads as 3D.
    this.root.addChild(this.fruit, this.rail, this.gripper);

    this._drawRail();
  }

  _drawRail() {
    const g = this.rail;
    const y = RAIL_Y;
    px(g, 0, y - 1, VIRTUAL_W, 1, THEME.ink, 0.45);
    px(g, 0, y, VIRTUAL_W, 1, THEME.steelLite);
    px(g, 0, y + 1, VIRTUAL_W, 2, THEME.steel);
    px(g, 0, y + 3, VIRTUAL_W, 1, THEME.steelDark);
    px(g, 0, y + 4, VIRTUAL_W, 1, THEME.ink, 0.55);

    // Rivets read as machining marks; spaced wide so they never buzz.
    for (let x = 6; x < VIRTUAL_W; x += 21) {
      px(g, x, y + 1, 1, 1, THEME.ink, 0.5);
      px(g, x, y + 2, 1, 1, THEME.steelLite, 0.45);
    }

    // End posts anchor the rail to the frame instead of letting it run off.
    for (const x of [1, VIRTUAL_W - 6]) {
      px(g, x, y - 4, 5, RAIL_H + 8, THEME.steelDark);
      px(g, x + 1, y - 3, 3, RAIL_H + 6, THEME.steel);
      px(g, x + 1, y - 3, 3, 1, THEME.steelLite);
      px(g, x + 1, y + RAIL_H + 2, 3, 1, THEME.ink, 0.6);
    }
  }

  /** Rebuild the carriage + gripper around a fruit of radius `r` at `cx`. */
  _drawGripper(cx, r, charge) {
    const g = this.gripper;
    g.clear();

    const outer = r + 3;
    // Clamp the yoke up under the rail for the big fruit; anything lower and
    // the bar would cut across the fruit's face.
    const yokeY = Math.max(RAIL_Y + 1, DROP.y - r - 4);
    const armBottom = DROP.y + Math.round(r * 0.35);

    // Yoke: one bar through the whole span, its middle hidden by the carriage.
    px(g, cx - outer - 1, yokeY - 1, outer * 2 + 3, 4, THEME.ink);
    px(g, cx - outer, yokeY, outer * 2 + 1, 1, THEME.steelLite);
    px(g, cx - outer, yokeY + 1, outer * 2 + 1, 1, THEME.steel);

    for (const s of [-1, 1]) {
      const x = cx + s * outer - (s < 0 ? 1 : 0);
      // Arm: dark silhouette first, steel inset into it.
      px(g, x - 1, yokeY, 4, armBottom - yokeY + 1, THEME.ink);
      px(g, x, yokeY + 2, 2, armBottom - yokeY - 2, s < 0 ? THEME.steel : THEME.steelDark);
      px(g, x + (s < 0 ? 0 : 1), yokeY + 2, 1, armBottom - yokeY - 2, s < 0 ? THEME.steelLite : THEME.steel);
      // Hook curling in toward the fruit.
      const hx = s < 0 ? x : x - 3;
      px(g, hx - (s < 0 ? 1 : 0), armBottom - 1, 6, 4, THEME.ink);
      px(g, s < 0 ? x + 2 : x - 3, armBottom, 3, 2, THEME.steel);
      px(g, s < 0 ? x + 2 : x - 3, armBottom, 3, 1, THEME.steelLite);
    }

    // Carriage.
    const cw = CAR_W;
    const cx0 = cx - ((cw - 1) >> 1);
    px(g, cx0 - 1, CAR_Y - 1, cw + 2, CAR_H + 2, THEME.ink);
    px(g, cx0, CAR_Y, cw, CAR_H, THEME.steel);
    px(g, cx0, CAR_Y, cw, 1, THEME.steelLite);
    px(g, cx0, CAR_Y + CAR_H - 1, cw, 1, THEME.steelDark);
    px(g, cx0, CAR_Y + 1, 1, CAR_H - 2, THEME.steelLite, 0.5);
    px(g, cx0 + cw - 1, CAR_Y + 1, 1, CAR_H - 2, THEME.steelDark);
    // Bolt heads either side of the charge slot.
    for (const bx of [cx0 + 2, cx0 + cw - 3]) {
      px(g, bx, CAR_Y + 3, 1, 1, THEME.ink);
      px(g, bx, CAR_Y + 4, 1, 1, THEME.steelLite, 0.6);
    }

    // Reload slot: fills back to gold as the drop cooldown expires, so the
    // player learns the rhythm from the machine rather than from a number.
    const sw = cw - 8;
    const sx = cx0 + 4;
    const sy = CAR_Y + CAR_H - 5;
    px(g, sx - 1, sy - 1, sw + 2, 5, THEME.ink);
    px(g, sx, sy, sw, 3, 0x141a2b);
    const fill = Math.round(sw * charge);
    if (fill > 0) {
      px(g, sx, sy, fill, 3, charge >= 1 ? THEME.gold : THEME.goldDark);
      px(g, sx, sy, fill, 1, charge >= 1 ? THEME.goldLite : THEME.gold);
    }
  }

  /** Dashed plumb line from the loaded fruit to the floor. */
  _drawGuide(cx, r, live) {
    const g = this.guide;
    g.clear();
    if (!live) return;

    const top = DROP.y + r + 4;
    const floor = BOARD.floor - 1;
    dashV(g, cx, top, floor - 3, { on: 3, off: 5, colour: THEME.gold, alpha: 0.42, fade: 0.75 });
    // Width whiskers: the fruit's true footprint, so a tight gap can be judged
    // before committing rather than after.
    for (const s of [-1, 1]) {
      dashV(g, cx + s * r, top + 6, top + 40, { on: 1, off: 6, colour: THEME.gold, alpha: 0.2, fade: 1 });
    }
    // Landing bracket on the floor.
    px(g, cx - r, floor - 1, r * 2 + 1, 1, THEME.gold, 0.16);
    px(g, cx - r, floor - 3, 1, 3, THEME.gold, 0.28);
    px(g, cx + r, floor - 3, 1, 3, THEME.gold, 0.28);
    markerDown(g, cx, floor - 6, 3, THEME.gold, 0.3);
  }

  update(game) {
    const live = game.state === 'playing';
    this.root.visible = live;
    if (!live) {
      this.guide.clear();
      return;
    }

    const r = FRUITS[game.current].radius;
    const cx = Math.round(game.aimX);
    const charge = game.dropCooldown > 0 ? 1 - game.dropCooldown / DROP.cooldown : 1;

    this.fruit.texture = this.ctx.renderer.texture(game.current);
    this.fruit.x = cx;
    this.fruit.y = DROP.y;

    this._drawGripper(cx, r, charge);
    this._drawGuide(cx, r, true);
  }
}
