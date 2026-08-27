#!/usr/bin/env node
/**
 * Physics measurement harness.
 *
 * The feel of a merge-puzzle pile is not a matter of taste alone — jitter,
 * sinking, and merge explosions are all measurable. This drives `PhysicsWorld`
 * headlessly (no DOM, no renderer) with a seeded drop script and prints
 * objective numbers so tuning can be argued with instead of eyeballed.
 *
 *   node tools/physics-probe.mjs            # all suites
 *   node tools/physics-probe.mjs settle     # one suite
 *
 * Units: distances in virtual px, speeds in px/s, energy in px-units
 * (0.5*m*v^2 with Matter mass), time in ms of simulated game time.
 */
import { PhysicsWorld } from '../src/physics/world.js';
import { PHYSICS, BOARD, FRUITS, DROP, SPAWNABLE_TIERS } from '../src/config.js';
import { makeRng } from '../src/core/rng.js';

const DT = PHYSICS.timeStep;
const PER_S = 1000 / DT; // Matter velocity is px/step; scale to px/s.

/* ------------------------------------------------------------------ *
 * Simulation driver — mirrors Game's drop loop without its dependencies.
 * ------------------------------------------------------------------ */
class Sim {
  constructor(seed = 0x5ca1ab1e) {
    this.rng = makeRng(seed);
    this.merges = [];
    this.impacts = 0;
    this.world = new PhysicsWorld({
      onMerge: (m) => this.merges.push({ t: this.t, tier: m.tier, x: m.x, y: m.y }),
      onImpact: () => { this.impacts++; },
    });
    this.t = 0;
  }

  rollTier() {
    const weights = [30, 26, 20, 14, 10].slice(0, SPAWNABLE_TIERS);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.rng() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return 0;
  }

  clampAim(x, tier) {
    const r = FRUITS[tier].radius;
    return Math.max(BOARD.left + r + 1, Math.min(BOARD.right - r - 1, x));
  }

  drop(x, tier = this.rollTier()) {
    return this.world.spawn(tier, this.clampAim(x, tier), DROP.y);
  }

  advance(ms) {
    const n = Math.round(ms / DT);
    for (let i = 0; i < n; i++) {
      this.world.step(DT);
      this.t += DT;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Metrics.
 * ------------------------------------------------------------------ */
const recs = (sim) => [...sim.world.fruits.values()];

function kinetic(sim) {
  let ke = 0;
  let max = 0;
  for (const r of recs(sim)) {
    const v = Math.hypot(r.body.velocity.x, r.body.velocity.y) * PER_S;
    ke += 0.5 * r.body.mass * v * v;
    if (v > max) max = v;
  }
  return { ke, max };
}

/** Angular energy is the other half of "the pile never stops moving". */
function spin(sim) {
  let max = 0;
  let sum = 0;
  for (const r of recs(sim)) {
    const w = Math.abs(r.body.angularVelocity) * PER_S;
    sum += w;
    if (w > max) max = w;
  }
  return { max, mean: recs(sim).length ? sum / recs(sim).length : 0 };
}

/** Deepest interpenetration in the pile, plus how far anything is inside a wall. */
function penetration(sim) {
  const list = recs(sim);
  let pair = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const d = Math.hypot(a.body.position.x - b.body.position.x, a.body.position.y - b.body.position.y);
      const over = a.radius + b.radius - d;
      if (over > pair) pair = over;
    }
  }
  let wall = 0;
  for (const r of list) {
    const p = r.body.position;
    wall = Math.max(wall,
      p.y + r.radius - BOARD.floor,
      BOARD.left - (p.x - r.radius),
      (p.x + r.radius) - BOARD.right);
  }
  return { pair, wall };
}

function escaped(sim) {
  const out = [];
  for (const r of recs(sim)) {
    const p = r.body.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { out.push({ r, why: 'NaN' }); continue; }
    if (p.x < BOARD.left - 4 || p.x > BOARD.right + 4) out.push({ r, why: 'sideways' });
    else if (p.y > BOARD.floor + 4) out.push({ r, why: 'through floor' });
  }
  return out;
}

const snapshot = (sim) => recs(sim).map((r) => ({
  uid: r.uid, tier: r.tier, x: r.body.position.x, y: r.body.position.y, a: r.body.angle,
}));

/* ------------------------------------------------------------------ *
 * Shared scenario: a seeded pile built from scripted drops.
 * ------------------------------------------------------------------ */
function buildPile(sim, drops, { gap = DROP.cooldown } = {}) {
  for (let i = 0; i < drops; i++) {
    // Sweep across the jar rather than random-walking: a spread pile exercises
    // wall contact, nesting and merges alike, and stays reproducible.
    const span = BOARD.right - BOARD.left - 60;
    const x = BOARD.left + 30 + ((i * 97) % span);
    sim.drop(x);
    sim.advance(gap);
  }
}

const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : String(v));
const rows = [];
function report(suite, name, value, unit = '') {
  rows.push({ suite, name, value, unit });
  console.log(`  ${name.padEnd(30)} ${String(typeof value === 'number' ? num(value) : value).padStart(12)} ${unit}`);
}

