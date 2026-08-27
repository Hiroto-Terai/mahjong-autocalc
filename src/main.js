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

async function boot() {
  const mount = document.getElementById('stage');
  const view = await createApp(mount);

  const events = new Events();
  const renderer = new FruitRenderer(view.layers.fruit);
  const scene = new Scene(view.layers);
  const hud = new Hud(view.layers, renderer);
  const fx = new Fx(view.layers, view.root);
  const audio = new Audio();

  // Screenshot / test harness can pin the seed via ?seed=
  const params = new URLSearchParams(location.search);
  const seed = params.has('seed') ? Number(params.get('seed')) : DEFAULT_SEED;

  const game = new Game({ seed, events });
  const input = new Input(view, mount);

  events.on('merge', ({ x, y, tier }) => { fx.burst(x, y, tier); audio.merge(tier); });
  events.on('drop', () => audio.drop());
  events.on('impact', ({ speed }) => audio.impact(speed));
  events.on('gameover', () => audio.over());
  events.on('danger', ({ ratio }) => { scene.dangerRatio = ratio; });

  const loop = new Loop({
    step: PHYSICS.timeStep,
    maxSubSteps: PHYSICS.maxSubSteps,
    update: (dt) => game.update(dt, input),
    render: (alpha, frameMs) => {
      renderer.sync(game.physics, alpha, game.physics.engine.timing.timestamp);
      fx.update(frameMs);
      scene.update();
      hud.update(game);
    },
  });
  loop.start();

  const renderOnce = (alpha = 0, frameMs = PHYSICS.timeStep) => {
    renderer.sync(game.physics, alpha, game.physics.engine.timing.timestamp);
    fx.update(frameMs);
    scene.update();
    hud.update(game);
    view.app.render();
  };

  /**
   * Test hooks. The screenshot harness stops the RAF loop and drives the
   * simulation in exact fixed steps, so a given seed + script always produces
   * the identical frame — that is what makes visual regressions meaningful.
   */
  const stubInput = {
    aimX: 0, update() {}, takeDrop: () => false, takeRestart: () => false,
  };
  window.__game = {
    game, loop, view, renderer, events, input, fx, scene, hud,
    renderOnce,
    /** Advance the simulation by `ms` of game time without rendering. */
    advance(ms) {
      const n = Math.round(ms / PHYSICS.timeStep);
      for (let i = 0; i < n; i++) game.update(PHYSICS.timeStep, stubInput);
    },
    /** Drop the held fruit at virtual-x `x`. */
    dropAt(x) {
      game.aimX = game.clampAim(x, game.current);
      return game.drop();
    },
    detach() { loop.stop(); audio.enabled = false; },
  };
}

boot();
