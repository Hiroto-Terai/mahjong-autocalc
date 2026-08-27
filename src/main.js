import { createApp } from './core/app.js';
import { Loop } from './core/loop.js';
import { Input } from './core/input.js';
import { Events } from './core/events.js';
import { Game } from './game/game.js';
import { FruitRenderer } from './game/renderer.js';
import { Scene } from './ui/scene.js';
import { Hud } from './ui/hud.js';
import { Fx } from './fx/fx.js';
import { Audio } from './audio/audio.js';
import { PHYSICS, DEFAULT_SEED } from './config.js';

/**
 * Wiring only.
 *
 * Every subsystem receives the shared `ctx` and subscribes itself to the
 * events it cares about, so adding behaviour never means editing this file.
 * Construction order is: context -> renderer -> presentation -> game.
 */
async function boot() {
  const mount = document.getElementById('stage');
  const view = await createApp(mount);

  const params = new URLSearchParams(location.search);
  const seed = params.has('seed') ? Number(params.get('seed')) : DEFAULT_SEED;

  /** Filled progressively; subsystems must read fields lazily, not at construct time. */
  const ctx = {
    view,
    app: view.app,
    root: view.root,
    layers: view.layers,
    events: new Events(),
    params,
  };

  ctx.renderer = new FruitRenderer(ctx);
  ctx.scene = new Scene(ctx);
  ctx.fx = new Fx(ctx);
  ctx.hud = new Hud(ctx);
  ctx.audio = new Audio(ctx);
  ctx.input = new Input(ctx, mount);
  ctx.game = new Game({ seed, events: ctx.events });
  // Boot to the attract screen unless a harness asks to skip it.
  if (!params.has('play')) ctx.game.reset(seed, { toTitle: true });

  const render = (alpha, frameMs) => {
    const now = ctx.game.physics.engine.timing.timestamp;
    ctx.renderer.sync(ctx.game, alpha, now);
    ctx.fx.update(frameMs, ctx.game);
    ctx.scene.update(frameMs, ctx.game);
    ctx.hud.update(frameMs, ctx.game);
  };

  const loop = new Loop({
    step: PHYSICS.timeStep,
    maxSubSteps: PHYSICS.maxSubSteps,
    update: (dt) => ctx.game.update(dt, ctx.input),
    render,
  });
  ctx.loop = loop;
  loop.start();

  /**
   * Test hooks. The screenshot harness stops the RAF loop and drives the
   * simulation in exact fixed steps, so a given seed + script always produces
   * the identical frame — that is what makes visual regressions meaningful.
   */
  const stubInput = { aimX: 0, update() {}, takeDrop: () => false, takeRestart: () => false };
  window.__game = {
    ...ctx,
    game: ctx.game,
    renderOnce(alpha = 0, frameMs = PHYSICS.timeStep) {
      render(alpha, frameMs);
      view.app.render();
    },
    /** Advance the simulation by `ms` of game time without rendering. */
    advance(ms) {
      const n = Math.round(ms / PHYSICS.timeStep);
      for (let i = 0; i < n; i++) ctx.game.update(PHYSICS.timeStep, stubInput);
    },
    /** Advance presentation-only time (particles, tweens) without physics. */
    advanceFx(ms, sliceMs = PHYSICS.timeStep) {
      for (let t = 0; t < ms; t += sliceMs) {
        ctx.fx.update(sliceMs, ctx.game);
        ctx.scene.update(sliceMs, ctx.game);
        ctx.hud.update(sliceMs, ctx.game);
      }
    },
    dropAt(x) {
      ctx.game.aimX = ctx.game.clampAim(x, ctx.game.current);
      return ctx.game.drop();
    },
    detach() { loop.stop(); ctx.audio.enabled = false; },
  };
}

boot();
