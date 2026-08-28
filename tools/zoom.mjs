#!/usr/bin/env node
/**
 * Crop and magnify a region of a capture for texel-level inspection.
 *
 *   node tools/zoom.mjs shots/mid-game@1x.png <x> <y> <w> <h> [scale]
 *
 * Reading a 320x480 PNG at native size hides exactly the faults that matter
 * at this resolution — a one-texel seam, a stray pixel, a dither band that is
 * really a checkerboard. This renders the crop nearest-neighbour so those are
 * visible without guessing.
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const [png, x, y, w, h, scale = 8] = process.argv.slice(2);
const data = (await readFile(png)).toString('base64');
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: +w * +scale, height: +h * +scale } });
await p.setContent(`<style>body{margin:0}div{width:${+w*+scale}px;height:${+h*+scale}px;overflow:hidden;position:relative}
img{position:absolute;left:${-x*scale}px;top:${-y*scale}px;image-rendering:pixelated;transform-origin:0 0;transform:scale(${scale})}</style>
<div><img src="data:image/png;base64,${data}"></div>`);
await p.screenshot({ path: 'shots-ui/_zoom.png' });
await b.close();
