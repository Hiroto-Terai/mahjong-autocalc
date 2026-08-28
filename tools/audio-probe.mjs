#!/usr/bin/env node
/**
 * Audio probe.
 *
 * Boots the built game in headless Chromium and renders the *production*
 * audio engine into an OfflineAudioContext, one scripted scenario at a time,
 * then measures what came back: peak, RMS, DC offset, how long the tail takes
 * to reach silence, and a spectral centroid so "deep" can be checked rather
 * than asserted.
 *
 *   SHOT_PORT=4214 SHOT_DIST=dist-audio node tools/audio-probe.mjs [name...]
 *
 * Exit code is non-zero if any hard check fails, so this is usable as a gate.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.SHOT_PORT || 4214);
const DIST = process.env.SHOT_DIST || 'dist-audio';
const SR = 44100;

/* ------------------------------------------------------------------ *
 * Measurement.
 * ------------------------------------------------------------------ */

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Energy-weighted mean frequency, averaged over the frames that are loud
 *  enough to matter — a centroid taken over silence is meaningless. */
function spectrum(x, sr) {
  const N = 8192;
  const hop = N / 2;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  let num = 0, den = 0;
  const bands = { sub: 0, low: 0, mid: 0, high: 0 };
  let peakBin = 0, peakMag = 0;
  for (let off = 0; off + N <= x.length; off += hop) {
    let frameRms = 0;
    for (let i = 0; i < N; i++) frameRms += x[off + i] * x[off + i];
    if (Math.sqrt(frameRms / N) < 1e-4) continue;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[off + i] * win[i];
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const f = (k * sr) / N;
      num += f * mag; den += mag;
      if (mag > peakMag) { peakMag = mag; peakBin = f; }
      if (f < 120) bands.sub += mag; else if (f < 500) bands.low += mag;
      else if (f < 2500) bands.mid += mag; else bands.high += mag;
    }
  }
  const tot = bands.sub + bands.low + bands.mid + bands.high || 1;
  return {
    centroid: den ? num / den : 0,
    peakFreq: peakBin,
    sub: bands.sub / tot, low: bands.low / tot, mid: bands.mid / tot, high: bands.high / tot,
  };
}

/** Dominant frequency every `hop` seconds, for frames loud enough to matter.
 *  This is how a claim like "the cadence descends" becomes a number. */
function pitchTrack(x, sr, hop = 0.12) {
  const N = 2048;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const step = Math.floor(hop * sr);
  const out = [];
  for (let off = 0; off + N <= x.length; off += step) {
    let e = 0;
    for (let i = 0; i < N; i++) e += x[off + i] * x[off + i];
    if (Math.sqrt(e / N) < 3e-3) continue;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[off + i] * win[i];
    fft(re, im);
    let best = 0, bestMag = 0;
    for (let k = 2; k < N / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      if (mag > bestMag) { bestMag = mag; best = (k * sr) / N; }
    }
    out.push(Math.round(best));
  }
  return out;
}

/** Fraction of adjacent pairs moving in `dir`, ignoring repeats. */
function trend(track, dir) {
  let moves = 0, agree = 0;
  for (let i = 1; i < track.length; i++) {
    const d = Math.sign(track[i] - track[i - 1]);
    if (!d) continue;
    moves++;
    if (d === dir) agree++;
  }
  return moves ? agree / moves : 0;
}

function measure({ b64, length, sampleRate }) {
  const raw = Buffer.from(b64, 'base64');
  const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const L = all.subarray(0, length);
  const R = all.subarray(length, length * 2);
  const mix = new Float32Array(length);
  let peak = 0, sum = 0, dc = 0, clipped = 0;
  for (let i = 0; i < length; i++) {
    const a = Math.abs(L[i]), b = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
    if (a > 1 || b > 1) clipped++;
    mix[i] = (L[i] + R[i]) * 0.5;
    sum += mix[i] * mix[i];
    dc += mix[i];
  }
  const rms = Math.sqrt(sum / length);
  // Where the sound actually ends: last sample above -66dBFS.
  let tailEnd = 0;
  for (let i = length - 1; i >= 0; i--) {
    if (Math.abs(mix[i]) > 0.0005) { tailEnd = (i + 1) / sampleRate; break; }
  }
  let tailSum = 0;
  const tailN = Math.min(length, Math.floor(sampleRate * 0.15));
  for (let i = length - tailN; i < length; i++) tailSum += mix[i] * mix[i];
  return {
    duration: length / sampleRate,
    peak,
    peakDb: 20 * Math.log10(peak || 1e-9),
    rms,
    rmsDb: 20 * Math.log10(rms || 1e-9),
    dc: dc / length,
    clipped,
    tailEnd,
    tailRms: Math.sqrt(tailSum / tailN),
    track: pitchTrack(mix, sampleRate),
    ...spectrum(mix, sampleRate),
  };
}

