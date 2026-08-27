/** Procedural SFX. BASELINE — owned by the audio pass. */
export class Audio {
  constructor() { this.ctx = null; this.enabled = true; }
  _ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx?.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  blip(freq, dur = 0.08, type = 'square', gain = 0.08) {
    if (!this.enabled) return;
    const ctx = this._ensure();
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, ctx.currentTime);
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + dur);
  }
  merge(tier) { this.blip(220 + tier * 55, 0.12, 'square', 0.07); }
  drop() { this.blip(180, 0.06, 'triangle', 0.05); }
  impact(speed) { this.blip(90 + speed * 4, 0.04, 'sine', Math.min(0.05, speed * 0.006)); }
  over() { this.blip(110, 0.5, 'sawtooth', 0.06); }
}
