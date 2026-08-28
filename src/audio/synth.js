/**
 * Every voice in the game, as pure scheduling functions.
 *
 * Each one takes an AudioContext and a bus and schedules itself at an
 * absolute `t`, touching no module state. That is what lets the same code run
 * live and inside an OfflineAudioContext for measurement — and it is why no
 * voice can leak: everything it creates is stopped at a time computed here.
 */
import {
  degreeHz, semiHz, mergeVoicing, CADENCE, CADENCE_CHORD,
  FANFARE_RUN, FANFARE_CHORD, FANFARE_NOTE_SEC,
} from './theory.js';

const SILENT = 0.0001;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** One shared noise table per context; regenerating it per burst is the kind
 *  of hidden cost that shows up as a hitch during a busy pile-up. */
const NOISE = new WeakMap();
function noiseBuffer(ctx) {
  let buf = NOISE.get(ctx);
  if (buf) return buf;
  const len = Math.floor(ctx.sampleRate * 2);
  buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = 0x1234567 >>> 0;
  for (let i = 0; i < len; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    d[i] = (s / 2147483648) - 1;
  }
  NOISE.set(ctx, buf);
  return buf;
}

/**
 * A struck partial: exponential decay, optional pitch bend into the note.
 * `bend` is a multiplier the pitch falls *from*, which is most of what makes
 * a sine read as "struck" instead of "switched on".
 */
function ping(ctx, bus, t, {
  freq, amp, decay, type = 'sine', send = 0, attack = 0.004, bend = 1, bendTime = 0.03, detune = 0,
}) {
  if (amp <= 0 || freq <= 0) return;
  const o = ctx.createOscillator();
  o.type = type;
  o.detune.value = detune;
  o.frequency.setValueAtTime(freq * bend, t);
  if (bend !== 1) o.frequency.exponentialRampToValueAtTime(freq, t + bendTime);
  const g = ctx.createGain();
  g.gain.setValueAtTime(SILENT, t);
  g.gain.exponentialRampToValueAtTime(amp, t + attack);
  g.gain.exponentialRampToValueAtTime(SILENT, t + attack + decay);
  o.connect(g);
  bus.send(g, send);
  o.start(t);
  o.stop(t + attack + decay + 0.02);
}

/** Filtered noise burst. Used for every transient, thud and whoosh. */
function noise(ctx, bus, t, {
  dur, amp, type = 'bandpass', freq, freqEnd = null, q = 1, send = 0, attack = 0.002, playback = 1,
}) {
  if (amp <= 0) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.playbackRate.value = playback;
  src.loop = true;
  // Start at a different point each burst so repeated impacts are not the
  // identical waveform, which is what makes a run of them sound like a loop.
  const off = (Math.abs(Math.sin(t * 1234.567)) * 1.8) % 1.8;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(SILENT, t);
  g.gain.exponentialRampToValueAtTime(amp, t + attack);
  g.gain.exponentialRampToValueAtTime(SILENT, t + attack + dur);
  src.connect(f).connect(g);
  bus.send(g, send);
  src.start(t, off);
  src.stop(t + attack + dur + 0.02);
}

/* ------------------------------------------------------------------ *
 * Merge — the signature sound.
 * ------------------------------------------------------------------ */

/**
 * Bell-ish inharmonic ratios. Exact integers ring like an organ; nudging the
 * upper partials sharp is what reads as "struck object" to the ear.
 */
const PARTIALS = [
  { r: 1,     a: 1.00, d: 1.00 },
  { r: 2.01,  a: 0.42, d: 0.58 },
  { r: 3.02,  a: 0.20, d: 0.36 },
  { r: 4.17,  a: 0.10, d: 0.22 },
  { r: 5.43,  a: 0.05, d: 0.14 },
];

