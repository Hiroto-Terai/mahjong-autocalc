import { AudioEngine } from './engine.js';
import { renderOffline } from './offline.js';

/**
 * Procedural SFX front end.
 *
 * Owns only lifecycle: it translates game events into engine calls at wall
 * clock times, and it is careful about when the WebAudio context comes into
 * existence. Constructing one before a gesture leaves it `suspended` forever
 * in Chrome and the game ships silent, so the context is built on the first
 * sound or the first gesture, whichever lands first.
 *
 * All synthesis lives in engine/synth/music, which know nothing about the
 * game — see offline.js for why that split matters.
 */
export class Audio {
  constructor(appCtx) {
    this.app = appCtx;
    /** WebAudio context, created lazily on first sound (autoplay policy). */
    this.ctx = null;
    this.engine = null;
    this._enabled = true;
    this.muted = localStorage.getItem('fc.mute') === '1';
    /** Ambient bed is opt-in: `?music=1`, the N key, or setMusic(). */
    this.musicOn = appCtx.params?.get?.('music') === '1';

    const ev = appCtx.events;
    ev.on('merge', (m) => this._at((e, t) => e.merge(t, m)));
    ev.on('drop', (d) => this._at((e, t) => e.drop(t, d)));
    ev.on('impact', (i) => this._at((e, t) => e.impact(t, i)));
    ev.on('danger', (d) => this._at((e, t) => e.dangerAt(t, d.ratio)));
    ev.on('watermelon', () => this._at((e, t) => e.watermelon(t)));
    ev.on('gameover', () => this._at((e, t) => e.gameOver(t)));
    ev.on('reset', () => this._onReset());

    this._bindGestures();
    // The offline probe drives the engine through this; it is the only reason
    // anything about the mix is a measured number rather than an opinion.
    if (typeof window !== 'undefined') window.__audio = this;
  }

  get enabled() { return this._enabled; }

  set enabled(v) {
    this._enabled = !!v;
    if (!v && this.engine) {
      const t = this.ctx.currentTime;
      this.engine.reset(t);
      this.engine.setMusic(false, t);
      this._stopPump();
    }
  }

  /* -------------------------------------------------------------- *
   * Context lifecycle.
   * -------------------------------------------------------------- */

  _bindGestures() {
    if (typeof window === 'undefined') return;
    const wake = () => {
      if (!this._enabled) return;
      this._ensure();
      if (this.musicOn) this._startMusic();
    };
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(type, wake, { passive: true });
    }
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM') this.setMuted(!this.muted);
      if (e.code === 'KeyN') this.setMusic(!this.musicOn);
    });
  }

  _ensure() {
    if (!this._enabled) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.engine = new AudioEngine(this.ctx);
      this._applyMute();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /** Schedule a hair ahead of now: exactly-at-currentTime envelopes lose
   *  their attack ramp and the sound arrives as a click. */
  _at(fn) {
    if (!this._enabled || this.muted) return;
    const ctx = this._ensure();
    if (!ctx) return;
    fn(this.engine, ctx.currentTime + 0.005);
  }

  _onReset() {
    if (!this.engine) return;
    this.engine.reset(this.ctx.currentTime);
    if (this.musicOn && this._enabled && !this.muted) this._startMusic();
  }

  /* -------------------------------------------------------------- *
   * Player-facing switches.
   * -------------------------------------------------------------- */

  setMuted(muted) {
    this.muted = !!muted;
    localStorage.setItem('fc.mute', this.muted ? '1' : '0');
    this._applyMute();
  }

  _applyMute() {
    if (!this.engine) return;
    const t = this.ctx.currentTime;
    // Ramp, never a hard set: cutting a ringing bus to zero is itself a click.
    this.engine.bus.master.gain.cancelScheduledValues(t);
    this.engine.bus.master.gain.setTargetAtTime(this.muted ? 0.0001 : 0.72, t, 0.02);
  }

  setMusic(on) {
    this.musicOn = !!on;
    if (this.musicOn) this._startMusic();
    else if (this.engine) {
      this.engine.setMusic(false, this.ctx.currentTime);
      this._stopPump();
    }
  }

  _startMusic() {
    const ctx = this._ensure();
    if (!ctx || this.engine.music.playing) return;
    this.engine.setMusic(true, ctx.currentTime + 0.05);
    // The bed is scheduled two bars ahead, so a lazy poll is enough and the
    // render loop stays out of the audio thread's business.
    this._pump = setInterval(() => this.engine.pump(this.ctx.currentTime), 400);
  }

  _stopPump() {
    clearInterval(this._pump);
    this._pump = null;
  }

  /** Test surface — renders the production engine into an OfflineAudioContext. */
  renderOffline(spec) { return renderOffline(spec); }
}
