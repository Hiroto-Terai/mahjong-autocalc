import { Container, Text, Sprite } from 'pixi.js';
import { VIRTUAL_W, BOARD, DROP, FRUITS } from '../config.js';

/**
 * Score, next-up preview, claw and game-over panel.
 * BASELINE — owned by the UI pass. Uses system text for now; the UI pass
 * replaces this with a bitmap pixel font.
 */
export class Hud {
  constructor(layers, renderer) {
    this.renderer = renderer;
    this.root = new Container();
    layers.ui.addChild(this.root);

    const style = { fontFamily: 'monospace', fontSize: 14, fill: 0xffffff };
    this.score = new Text({ text: '0', style: { ...style, fontSize: 20 } });
    this.score.x = 10; this.score.y = 8;
    this.best = new Text({ text: 'BEST 0', style });
    this.best.x = 10; this.best.y = 30;
    this.root.addChild(this.score, this.best);

    this.nextSprite = new Sprite();
    this.nextSprite.anchor.set(0.5);
    this.nextSprite.x = VIRTUAL_W - 34; this.nextSprite.y = 34;
    this.root.addChild(this.nextSprite);

    this.claw = new Sprite();
    this.claw.anchor.set(0.5);
    this.claw.alpha = 0.85;
    layers.fruit.addChild(this.claw);

    this.overlay = new Text({ text: '', style: { ...style, fontSize: 18, align: 'center' } });
    this.overlay.anchor.set(0.5);
    this.overlay.x = VIRTUAL_W / 2; this.overlay.y = 220;
    layers.overlay.addChild(this.overlay);
  }

  update(game) {
    this.score.text = String(game.score);
    this.best.text = `BEST ${game.best}`;

    this.nextSprite.texture = this.renderer.texture(game.next);
    const scale = Math.min(1, 22 / (FRUITS[game.next].radius * 2));
    this.nextSprite.scale.set(scale);

    this.claw.visible = game.state === 'playing';
    if (this.claw.visible) {
      this.claw.texture = this.renderer.texture(game.current);
      this.claw.x = Math.round(game.aimX);
      this.claw.y = DROP.y;
    }

    this.overlay.text = game.state === 'over'
      ? `GAME OVER\n${game.score}\npress R`
      : '';
    void BOARD;
  }
}