/* ------------------------------------------------------------------ *
 * Scenarios.
 * ------------------------------------------------------------------ */

const merges = (n, gap, opts) => Array.from({ length: n }, (_, i) => ({
  type: 'merge', t: 0.05 + i * gap, ...opts(i),
}));

const CASES = [];
for (let tier = 0; tier <= 10; tier++) {
  CASES.push({
    name: `merge-t${tier}`,
    spec: { duration: 2.6, events: [{ type: 'merge', t: 0.05, tier, combo: 1 }] },
    // Bigger fruit must actually be lower, and every chime must be gone by
    // the end of the render.
    expect: { peak: [0.05, 0.95], decays: true, dc: 0.002 },
  });
}
for (let combo = 1; combo <= 6; combo++) {
  CASES.push({
    name: `combo-step${combo}`,
    spec: { duration: 2.2, events: [{ type: 'merge', t: 0.05, tier: 2, combo }] },
    expect: { decays: true, clipFree: true },
  });
}
CASES.push(
  {
    // How a chain actually happens: each link merges into the next tier up.
    name: 'chain-real',
    spec: {
      duration: 3.2,
      events: merges(6, 0.26, (i) => ({ tier: i + 2, combo: i + 1 })),
    },
    expect: { decays: true, clipFree: true, rising: 0.75 },
  },
  {
    name: 'combo-run',
    spec: {
      duration: 3.5,
      events: merges(6, 0.22, (i) => ({ tier: Math.min(10, i + 1), combo: i + 1 })),
    },
    expect: { peak: [0.1, 1.0], decays: true, clipFree: true },
  },
  {
    name: 'merge-pileup',
    spec: {
      duration: 3.0,
      events: merges(8, 0.015, (i) => ({ tier: 3 + (i % 6), combo: 1 })),
    },
    expect: { peak: [0.1, 1.0], decays: true, clipFree: true },
  },
  {
    name: 'merge-new-tier',
    spec: { duration: 3.0, events: [{ type: 'merge', t: 0.05, tier: 8, combo: 4, isNew: true }] },
    expect: { decays: true, clipFree: true },
  },
  {
    name: 'drop',
    spec: { duration: 1.0, events: [{ type: 'drop', t: 0.05, tier: 2 }] },
    expect: { peak: [0.02, 0.5], decays: true },
  },
  {
    name: 'drop-big',
    spec: { duration: 1.0, events: [{ type: 'drop', t: 0.05, tier: 4 }] },
    expect: { peak: [0.02, 0.5], decays: true },
  },
  {
    name: 'impact-soft-small',
    spec: { duration: 0.8, events: [{ type: 'impact', t: 0.05, speed: 2, tier: 0 }] },
    expect: { peak: [0.005, 0.3], decays: true },
  },
  {
    name: 'impact-hard-small',
    spec: { duration: 0.8, events: [{ type: 'impact', t: 0.05, speed: 11, tier: 1 }] },
    expect: { peak: [0.02, 0.6], decays: true },
  },
  {
    name: 'impact-hard-big',
    spec: { duration: 1.2, events: [{ type: 'impact', t: 0.05, speed: 11, tier: 10 }] },
    expect: { peak: [0.02, 0.7], decays: true },
  },
  {
    name: 'impact-machinegun',
    spec: {
      duration: 2.5,
      events: Array.from({ length: 70 }, (_, i) => ({
        type: 'impact', t: 0.05 + i * 0.014, speed: 2 + (i % 5), tier: i % 8,
      })),
    },
    expect: { clipFree: true, decays: true, admitted: [6, 22] },
  },
  {
    name: 'danger-rise-release',
    spec: {
      duration: 6.0,
      events: [
        ...Array.from({ length: 20 }, (_, i) => ({ type: 'danger', t: 0.1 + i * 0.15, ratio: (i + 1) / 20 })),
        { type: 'danger', t: 3.4, ratio: 0 },
      ],
    },
    expect: { peak: [0.05, 0.95], decays: true, clipFree: true },
  },
  {
    name: 'danger-then-gameover',
    spec: {
      duration: 7.0,
      events: [
        ...Array.from({ length: 10 }, (_, i) => ({ type: 'danger', t: 0.1 + i * 0.2, ratio: (i + 1) / 10 })),
        { type: 'gameover', t: 2.2 },
      ],
    },
    expect: { decays: true, clipFree: true },
  },
  {
    name: 'watermelon',
    spec: { duration: 4.0, events: [{ type: 'watermelon', t: 0.3 }] },
    expect: { peak: [0.1, 1.0], decays: true, clipFree: true, rising: 0.7 },
  },
  {
    name: 'gameover',
    spec: { duration: 6.0, events: [{ type: 'gameover', t: 0.1 }] },
    expect: { peak: [0.08, 1.0], decays: true, clipFree: true, falling: 0.7 },
  },
  {
    name: 'voice-leak',
    spec: {
      duration: 12.0,
      events: [
        ...merges(30, 0.18, (i) => ({ tier: i % 11, combo: (i % 5) + 1 })),
        ...Array.from({ length: 30 }, (_, i) => ({ type: 'impact', t: 0.1 + i * 0.11, speed: 4 + (i % 6), tier: i % 11 })),
        { type: 'danger', t: 2.0, ratio: 0.6 },
        { type: 'danger', t: 4.0, ratio: 0 },
        { type: 'drop', t: 1.0, tier: 3 },
        { type: 'watermelon', t: 3.0 },
      ],
    },
    // Six seconds of nothing after the last event: anything still moving here
    // is a stuck oscillator, and a stuck oscillator never comes back.
    expect: { decays: true, clipFree: true },
  },
  {
    name: 'music-bed',
    spec: { duration: 14.0, music: true, events: [] },
    expect: { peak: [0.01, 0.4], clipFree: true },
  },
  {
    name: 'music-plus-chaos',
    spec: {
      duration: 8.0,
      music: true,
      events: [
        ...merges(5, 0.3, (i) => ({ tier: 5 + i, combo: i + 1 })),
        { type: 'watermelon', t: 2.4 },
        ...Array.from({ length: 40 }, (_, i) => ({
          type: 'impact', t: 3.5 + i * 0.03, speed: 3 + (i % 7), tier: i % 9,
        })),
        { type: 'drop', t: 5.0, tier: 3 },
      ],
    },
    expect: { clipFree: true },
  },
);

