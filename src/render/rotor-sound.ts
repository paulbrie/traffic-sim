/**
 * The helicopter's sound, made in the browser (Web Audio, no recordings): the blades' beat (noise pulsed
 * at the blade rate, with a low thump), the engine's rumble and the turbine's whine. `set` follows the
 * flight: harder work (speed, climbing) beats faster and louder.
 */
export class RotorSound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private beat: OscillatorNode | null = null;
  private chop: GainNode | null = null;
  private whine: OscillatorNode[] = [];
  private whineGain: GainNode | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private on = false;

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

  /** load: 0 hovering … 1 flat out; outside: heard from outside (more beat, less turbine) */
  set(load: number, outside: boolean) {
    if (!this.ctx || !this.on) return;
    const t = this.ctx.currentTime, l = Math.max(0, Math.min(1, load));
    this.beat!.frequency.setTargetAtTime(9.5 + l * 2.5, t, 0.6);
    this.chop!.gain.setTargetAtTime((outside ? 0.9 : 0.55) * (0.65 + 0.35 * l), t, 0.3);
    this.whine.forEach((o, i) => o.frequency.setTargetAtTime((i ? 2 : 1) * (1180 + l * 160), t, 0.8));
    this.whineGain!.gain.setTargetAtTime(outside ? 0.004 : 0.012, t, 0.3);
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

    // turbine whine: two tones an octave apart, softened
    const whineGain = ctx.createGain(); whineGain.gain.value = 0.012;
    const soft = ctx.createBiquadFilter(); soft.type = "lowpass"; soft.frequency.value = 3000;
    this.whine = [1180, 2360].map(f => { const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = f; o.connect(soft); o.start(); this.sources.push(o); return o; });
    soft.connect(whineGain).connect(master);

    Object.assign(this, { ctx, master, beat, chop, whineGain });
  }
}
