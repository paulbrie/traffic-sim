/**
 * The helicopter's sound, made in the browser (Web Audio, no recordings): the blades' beat (noise pulsed
 * at the blade rate, with a low thump) and the engine's low rumble, no turbine whine. `set` follows the
 * flight: harder work (speed, climbing) beats faster and louder. War mode adds the guns, rounds striking the
 * airframe, and explosions.
 */
export class RotorSound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private beat: OscillatorNode | null = null;
  private chop: GainNode | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private on = false;
  private noiseBuf: AudioBuffer | null = null;

  /** start (or resume) the sound, fading in */
  start() {
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    if (ctx.state === "suspended") void ctx.resume();
    this.on = true;
    this.master!.gain.setTargetAtTime(0.5, ctx.currentTime, 0.4);
  }

  /** fade out and pause (the next start resumes) */
  stop() {
    if (!this.ctx || !this.on) return;
    this.on = false;
    const ctx = this.ctx;
    this.master!.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
    setTimeout(() => { if (!this.on && ctx.state === "running") void ctx.suspend(); }, 1500);
  }

  /** load: 0 hovering … 1 flat out; outside: heard from outside (more beat) */
  set(load: number, outside: boolean) {
    if (!this.ctx || !this.on) return;
    const t = this.ctx.currentTime, l = Math.max(0, Math.min(1, load));
    this.beat!.frequency.setTargetAtTime(9.5 + l * 2.5, t, 0.6);
    this.chop!.gain.setTargetAtTime((outside ? 0.9 : 0.55) * (0.65 + 0.35 * l), t, 0.3);
  }

  /** a round from the gun: a sharp crack (`level` below 1: someone else's gun, further off) */
  shot(level = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.on || !this.noiseBuf) return;
    const t = ctx.currentTime, src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.playbackRate.value = 1.3;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35 * level, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    src.connect(hp).connect(g).connect(this.master!);
    src.start(t, Math.random()); src.stop(t + 0.09);
    // and a low punch
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.06);
    og.gain.setValueAtTime(0.4 * level, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o.connect(og).connect(this.master!); o.start(t); o.stop(t + 0.1);
  }

  /** a round striking the airframe: a sharp metallic clank, the panel ringing for a moment, a thud through the cabin */
  hit() {
    const ctx = this.ctx;
    if (!ctx || !this.on || !this.noiseBuf) return;
    // (no two alike: a little higher or lower each time, as rounds strike different panels)
    const t = ctx.currentTime, p = 0.8 + Math.random() * 0.4;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 2600 * p; bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(bp).connect(g).connect(this.master!);
    src.start(t, Math.random()); src.stop(t + 0.06);
    // the ringing: a few partials, not in harmony (sheet metal, not a bell), the high ones dying first
    for (const [f, a, d] of [[410, 0.3, 0.2], [1130, 0.2, 0.13], [2270, 0.11, 0.08], [3610, 0.06, 0.05]]) {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.frequency.value = f * p;
      og.gain.setValueAtTime(a, t); og.gain.exponentialRampToValueAtTime(0.001, t + d);
      o.connect(og).connect(this.master!); o.start(t); o.stop(t + d + 0.02);
    }
    const th = ctx.createOscillator(), tg = ctx.createGain();
    th.frequency.setValueAtTime(170, t); th.frequency.exponentialRampToValueAtTime(55, t + 0.09);
    tg.gain.setValueAtTime(0.55, t); tg.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    th.connect(tg).connect(this.master!); th.start(t); th.stop(t + 0.13);
  }

  /** an explosion, `distance` metres away: a boom with a long rumble, quieter and duller further off */
  blast(distance: number) {
    const ctx = this.ctx;
    if (!ctx || !this.on || !this.noiseBuf) return;
    const t = ctx.currentTime + Math.min(1.5, distance / 340), level = Math.min(1.2, 60 / Math.max(30, distance));
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass";
    lp.frequency.setValueAtTime(Math.max(300, 2400 - distance * 4), t); lp.frequency.exponentialRampToValueAtTime(120, t + 1.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(level, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
    src.connect(lp).connect(g).connect(this.master!);
    src.start(t, Math.random()); src.stop(t + 2.3);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.8);
    og.gain.setValueAtTime(level * 0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + 1);
    o.connect(og).connect(this.master!); o.start(t); o.stop(t + 1.05);
  }

  dispose() {
    this.on = false;
    for (const s of this.sources) { try { s.stop(); } catch { /* not started */ } }
    void this.ctx?.close();
    this.ctx = null;
  }

  private build() {
    const ctx = new AudioContext(), master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    // two seconds of white noise, looped: the air the blades beat and the engine's roar
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const noise = () => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); this.sources.push(s); return s; };

    // the beat: a sine at the blade rate, sharpened into short pulses, opens and closes the gain of the chop
    const beat = ctx.createOscillator(); beat.frequency.value = 10;
    const shape = ctx.createWaveShaper();
    shape.curve = Float32Array.from({ length: 1024 }, (_, i) => Math.pow(Math.max(0, (i / 1023) * 2 - 1), 5));
    beat.connect(shape); beat.start(); this.sources.push(beat);

    // chop: band-passed noise, pulsed
    const band = ctx.createBiquadFilter(); band.type = "bandpass"; band.frequency.value = 220; band.Q.value = 0.9;
    const pulse = ctx.createGain(); pulse.gain.value = 0.05;
    shape.connect(pulse.gain);
    const chop = ctx.createGain(); chop.gain.value = 0.6;
    noise().connect(band).connect(pulse).connect(chop).connect(master);

    // thump: a low tone pulsed with the same beat
    const low = ctx.createOscillator(); low.frequency.value = 52; low.start(); this.sources.push(low);
    const thump = ctx.createGain(); thump.gain.value = 0;
    shape.connect(thump.gain);
    const thumpLevel = ctx.createGain(); thumpLevel.gain.value = 0.5;
    low.connect(thump).connect(thumpLevel).connect(chop);

    // rumble: deep noise, steady
    const lowpass = ctx.createBiquadFilter(); lowpass.type = "lowpass"; lowpass.frequency.value = 140;
    const rumble = ctx.createGain(); rumble.gain.value = 0.35;
    noise().connect(lowpass).connect(rumble).connect(master);

    Object.assign(this, { ctx, master, beat, chop });
  }
}