/* ------------------------------------------------------------------ *
 * Suites.
 * ------------------------------------------------------------------ */

/** Residual motion: the jitter test. A settled pile must go to sleep. */
function suiteResidual() {
  console.log('\n[residual] 40 drops, then 6s of quiet');
  const sim = new Sim();
  buildPile(sim, 40);
  const out = [];
  for (let i = 0; i < 3; i++) { sim.advance(2000); out.push(kinetic(sim)); }
  report('residual', 'fruit in pile', recs(sim).length, 'bodies');
  report('residual', 'KE @ +2s', out[0].ke);
  report('residual', 'KE @ +4s', out[1].ke);
  report('residual', 'KE @ +6s', out[2].ke);
  report('residual', 'max speed @ +6s', out[2].max, 'px/s');
  const sp = spin(sim);
  report('residual', 'max spin @ +6s', sp.max, 'rad/s');
  report('residual', 'mean spin @ +6s', sp.mean, 'rad/s');
  // Drift: how far does a "settled" pile creep over the last 2 seconds?
  const before = snapshot(sim);
  sim.advance(2000);
  const after = snapshot(sim);
  let drift = 0;
  for (let i = 0; i < before.length; i++) {
    if (!after[i] || after[i].uid !== before[i].uid) continue;
    drift = Math.max(drift, Math.hypot(after[i].x - before[i].x, after[i].y - before[i].y));
  }
  report('residual', 'max drift over 2s', drift, 'px');
  const pen = penetration(sim);
  report('residual', 'max pair overlap', pen.pair, 'px');
  report('residual', 'max wall overlap', pen.wall, 'px');
}