export function renderMerge(ctx, bus, t, { tier = 0, combo = 1, isNew = false, level = 1 } = {}) {
  const big = clamp(tier / 10, 0, 1);
  const { degree: deg, folds } = mergeVoicing(tier, combo);
  const f = degreeHz(deg);
  // Big fruit ring; a cherry is a tick with a pitch. The 4.5x spread across
  // the chain is doing as much work as the pitch mapping is.
  const dur = 0.24 + big * 1.05;
  const chain = clamp((combo - 1) / 4, 0, 1);
  const send = 0.14 + big * 0.30 + chain * 0.10;
  // Low chimes need more amplitude for the same loudness, and the top of the
  // chain is shrill enough that it wants pulling back.
  // Chimes get quieter as they climb: equal amplitude at 3.5kHz is painful
  // next to the same amplitude at 200Hz.
  const bright = Math.pow(2, -Math.max(0, deg - 16) * 0.10);
  const amp = level * (0.88 + big * 0.26 - big * big * 0.38) * bright;

  // Transient: a noise chiff tuned off the fundamental so it belongs to the
  // note rather than sitting on top of it as a separate "tsk".
  noise(ctx, bus, t, {
    dur: 0.016 + big * 0.02,
    amp: amp * (0.30 - big * 0.13),
    freq: clamp(f * 3.4, 700, 6200),
    freqEnd: clamp(f * 1.6, 350, 3000),
    q: 0.9,
    attack: 0.001,
    send: send * 0.4,
  });

  for (const p of PARTIALS) {
    // A partial up here is inaudible on every speaker a browser game reaches;
    // scheduling it only costs voices during a pile-up.
    if (f * p.r > 15000) continue;
    // Small fruit keep their upper partials (bright, light); the watermelon
    // sheds them so what is left is fundamental and body.
    const tilt = p.r === 1 ? 1 : 1 - big * 0.35;
    ping(ctx, bus, t, {
      freq: f * p.r,
      amp: amp * 0.30 * p.a * tilt,
      decay: dur * p.d,
      send: p.r === 1 ? send : send * 0.6,
      attack: 0.003,
      bend: p.r === 1 ? 1.04 : 1,
      bendTime: 0.022,
    });
  }

  // A twin a few cents sharp, two hundredths of a second late: the beating
  // between them is the difference between "chime" and "sine wave".
  ping(ctx, bus, t + 0.018, {
    freq: f, amp: amp * 0.11, decay: dur * 0.8, detune: 7, send,
  });

  // Sub-octave body, but only where it lands somewhere a speaker can
  // reproduce. Under a cherry it is mud; under a watermelon it is 55Hz, which
  // laptop speakers simply do not emit — it would cost headroom for nothing.
  if (big > 0.45 && f * 0.5 >= 68) {
    ping(ctx, bus, t, {
      freq: f * 0.5,
      amp: amp * 0.18 * (big - 0.45) / 0.55,
      decay: dur * 0.85,
      bend: 1.5,
      bendTime: 0.05,
      send: send * 0.5,
    });
  }

  // Long chains get a grace note under the beat.
  if (combo >= 3) {
    ping(ctx, bus, t - 0.045, {
      freq: degreeHz(deg - 2), amp: amp * 0.10, decay: 0.09, send: send * 0.7,
    });
  }

  // Every octave the run has folded stacks another voice below, so a chain
  // that has already climbed once comes back wider instead of just repeating.
  for (let i = 1; i <= Math.min(folds, 3); i++) {
    ping(ctx, bus, t, {
      freq: degreeHz(deg - 5 * i), amp: amp * 0.13 / i, decay: dur * (0.7 + i * 0.2), send,
    });
  }

  // First sighting of a tier: a two-note sparkle a fifth and an octave up.
  if (isNew) {
    ping(ctx, bus, t + 0.09, { freq: degreeHz(deg + 3), amp: amp * 0.09, decay: 0.18, send: 0.4 });
    ping(ctx, bus, t + 0.17, { freq: degreeHz(deg + 5), amp: amp * 0.07, decay: 0.30, send: 0.5 });
  }
}

/* ------------------------------------------------------------------ *
 * Drop — claw release.
 * ------------------------------------------------------------------ */

