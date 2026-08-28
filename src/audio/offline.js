/**
 * Offline rendering harness for the sound design.
 *
 * Nothing here runs during play. It exists so `tools/audio-probe.mjs` can push
 * a scripted list of game events through the *production* engine inside an
 * OfflineAudioContext and measure what comes out — peak, decay, spectrum —
 * instead of anyone guessing whether a mix balances.
 */
import { createBus } from './bus.js';
import { AudioEngine } from './engine.js';
import { BAR_SEC } from './music.js';

function toBase64(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function dispatch(engine, e) {
  switch (e.type) {
    case 'merge': return engine.merge(e.t, e);
    case 'drop': return engine.drop(e.t, e);
    case 'impact': return engine.impact(e.t, e);
    case 'danger': return engine.dangerAt(e.t, e.ratio ?? 0);
    case 'watermelon': return engine.watermelon(e.t);
    case 'gameover': return engine.gameOver(e.t);
    case 'reset': return engine.reset(e.t);
    default: throw new Error(`unknown audio event ${e.type}`);
  }
}

/**
 * @param {object} spec
 * @param {number} spec.duration      seconds to render
 * @param {Array}  spec.events        {type, t, ...payload}, times in seconds
 * @param {boolean} spec.music        run the ambient bed underneath
 * @returns {Promise<{sampleRate:number,length:number,admitted:number,offered:number,b64:string}>}
 */
export async function renderOffline({
  sampleRate = 44100, duration = 3, events = [], music = false, bus: busOpts,
} = {}) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const length = Math.ceil(duration * sampleRate);
  const ctx = new OAC(2, length, sampleRate);
  const bus = createBus(ctx, busOpts);
  const engine = new AudioEngine(ctx, { bus });

  if (music) {
    engine.setMusic(true, 0);
    for (let t = 0; t < duration + BAR_SEC; t += BAR_SEC) engine.pump(t);
  }

  let admitted = 0;
  let offered = 0;
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.type === 'impact') {
      offered++;
      if (dispatch(engine, e)) admitted++;
    } else {
      dispatch(engine, e);
    }
  }

  const buf = await ctx.startRendering();
  const out = new Float32Array(buf.length * 2);
  out.set(buf.getChannelData(0), 0);
  out.set(buf.getChannelData(1), buf.length);
  return { sampleRate, length: buf.length, admitted, offered, b64: toBase64(out) };
}
