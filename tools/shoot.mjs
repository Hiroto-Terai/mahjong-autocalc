#!/usr/bin/env node
/**
 * Screenshot harness.
 *
 * Boots the built game in headless Chromium, drives each scenario with the
 * deterministic test hooks, and writes PNGs to shots/. Every capture is taken
 * twice: once at native 1x (for texel-level inspection) and once at 2x
 * (how a player actually sees it).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { SCENARIOS } from './scenarios.mjs';

const OUT = process.env.SHOT_DIR || 'shots';
const PORT = Number(process.env.SHOT_PORT || 4173);
// Per-agent build dir: parallel agents must not race on a shared dist/.
const DIST = process.env.SHOT_DIST || 'dist';

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`server never came up at ${url}`);
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const build = spawn('npx', ['vite', 'build', '--outDir', DIST], { stdio: 'inherit' });
await new Promise((res, rej) =>
  build.on('exit', (c) => (c === 0 ? res() : rej(new Error('build failed')))));

const server = spawn('npx', ['vite', 'preview', '--outDir', DIST, '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
});
process.on('exit', () => server.kill());

try {
  await waitForServer(`http://localhost:${PORT}/`);
  // Only a full run owns the directory; a single-scenario run must not delete
  // the captures it was not asked to retake.
  if (only.length === 0) await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // The image ships Chromium 1194; the pinned Playwright wants a newer build,
  // so point it at the browser that is actually here rather than downloading.
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--force-device-scale-factor=1', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
  });

  for (const sc of SCENARIOS) {
    if (only.length && !only.includes(sc.name)) continue;

    for (const zoom of [1, 2]) {
      const page = await browser.newPage({
        viewport: { width: 320 * zoom + 40, height: 480 * zoom + 40 },
        deviceScaleFactor: 1,
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

      await page.goto(`http://localhost:${PORT}/?seed=${sc.seed}`, { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });

      await page.evaluate((scenario) => {
        const G = window.__game;
        G.detach();
        const { game } = G;

        if (!scenario.title && game.state === 'title') game.start();

        if (scenario.lineup) {
          // Art sheet: every tier laid out on a grid, physics frozen, so the
          // critic grades the sprites themselves rather than a pile.
          game.physics.clear();
          const radii = scenario.radii;
          const rows = [[10, 9, 8], [7, 6, 5, 4], [3, 2, 1, 0]];
          let y = 150;
          for (const row of rows) {
            const total = row.reduce((a, t) => a + radii[t] * 2 + 6, -6);
            let x = 160 - total / 2;
            const tallest = Math.max(...row.map((t) => radii[t]));
            for (const tier of row) {
              x += radii[tier];
              const rec = game.physics.spawn(tier, x, y + tallest - radii[tier]);
              rec.body.isStatic = true;
              rec.bornAt = -9999;
              x += radii[tier] + 6;
            }
            y += tallest * 2 + 14;
          }
          G.renderOnce();
          return;
        }

        for (const [dropX, wait] of scenario.script || []) {
          G.dropAt(dropX);
          G.advance(wait);
        }
        G.advance(scenario.settle || 0);

        if (scenario.forceGameOver) {
          // Scripted play rarely overflows — merges keep clearing the pile.
          // Watermelons are the terminal tier and can never merge, so a stack
          // of them is the only fill guaranteed to survive to the grace timer.
          for (let row = 0; row < 5; row++) {
            for (let col = 0; col < 2; col++) {
              game.physics.spawn(10, 96 + col * 128 + (row % 2) * 32, 390 - row * 96);
            }
            // Mid-tier fruit tucked into the gaps keeps the board looking
            // played-in rather than like a crate of melons.
            game.physics.spawn(6 + (row % 3), 160 - (row % 2) * 60, 350 - row * 96);
          }
          G.advance(6000);
        }

        if (scenario.forceMerge) {
          // Drop a duplicate of the current fruit onto a matching resting one
          // so the capture lands mid-burst.
          const target = [...game.physics.fruits.values()]
            .filter((f) => f.tier === game.current)
            .sort((a, b) => a.body.position.y - b.body.position.y)[0];
          if (target) {
            G.dropAt(target.body.position.x);
            G.advance(900);
          }
          G.advance(scenario.fxDelay || 90);
        }
        G.renderOnce();
      }, { ...sc, radii: [8, 10, 13, 16, 20, 24, 29, 34, 39, 44, 50] });

      await page.evaluate(() => window.__game.renderOnce());
      const canvas = await page.$('canvas');
      await canvas.screenshot({ path: `${OUT}/${sc.name}@${zoom}x.png` });

      if (errors.length) {
        console.error(`  !! ${sc.name}@${zoom}x page errors:`);
        for (const e of errors.slice(0, 5)) console.error(`     ${e}`);
      }
      console.log(`  ✓ ${OUT}/${sc.name}@${zoom}x.png`);
      await page.close();
    }
  }

  await browser.close();
} finally {
  server.kill();
}
console.log('done');