/* ------------------------------------------------------------------ *
 * Driver.
 * ------------------------------------------------------------------ */

async function waitForServer(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`server never came up at ${url}`);
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

// Build once: a probe that measures audio the release build cannot produce
// is worthless, so the build is part of the check.
const build = spawn('npx', ['vite', 'build', '--outDir', DIST], { stdio: 'inherit' });
const buildOk = await new Promise((res) => build.on('exit', (c) => res(c === 0)));

// Measurement runs against the dev server rather than the preview build, so
// the probe can import the audio modules directly. That keeps it working when
// an unrelated subsystem is mid-refactor and the game itself will not boot —
// which is exactly when you most want to know your own code is still fine.
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
process.on('exit', () => server.kill());

let failures = buildOk ? 0 : 1;
if (!buildOk) console.log('BUILD FAILED');

try {
  await waitForServer(`http://localhost:${PORT}/`);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 360, height: 520 } });
  const errors = [];
  // index.html ships no favicon, so Chromium logs a 404 that has nothing to
  // do with audio. Everything else is a real failure.
  const ignore = (t) => /favicon/i.test(t) || /404 \(Not Found\)/.test(t);
  page.on('pageerror', (e) => { if (!ignore(String(e))) errors.push(`pageerror: ${e}`); });
  page.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    const m = await import('/src/audio/offline.js');
    window.__probe = m.renderOffline;
  });
  const booted = await page.evaluate(() => !!window.__audio);

  const rows = [];
  for (const c of CASES) {
    if (only.length && !only.some((o) => c.name.includes(o))) continue;
    const res = await page.evaluate(
      (spec) => window.__probe(spec),
      { sampleRate: SR, ...c.spec },
    );
    const m = measure(res);
    m.admitted = res.admitted;
    m.offered = res.offered;

    const bad = [];
    const e = c.expect || {};
    if (e.peak && (m.peak < e.peak[0] || m.peak > e.peak[1])) {
      bad.push(`peak ${m.peak.toFixed(3)} outside [${e.peak.join(', ')}]`);
    }
    if (m.clipped > 0) bad.push(`CLIPS (${m.clipped} samples > 1.0)`);
    if (e.decays && m.tailRms > 0.0008) bad.push(`tail never dies (rms ${m.tailRms.toExponential(2)})`);
    if (Math.abs(m.dc) > (e.dc ?? 0.002)) bad.push(`DC offset ${m.dc.toExponential(2)}`);
    if (e.rising) {
      const r = trend(m.track, 1);
      if (r < e.rising) bad.push(`pitch only rises ${(r * 100) | 0}% of moves (${m.track.join(' ')})`);
    }
    if (e.falling) {
      const r = trend(m.track, -1);
      if (r < e.falling) bad.push(`pitch only falls ${(r * 100) | 0}% of moves (${m.track.join(' ')})`);
    }
    if (e.admitted && (m.admitted < e.admitted[0] || m.admitted > e.admitted[1])) {
      bad.push(`gate admitted ${m.admitted}/${m.offered}, want [${e.admitted.join(', ')}]`);
    }
    if (bad.length) failures++;
    rows.push({ name: c.name, m, bad });
  }

  const pad = (s, n) => String(s).padEnd(n);
  const num = (v, n, d = 2) => String(v.toFixed(d)).padStart(n);
  console.log('');
  console.log([
    pad('case', 22), num2('peak', 7), num2('peakdB', 8), num2('rmsdB', 8),
    num2('tailEnd', 8), num2('tailRMS', 9), num2('centroid', 9), num2('peakHz', 8),
    num2('sub%', 6), num2('hi%', 6), num2('DC', 10),
  ].join(' '));
  for (const { name, m, bad } of rows) {
    console.log([
      pad(name, 22), num(m.peak, 7, 3), num(m.peakDb, 8, 1), num(m.rmsDb, 8, 1),
      num(m.tailEnd, 8, 2), num(m.tailRms * 1000, 9, 3), num(m.centroid, 9, 0), num(m.peakFreq, 8, 0),
      num(m.sub * 100, 6, 1), num(m.high * 100, 6, 1),
      String(m.dc.toExponential(1)).padStart(10),
      m.offered ? ` gate ${m.admitted}/${m.offered}` : '',
    ].join(' '));
    for (const b of bad) console.log(`${' '.repeat(22)}  !! ${b}`);
  }

  const by = Object.fromEntries(rows.map((r) => [r.name, r.m]));
  const cross = [];
  const tiers = rows.filter((r) => /^merge-t\d+$/.test(r.name)).map((r) => r.m);
  if (tiers.length === 11) {
    const peaks = tiers.map((m) => m.peakDb);
    const spread = Math.max(...peaks) - Math.min(...peaks);
    cross.push([`merge tier peak spread ${spread.toFixed(1)} dB`, spread <= 8]);
    const desc = tiers.every((m, i) => i === 0 || m.peakFreq < tiers[i - 1].peakFreq * 1.02);
    cross.push(['merge pitch descends with tier', desc]);
    cross.push([`watermelon sub-band ${(tiers[10].sub * 100).toFixed(0)}% > cherry ${(tiers[0].sub * 100).toFixed(0)}%`,
      tiers[10].sub > tiers[0].sub * 8]);
  }
  const steps = rows.filter((r) => /^combo-step/.test(r.name)).map((r) => r.m);
  if (steps.length === 6) {
    const hz = steps.map((m) => m.peakFreq.toFixed(0));
    const distinct = new Set(hz).size;
    cross.push([`same-tier cascade keeps moving: ${hz.join(' -> ')} Hz (${distinct} distinct)`, distinct >= 5]);
  }
  const chain = by['chain-real'];
  if (chain) {
    cross.push([`real chain rises: ${chain.track.join(' ')} Hz`, trend(chain.track, 1) >= 0.75]);
  }
  if (by.drop && by['merge-t5']) {
    const rel = by.drop.peakDb - by['merge-t5'].peakDb;
    cross.push([`drop sits ${rel.toFixed(1)} dB under a mid merge`, rel < -3 && rel > -18]);
  }
  if (by['music-bed'] && by['merge-t5']) {
    const rel = by['music-bed'].rmsDb - by['merge-t5'].rmsDb;
    cross.push([`music bed sits ${rel.toFixed(1)} dB under merges`, rel < -3 && rel > -18]);
  }
  if (by['impact-machinegun'] && by['impact-hard-small']) {
    const rel = by['impact-machinegun'].peakDb - by['impact-hard-small'].peakDb;
    cross.push([`70-impact burst peaks ${rel.toFixed(1)} dB vs one hard hit`, rel < 6]);
  }
  console.log('');
  for (const [label, ok] of cross) {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  }

  console.log('');
  console.log(`  ${buildOk ? 'ok  ' : 'FAIL'} production build`);
  console.log(`  ${booted ? 'ok  ' : 'warn'} game booted and constructed Audio${booted ? '' : ' (see errors below)'}`);
  if (errors.length) {
    failures++;
    console.log(`\nPAGE ERRORS:\n  ${errors.join('\n  ')}`);
  } else {
    console.log('  ok   no page errors');
  }
  await browser.close();
} finally {
  server.kill();
}

function num2(s, n) { return String(s).padStart(n); }

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