export function renderDrop(ctx, bus, t, { tier = 0 } = {}) {
  const big = clamp(tier / 10, 0, 1);
  // Mechanical click: a tight resonant tick, not a noise puff.
  noise(ctx, bus, t, {
    dur: 0.014, amp: 0.34, freq: 2600 - big * 1300, q: 4, attack: 0.0008, send: 0.06,
  });
  ping(ctx, bus, t, {
    freq: 430 - big * 170, amp: 0.16, decay: 0.04, type: 'triangle', bend: 1.8, bendTime: 0.02,
  });
  // The release itself: a soft downward whoosh, deliberately quiet — this
  // fires every 420ms at most and a loud one would wear a hole in the player.
  noise(ctx, bus, t + 0.01, {
    dur: 0.19, amp: 0.10 + big * 0.05, freq: 1700 - big * 500, freqEnd: 300, q: 1.1, attack: 0.03, send: 0.1,
  });
}

/* ------------------------------------------------------------------ *
 * Impact.
 * ------------------------------------------------------------------ */

export function renderImpact(ctx, bus, t, { speed = 2, tier = 0, level = 1 } = {}) {
  const big = clamp(tier / 10, 0, 1);
  const v = clamp((speed - 1.2) / 11, 0, 1);
  const amp = level * (0.085 + Math.pow(v, 1.25) * 0.28) * (0.8 + big * 0.4);
  // Bigger fruit are darker: the lowpass moves an octave and a half down
  // across the chain, which is the whole "heavier" cue.
  const cut = (1500 - big * 1050) + v * 900;
  noise(ctx, bus, t, {
    dur: 0.028 + big * 0.05,
    amp: amp * 0.9,
    type: 'lowpass',
    freq: cut,
    freqEnd: cut * 0.35,
    q: 0.7,
    attack: 0.0012,
    send: 0.05 + big * 0.06,
  });
  // Pitched body so a thud has a size, not just a colour.
  ping(ctx, bus, t, {
    freq: 70 + (1 - big) * 118,
    amp: amp * 0.65,
    decay: 0.045 + big * 0.13,
    bend: 1.7,
    bendTime: 0.035,
    attack: 0.0015,
    send: 0.04,
  });
}

/* ------------------------------------------------------------------ *
 * Danger — a bed that tracks `ratio` and resolves when it clears.
 * ------------------------------------------------------------------ */