/** Settle time: how long from the last drop until the pile is quiet. */
function suiteSettle() {
  console.log('\n[settle] time from a drop onto a settled pile until rest');
  const sim = new Sim();
  buildPile(sim, 24);
  sim.advance(4000);
  const samples = [];
  for (let k = 0; k < 6; k++) {
    sim.drop(BOARD.left + 60 + k * 30, 2);
    let ms = 0;
    // "At rest" = every body under 4 px/s for a continuous 250 ms.
    let quiet = 0;
    while (ms < 8000) {
      sim.advance(DT);
      ms += DT;
      quiet = kinetic(sim).max < 4 ? quiet + DT : 0;
      if (quiet >= 250) break;
    }
    samples.push(ms - quiet);
    sim.advance(1200);
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  report('settle', 'settle time mean', mean, 'ms');
  report('settle', 'settle time max', Math.max(...samples), 'ms');
}

/** Merge disturbance: a merge deep inside a packed pile must not launch it. */
function suiteMerge() {
  console.log('\n[merge] forced merge inside a settled pile');
  const sim = new Sim();
  buildPile(sim, 36);
  sim.advance(5000);

  // Find the deepest same-tier touching pair still resting in the pile.
  const list = recs(sim).sort((a, b) => b.body.position.y - a.body.position.y);
  let found = null;
  outer: for (const a of list) {
    for (const b of list) {
      if (a === b || a.tier !== b.tier) continue;
      const d = Math.hypot(a.body.position.x - b.body.position.x, a.body.position.y - b.body.position.y);
      if (d < a.radius + b.radius + 2) { found = [a, b]; break outer; }
    }
  }
  if (!found) { report('merge', 'no candidate pair', 'skipped'); return; }

  const before = snapshot(sim);
  const keBefore = kinetic(sim).ke;
  sim.world._pending.push(found);
  let peakKe = 0;
  let peakSpeed = 0;
  for (let i = 0; i < Math.round(1500 / DT); i++) {
    sim.world.step(DT);
    const k = kinetic(sim);
    peakKe = Math.max(peakKe, k.ke);
    peakSpeed = Math.max(peakSpeed, k.max);
  }
  const after = snapshot(sim);
  const byUid = new Map(after.map((s) => [s.uid, s]));
  let maxMove = 0;
  let sumMove = 0;
  let n = 0;
  for (const s of before) {
    if (s.uid === found[0].uid || s.uid === found[1].uid) continue;
    const t = byUid.get(s.uid);
    if (!t) continue;
    const d = Math.hypot(t.x - s.x, t.y - s.y);
    maxMove = Math.max(maxMove, d);
    sumMove += d; n++;
  }
  report('merge', 'merged tier', found[0].tier + 1, '');
  report('merge', 'KE before merge', keBefore);
  report('merge', 'peak KE after merge', peakKe);
  report('merge', 'peak speed after merge', peakSpeed, 'px/s');
  report('merge', 'max neighbour displacement', maxMove, 'px');
  report('merge', 'mean neighbour displacement', n ? sumMove / n : 0, 'px');
  const pen = penetration(sim);
  report('merge', 'max pair overlap', pen.pair, 'px');
}

/** Penetration under load: a heavy stack must not sink into itself. */
function suiteLoad() {
  console.log('\n[load] heavy column of big fruit');
  const sim = new Sim();
  const cx = (BOARD.left + BOARD.right) / 2;
  // Stack the big tiers directly, biggest at the bottom — the worst case for
  // an impulse solver, and exactly what a late-game jar looks like.
  let y = BOARD.floor;
  for (const tier of [9, 8, 7, 6, 5, 4, 3]) {
    y -= FRUITS[tier].radius;
    sim.world.spawn(tier, cx, y);
    y -= FRUITS[tier].radius;
  }
  sim.advance(6000);
  const pen = penetration(sim);
  const k = kinetic(sim);
  report('load', 'max pair overlap', pen.pair, 'px');
  report('load', 'max wall overlap', pen.wall, 'px');
  report('load', 'KE after 6s', k.ke);
  report('load', 'max speed after 6s', k.max, 'px/s');
}

/** Tunnelling: terminal-velocity drops must not pass through the floor. */
function suiteTunnel() {
  console.log('\n[tunnel] fast drops at the floor and walls');
  const sim = new Sim();
  let worstPen = 0;
  let lost = 0;
  for (let i = 0; i < 12; i++) {
    const tier = i % FRUITS.length;
    const rec = sim.world.spawn(tier, BOARD.left + 40 + (i * 23) % 180, BOARD.top + 10, { vy: 60, vx: (i % 3 - 1) * 40 });
    for (let s = 0; s < Math.round(3000 / DT); s++) {
      sim.world.step(DT);
      worstPen = Math.max(worstPen, penetration(sim).wall);
    }
    if (escaped(sim).length) lost++;
    sim.world.clear();
    void rec;
  }
  report('tunnel', 'worst wall penetration', worstPen, 'px');
  report('tunnel', 'escapes', lost, 'of 12');
}

/** Determinism: identical seed and script, bit-identical result. */
function suiteDeterminism() {
  console.log('\n[determinism] two identical runs');
  const run = () => {
    const sim = new Sim(0xbadc0de);
    buildPile(sim, 30);
    sim.advance(3000);
    return snapshot(sim);
  };
  const a = run();
  const b = run();
  let diff = 0;
  if (a.length !== b.length) diff = Infinity;
  else {
    for (let i = 0; i < a.length; i++) {
      if (a[i].uid !== b[i].uid || a[i].x !== b[i].x || a[i].y !== b[i].y || a[i].a !== b[i].a) diff++;
    }
  }
  report('determinism', 'bodies', a.length, '');
  report('determinism', 'mismatched bodies', diff, '');
}

/** Stability: a long run must not leak fruit or NaN. */
function suiteStability() {
  console.log('\n[stability] 200 drops');
  const sim = new Sim(0x51ab1e);
  let worstOut = 0;
  let nan = 0;
  for (let i = 0; i < 200; i++) {
    const span = BOARD.right - BOARD.left - 60;
    sim.drop(BOARD.left + 30 + ((i * 61) % span));
    sim.advance(DROP.cooldown);
    const e = escaped(sim);
    worstOut = Math.max(worstOut, e.filter((x) => x.why !== 'NaN').length);
    nan += e.filter((x) => x.why === 'NaN').length;
  }
  sim.advance(3000);
  const pen = penetration(sim);
  report('stability', 'merges', sim.merges.length, '');
  report('stability', 'bodies left', recs(sim).length, '');
  report('stability', 'escapes (peak concurrent)', worstOut, '');
  report('stability', 'NaN bodies', nan, '');
  report('stability', 'max pair overlap', pen.pair, 'px');
  report('stability', 'KE after 3s quiet', kinetic(sim).ke);
}

/** Rolling: fruit must nest, not roll like marbles. */
function suiteRoll() {
  console.log('\n[roll] single fruit released on a slope of two others');
  const sim = new Sim();
  const cx = (BOARD.left + BOARD.right) / 2;
  sim.world.spawn(5, cx - 24, BOARD.floor - 24);
  sim.world.spawn(5, cx + 24, BOARD.floor - 24);
  sim.advance(1500);
  const rec = sim.world.spawn(3, cx - 30, BOARD.floor - 90);
  let travel = 0;
  const x0 = rec.body.position.x;
  let ms = 0;
  while (ms < 5000) {
    sim.world.step(DT);
    ms += DT;
    travel = Math.max(travel, Math.abs(rec.body.position.x - x0));
    if (Math.hypot(rec.body.velocity.x, rec.body.velocity.y) * PER_S < 3 && ms > 800) break;
  }
  report('roll', 'time to stop', ms, 'ms');
  report('roll', 'lateral travel', travel, 'px');
  report('roll', 'total rotation', Math.abs(rec.body.angle), 'rad');
}

const SUITES = {
  residual: suiteResidual,
  settle: suiteSettle,
  merge: suiteMerge,
  load: suiteLoad,
  tunnel: suiteTunnel,
  roll: suiteRoll,
  determinism: suiteDeterminism,
  stability: suiteStability,
};

const only = process.argv.slice(2);
const t0 = Date.now();
for (const [name, fn] of Object.entries(SUITES)) {
  if (only.length && !only.includes(name)) continue;
  fn();
}
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (process.env.PROBE_JSON) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.PROBE_JSON, JSON.stringify(rows, null, 2));
}
