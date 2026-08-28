#!/usr/bin/env node
/**
 * Counts unique colours per fruit sprite.
 *
 * The art bible caps a single object at roughly six shades, and the failure
 * this catches is subtle: art that is technically low-resolution but was
 * resampled from a smooth source reads as pixel art at a glance while
 * carrying dozens of near-duplicate colours. Counting is the only way to
 * tell those apart reliably — the eye cannot.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.SHOT_PORT || 4270);
const DIST = process.env.SHOT_DIST || 'dist-colour';

spawn('npx', ['vite', 'build', '--outDir', DIST], { stdio: 'ignore' })
  .on('exit', () => {});
// Build synchronously before serving.
await new Promise((res, rej) => {
  const b = spawn('npx', ['vite', 'build', '--outDir', DIST], { stdio: 'ignore' });
  b.on('exit', (c) => (c === 0 ? res() : rej(new Error('build failed'))));
});

const server = spawn('npx', ['vite', 'preview', '--outDir', DIST, '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
process.on('exit', () => server.kill());
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* waiting */ }
  await sleep(250);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });

// Read the baked textures straight from the source canvases: measuring the
// art itself, not a screenshot that has been through the compositor.
const rows = await page.evaluate(() => {
  const { renderer } = window.__game;
  const out = [];
  for (let tier = 0; tier < 11; tier++) {
    const tex = renderer.texture(tier, 0);
    const src = tex.source.resource;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const counts = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let significant = 0;
    for (const n of counts.values()) if (n >= 6) significant++;
    // Near-duplicates are the resampling signature: two colours within a
    // channel distance of 8 are not two authored stops.
    const keys = [...counts.keys()];
    let near = 0;
    for (let a = 0; a < keys.length; a++) {
      for (let b = a + 1; b < keys.length; b++) {
        const dr = Math.abs((keys[a] >> 16 & 255) - (keys[b] >> 16 & 255));
        const dg = Math.abs((keys[a] >> 8 & 255) - (keys[b] >> 8 & 255));
        const db = Math.abs((keys[a] & 255) - (keys[b] & 255));
        if (dr <= 8 && dg <= 8 && db <= 8) near++;
      }
    }
    out.push({ tier, size: `${c.width}x${c.height}`, total: counts.size, significant, near });
  }
  return out;
});

const NAMES = ['cherry', 'strawberry', 'grape', 'dekopon', 'persimmon', 'apple',
  'pear', 'peach', 'pineapple', 'melon', 'watermelon'];
console.log('tier fruit        size     total  >=6px  near-dupes');
let worst = 0;
for (const r of rows) {
  worst = Math.max(worst, r.total);
  console.log(
    `${String(r.tier).padStart(2)}   ${NAMES[r.tier].padEnd(12)} ${r.size.padEnd(8)} `
    + `${String(r.total).padStart(5)}  ${String(r.significant).padStart(5)}  ${String(r.near).padStart(6)}`);
}
console.log(`\nworst total: ${worst}`);

await browser.close();
server.kill();
process.exit(0);