export function createDangerBed(ctx, bus, t) {
  const out = ctx.createGain();
  out.gain.setValueAtTime(SILENT, t);
  bus.send(out, 0.3);

  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.setValueAtTime(240, t);
  filt.Q.value = 2.4;

  // Tremolo deepens and speeds up with the ratio; a steady drone reads as
  // ambience, a pulsing one reads as a countdown.
  const trem = ctx.createGain();
  trem.gain.setValueAtTime(1, t);
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.setValueAtTime(3, t);
  const lfoAmt = ctx.createGain();
  lfoAmt.gain.setValueAtTime(0.05, t);
  lfo.connect(lfoAmt).connect(trem.gain);

  filt.connect(trem).connect(out);

  // Root, a cent-detuned twin, and the fifth: the tonic power chord of the
  // key, so the bed never argues with a merge landing on top of it.
  const oscs = [
    { hz: semiHz(0), type: 'sawtooth', g: 0.34, det: -6 },
    { hz: semiHz(0), type: 'sawtooth', g: 0.30, det: 8 },
    { hz: semiHz(7), type: 'sawtooth', g: 0.20, det: 0 },
    { hz: semiHz(24), type: 'triangle', g: 0.10, det: 4 },
  ].map(({ hz, type, g, det }) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, t);
    o.detune.value = det;
    const vg = ctx.createGain();
    vg.gain.value = g;
    o.connect(vg).connect(filt);
    o.start(t);
    return o;
  });
  lfo.start(t);

  let dead = false;
  return {
    setRatio(r, when) {
      if (dead) return;
      const k = clamp(r, 0, 1);
      out.gain.cancelScheduledValues(when);
      out.gain.setTargetAtTime(Math.max(SILENT, 0.010 + k * 0.042), when, 0.12);
      filt.frequency.setTargetAtTime(240 + k * k * 1500, when, 0.15);
      lfo.frequency.setTargetAtTime(3 + k * 7, when, 0.2);
      lfoAmt.gain.setTargetAtTime(0.05 + k * 0.4, when, 0.2);
    },
    /** Relief: the bed falls away and a two-note figure lands on the tonic. */
    release(when) {
      if (dead) return;
      dead = true;
      out.gain.cancelScheduledValues(when);
      out.gain.setTargetAtTime(SILENT, when, 0.14);
      filt.frequency.cancelScheduledValues(when);
      filt.frequency.setTargetAtTime(160, when, 0.2);
      for (const o of oscs) o.stop(when + 0.8);
      lfo.stop(when + 0.8);
      ping(ctx, bus, when, { freq: semiHz(19), amp: 0.09, decay: 0.28, send: 0.35 });
      ping(ctx, bus, when + 0.11, { freq: semiHz(12), amp: 0.10, decay: 0.5, send: 0.4 });
    },
    stop(when) {
      if (dead) return;
      dead = true;
      out.gain.cancelScheduledValues(when);
      out.gain.setTargetAtTime(SILENT, when, 0.06);
      for (const o of oscs) o.stop(when + 0.4);
      lfo.stop(when + 0.4);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Watermelon fanfare.
 * ------------------------------------------------------------------ */

export function renderWatermelon(ctx, bus, t) {
  // Riser into the downbeat, so the fanfare arrives rather than starts.
  noise(ctx, bus, t - 0.18, {
    dur: 0.2, amp: 0.05, freq: 400, freqEnd: 4200, q: 1.4, attack: 0.12, send: 0.3,
  });

  FANFARE_RUN.forEach((deg, i) => {
    const when = t + i * FANFARE_NOTE_SEC;
    const f = degreeHz(deg);
    // Each note decays inside its own slot, so the run reads as six notes
    // rather than one thickening chord.
    ping(ctx, bus, when, { freq: f, amp: 0.17, decay: 0.26, send: 0.3, bend: 1.03 });
    ping(ctx, bus, when, { freq: f * 2.01, amp: 0.05, decay: 0.14, send: 0.2 });
    noise(ctx, bus, when, { dur: 0.012, amp: 0.05, freq: clamp(f * 3, 800, 6000), q: 1, attack: 0.001 });
  });

  const hit = t + FANFARE_RUN.length * FANFARE_NOTE_SEC + 0.06;
  for (const { semi, gain, decay } of FANFARE_CHORD) {
    const f = semiHz(semi);
    ping(ctx, bus, hit, { freq: f, amp: gain, decay, send: 0.5, bend: 1.02 });
    ping(ctx, bus, hit + 0.02, { freq: f * 2.01, amp: gain * 0.3, decay: decay * 0.45, send: 0.4 });
  }
  noise(ctx, bus, hit, { dur: 0.05, amp: 0.14, freq: 3000, freqEnd: 700, q: 0.8, attack: 0.001, send: 0.3 });
  // Two shimmering octaves above the chord, entering late and outlasting the
  // root: they are what keeps the tail of the fanfare bright.
  ping(ctx, bus, hit + 0.10, { freq: semiHz(36), amp: 0.075, decay: 1.7, send: 0.6 });
  ping(ctx, bus, hit + 0.20, { freq: semiHz(43), amp: 0.055, decay: 1.5, send: 0.7 });
}

/* ------------------------------------------------------------------ *
 * Game over.
 * ------------------------------------------------------------------ */

export function renderGameOver(ctx, bus, t) {
  CADENCE.forEach((semi, i) => {
    const when = t + i * 0.3;
    const f = semiHz(semi);
    ping(ctx, bus, when, {
      freq: f, amp: 0.15, decay: 0.55, type: 'triangle', attack: 0.02, send: 0.35,
    });
    ping(ctx, bus, when, { freq: f * 2, amp: 0.035, decay: 0.3, attack: 0.02, send: 0.25 });
  });

  // The chord lands where the fourth note would have resolved.
  const hit = t + CADENCE.length * 0.3 + 0.12;
  CADENCE_CHORD.forEach((semi, i) => {
    const f = semiHz(semi);
    ping(ctx, bus, hit + i * 0.035, {
      freq: f,
      amp: 0.16 / (1 + i * 0.45),
      decay: 2.3 - i * 0.2,
      type: i === 0 ? 'sine' : 'triangle',
      attack: 0.03,
      send: 0.55,
    });
  });
  // One last low swell under it — the run is over, let it feel heavy.
  ping(ctx, bus, hit, { freq: semiHz(-12), amp: 0.11, decay: 1.8, attack: 0.06, send: 0.2 });
}
