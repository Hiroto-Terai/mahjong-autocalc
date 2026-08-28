/**
 * Ambient bed: a four-bar generative loop in the same A minor everything else
 * lives in.
 *
 * The rules it plays by are all about staying out of the way — the pad sits
 * under 1kHz where no SFX has its body, the lead only ever plays pentatonic
 * degrees the merge chimes also use, and nothing here has a transient, so it
 * never competes for the attack the player is actually listening for.
 */
import { PROGRESSION, semiHz, degreeHz } from './theory.js';

/** 72bpm, 4/4. Slow enough that a bar change is a mood, not a beat. */
export const BAR_SEC = (60 / 72) * 4;

const SILENT = 0.0001;

function pad(ctx, bus, t, semi, gain) {
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = semiHz(semi);
  o.detune.value = (semi % 3) * 4 - 4;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 780;
  f.Q.value = 0.5;
  const g = ctx.createGain();
  const rel = BAR_SEC * 0.55;
  g.gain.setValueAtTime(SILENT, t);
  g.gain.exponentialRampToValueAtTime(gain, t + BAR_SEC * 0.42);
  g.gain.setValueAtTime(gain, t + BAR_SEC * 0.62);
  g.gain.exponentialRampToValueAtTime(SILENT, t + BAR_SEC * 0.62 + rel);
  o.connect(f).connect(g).connect(bus.music);
  o.start(t);
  o.stop(t + BAR_SEC * 0.62 + rel + 0.05);
}

function pluck(ctx, bus, t, freq, gain, decay) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = freq;
  const h = ctx.createOscillator();
  h.type = 'sine';
  h.frequency.value = freq * 2.01;
  const hg = ctx.createGain();
  hg.gain.value = 0.22;
  const g = ctx.createGain();
  g.gain.setValueAtTime(SILENT, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.03);
  g.gain.exponentialRampToValueAtTime(SILENT, t + 0.03 + decay);
  o.connect(g);
  h.connect(hg).connect(g);
  const send = ctx.createGain();
  send.gain.value = 0.5;
  g.connect(bus.music);
  g.connect(send).connect(bus.reverb);
  o.start(t); h.start(t);
  o.stop(t + decay + 0.1); h.stop(t + decay + 0.1);
}

/** Beat positions a lead note may land on. Off-beats only, so the bed never
 *  implies a tempo the player is expected to act on. */
const LEAD_SLOTS = [0.5, 1.5, 2.0, 2.5, 3.5];

export function scheduleBar(ctx, bus, t, index, rnd) {
  const chord = PROGRESSION[index % PROGRESSION.length];

  for (let i = 0; i < chord.triad.length; i++) {
    pad(ctx, bus, t + i * 0.03, chord.triad[i] + 12, 0.085 / (1 + i * 0.2));
  }
  pluck(ctx, bus, t, semiHz(chord.bass), 0.10, 1.9);

  // One or two lead notes a bar, always a chord tone or its pentatonic
  // neighbour, so the melody cannot land outside the harmony.
  const notes = rnd() < 0.35 ? 2 : 1;
  const used = new Set();
  for (let n = 0; n < notes; n++) {
    let slot = LEAD_SLOTS[Math.floor(rnd() * LEAD_SLOTS.length)];
    if (used.has(slot)) slot = LEAD_SLOTS[(LEAD_SLOTS.indexOf(slot) + 2) % LEAD_SLOTS.length];
    used.add(slot);
    const deg = 10 + Math.floor(rnd() * 5) + (chord.colour % 2);
    pluck(ctx, bus, t + slot * (BAR_SEC / 4), degreeHz(deg), 0.06, 1.1);
  }
}

/** Schedule `bars` bars in one go. The offline probe renders the bed this way. */
export function scheduleMusic(ctx, bus, t0, bars, seed = 0xc0ffee) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < bars; i++) scheduleBar(ctx, bus, t0 + i * BAR_SEC, i, rnd);
}

/**
 * Live driver. Keeps roughly two bars queued ahead of the playhead so the
 * loop survives a stalled tab without a gap, and stops cleanly on demand.
 */
export class AmbientMusic {
  constructor(ctx, bus, seed = 0xc0ffee) {
    this.ctx = ctx;
    this.bus = bus;
    this.bar = 0;
    this.next = 0;
    this.playing = false;
    let s = seed >>> 0;
    this.rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  start(t) {
    if (this.playing) return;
    this.playing = true;
    this.next = t + 0.05;
    this.bus.music.gain.cancelScheduledValues(t);
    this.bus.music.gain.setTargetAtTime(this.level ?? 0.3, t, 0.6);
    this.pump(t);
  }

  /** Fade rather than cut: an ambient bed that stops on a frame boundary is
   *  more noticeable than one that was never there. */
  stop(t) {
    if (!this.playing) return;
    this.playing = false;
    this.level = this.bus.music.gain.value;
    this.bus.music.gain.cancelScheduledValues(t);
    this.bus.music.gain.setTargetAtTime(SILENT, t, 0.5);
  }

  pump(now) {
    if (!this.playing) return;
    while (this.next < now + BAR_SEC * 2) {
      scheduleBar(this.ctx, this.bus, this.next, this.bar++, this.rnd);
      this.next += BAR_SEC;
    }
  }
}
