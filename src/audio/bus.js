/**
 * The master bus every voice in the game passes through.
 *
 *   voices -> dry ------------\
 *          \-> reverb -> wet --> master -> compressor -> limiter -> out
 *   music  -> musicGain ------/
 *
 * The compressor glues overlapping merges together; the waveshaper after it
 * is a true ceiling, because a compressor with a 3ms attack still lets the
 * first cycle of six simultaneous chimes through and that transient is
 * exactly what clips.
 */

/** Deterministic noise so a rendered probe is byte-comparable between runs. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * A small dark room, synthesised rather than shipped: exponentially decaying
 * noise, one-pole lowpassed so the tail loses its top end the way a real room
 * does. 1.6s is long enough to flatter a watermelon chime and short enough
 * that a fast merge chain does not turn into soup.
 */
function makeImpulse(ctx, seconds = 1.6, decay = 3.4) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const preDelay = Math.floor(ctx.sampleRate * 0.012);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rnd = lcg(0x9e3779b9 + ch * 0x85ebca6b);
    let lp = 0;
    for (let i = preDelay; i < len; i++) {
      const n = rnd() * 2 - 1;
      lp += (n - lp) * 0.34;
      d[i] = lp * Math.pow(1 - (i - preDelay) / (len - preDelay), decay);
    }
  }
  return buf;
}

/**
 * Soft ceiling. The curve is unity below 0.7 and asymptotes to 1.0, and the
 * 0.5 pre-gain means the table covers inputs up to +/-2.0 — a WaveShaper
 * clamps its index, so anything hotter than that still lands on 0.999 rather
 * than wrapping.
 */
function makeLimiterCurve(n = 2048) {
  const c = new Float32Array(n);
  const knee = 0.7;
  for (let i = 0; i < n; i++) {
    const u = ((i / (n - 1)) * 2 - 1) * 2;
    const a = Math.abs(u);
    c[i] = a <= knee
      ? u
      : Math.sign(u) * (knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
  }
  return c;
}

export function createBus(ctx, { master = 0.72, wet = 0.26, music = 0.3 } = {}) {
  const out = ctx.createGain();

  const limiter = ctx.createWaveShaper();
  limiter.curve = makeLimiterCurve();
  limiter.oversample = '4x';
  const preLimit = ctx.createGain();
  preLimit.gain.value = 0.5;
  const postLimit = ctx.createGain();
  postLimit.gain.value = 1;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -8;
  comp.knee.value = 10;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;

  const masterGain = ctx.createGain();
  masterGain.gain.value = master;

  masterGain.connect(comp).connect(preLimit).connect(limiter).connect(postLimit).connect(out);
  out.connect(ctx.destination);

  const dry = ctx.createGain();
  dry.gain.value = 1;
  dry.connect(masterGain);

  const reverb = ctx.createConvolver();
  reverb.buffer = makeImpulse(ctx);
  const wetGain = ctx.createGain();
  wetGain.gain.value = wet;
  reverb.connect(wetGain).connect(masterGain);

  const musicGain = ctx.createGain();
  musicGain.gain.value = music;
  musicGain.connect(masterGain);

  return {
    ctx,
    dry,
    reverb,
    wet: wetGain,
    music: musicGain,
    master: masterGain,
    compressor: comp,
    out,
    /** Route one voice: `amount` of it into the room, the rest straight through. */
    send(node, amount = 0) {
      node.connect(dry);
      if (amount > 0) {
        const s = ctx.createGain();
        s.gain.value = amount;
        node.connect(s).connect(reverb);
      }
    },
  };
}
