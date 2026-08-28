/**
 * Mixing brain. Owns a bus and the state that voices cannot own themselves —
 * the impact rate limiter, the merge density duck, the danger bed handle and
 * the music driver.
 *
 * Every method takes an explicit `when`, so the same engine drives a live
 * AudioContext and an OfflineAudioContext with identical behaviour. That is
 * what makes the gating measurable rather than a thing you hope works.
 */
import { createBus } from './bus.js';
import {
  renderMerge, renderDrop, renderImpact, renderWatermelon, renderGameOver, createDangerBed,
} from './synth.js';
import { AmbientMusic } from './music.js';

/**
 * Token bucket with a minimum gap. A pile settling in the jar fires dozens of
 * `impact`s a second; without this it machine-guns, and simply dropping the
 * extras makes the pile sound dead. So the bucket also returns a *level*:
 * the first hit is full, the tail of a burst fades to a rustle.
 */
export class RateGate {
  constructor({ minInterval = 0.042, capacity = 5, refill = 8 } = {}) {
    this.minInterval = minInterval;
    this.capacity = capacity;
    this.refill = refill;
    this.tokens = capacity;
    this.last = -1e9;
    this.clock = -1e9;
    this.lastStrength = 0;
  }

  reset(when = -1e9) {
    this.tokens = this.capacity;
    this.last = -1e9;
    this.clock = when;
    this.lastStrength = 0;
  }

  /** @returns {number} 0 to reject, otherwise a level multiplier in (0,1]. */
  admit(when, strength = 0) {
    if (when > this.clock) {
      this.tokens = Math.min(this.capacity, this.tokens + (when - this.clock) * this.refill);
      this.clock = when;
    }
    const gap = when - this.last;
    // A genuinely bigger hit than the one that just gated us gets through
    // early — otherwise a heavy fruit landing mid-rustle is silent.
    const override = strength > this.lastStrength * 1.9 && gap > this.minInterval * 0.45;
    if (gap < this.minInterval && !override) return 0;
    if (this.tokens < 1) return 0;
    this.tokens -= 1;
    this.last = when;
    this.lastStrength = strength;
    return 0.5 + 0.5 * (this.tokens / this.capacity);
  }
}

export class AudioEngine {
  constructor(ctx, { bus, music = false, musicSeed = 0xc0ffee } = {}) {
    this.ctx = ctx;
    this.bus = bus || createBus(ctx);
    this.gate = new RateGate();
    this.danger = null;
    this.dangerRatio = 0;
    this.mergeTimes = [];
    this.music = new AmbientMusic(ctx, this.bus, musicSeed);
    this.bus.music.gain.value = 0;
    if (music) this.music.start(0);
  }

  /** How hard to pull a voice back given how much is already ringing. */
  _density(when, window = 0.32) {
    const t = this.mergeTimes;
    while (t.length && when - t[0] > window) t.shift();
    return 1 / (1 + t.length * 0.24);
  }

  merge(when, { tier = 0, combo = 1, isNew = false } = {}) {
    const level = this._density(when);
    this.mergeTimes.push(when);
    renderMerge(this.ctx, this.bus, when, { tier, combo, isNew, level });
    // Duck the bed under the chime so the two never smear together.
    this._duckMusic(when, 0.55, 0.5);
  }

  drop(when, payload = {}) {
    renderDrop(this.ctx, this.bus, when, payload);
  }

  impact(when, { speed = 2, tier = 0 } = {}) {
    const strength = speed * (1 + tier * 0.12);
    const level = this.gate.admit(when, strength);
    if (!level) return false;
    renderImpact(this.ctx, this.bus, when, { speed, tier, level });
    return true;
  }

  dangerAt(when, ratio) {
    if (ratio > 0.02) {
      if (!this.danger) this.danger = createDangerBed(this.ctx, this.bus, when);
      this.danger.setRatio(ratio, when);
      this._duckMusic(when, 0.35, 1.2);
    } else if (this.danger) {
      this.danger.release(when);
      this.danger = null;
    }
    this.dangerRatio = ratio;
  }

  watermelon(when) {
    renderWatermelon(this.ctx, this.bus, when);
    this._duckMusic(when, 0.25, 2.2);
  }

  gameOver(when) {
    if (this.danger) { this.danger.stop(when); this.danger = null; }
    renderGameOver(this.ctx, this.bus, when);
    this.music.stop(when);
  }

  reset(when) {
    if (this.danger) { this.danger.stop(when); this.danger = null; }
    this.gate.reset(when);
    this.mergeTimes.length = 0;
  }

  setMusic(on, when) {
    if (on) this.music.start(when);
    else this.music.stop(when);
  }

  pump(now) {
    this.music.pump(now);
  }

  /** Momentary dip on the music bus. Uses setTargetAtTime both ways so it
   *  never fights a concurrent duck from another event. */
  _duckMusic(when, depth, recover) {
    if (!this.music.playing) return;
    const g = this.bus.music.gain;
    const base = this.music.level ?? 0.3;
    g.cancelScheduledValues(when);
    g.setTargetAtTime(base * depth, when, 0.04);
    g.setTargetAtTime(base, when + 0.12, recover / 3);
  }
}
