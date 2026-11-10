import type { Vec3 } from '../../shared/math';

/** Independent reasons to silence the game. Audio plays only while none is active. */
export type MuteReason = 'user' | 'focus' | 'ad' | 'platform';

export type SoundName =
  | 'shot'
  | 'dry'
  | 'reloadStart'
  | 'reloadEnd'
  | 'footstep'
  | 'jump'
  | 'land'
  | 'hurt'
  | 'death'
  | 'hit'
  | 'crit'
  | 'kill'
  | 'impact'
  | 'enemyAlert'
  | 'enemyWindup'
  | 'enemyFire'
  | 'enemyDead'
  | 'boltImpact'
  | 'objective'
  | 'complete'
  | 'radio'
  | 'hint'
  | 'pickup'
  | 'uiClick'
  | 'uiHover';

export interface Volumes {
  master: number;
  music: number;
  sfx: number;
  dialogue: number;
}

/**
 * All sound is synthesised at runtime with Web Audio, so the game ships no audio files and has
 * nothing to license. The context is created on the first user gesture, as browsers require.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private music: GainNode | null = null;
  private dialogue: GainNode | null = null;
  private combat: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly loops: AudioScheduledSourceNode[] = [];
  private readonly reasons = new Set<MuteReason>();
  private volumes: Volumes = { master: 0.8, music: 0.6, sfx: 0.9, dialogue: 1 };

  get muted(): boolean {
    return this.reasons.size > 0;
  }

  /** Call from a click or key press. Safe to call repeatedly. */
  unlock(): void {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext({ latencyHint: 'interactive' });
        this.build(this.ctx);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch (e) {
      // No audio device or a blocked context: the game stays fully playable in silence.
      console.warn('[audio] unavailable:', e);
      this.ctx = null;
    }
  }

  setVolumes(v: Volumes): void {
    this.volumes = { ...v };
    this.applyGains();
  }

  /** Each reason is tracked separately, so an advert ending never undoes the player's own mute. */
  setMuted(reason: MuteReason, on: boolean): void {
    if (on) this.reasons.add(reason);
    else this.reasons.delete(reason);
    this.applyGains();
  }

  private applyGains(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volumes.master, t, 0.02);
    this.sfx!.gain.setTargetAtTime(this.volumes.sfx, t, 0.02);
    this.music!.gain.setTargetAtTime(this.volumes.music, t, 0.02);
    this.dialogue!.gain.setTargetAtTime(this.volumes.dialogue, t, 0.02);
  }

  /** 0 for exploration, 1 while any unit is fighting the player. */
  setCombat(level: number): void {
    if (this.ctx && this.combat) this.combat.gain.setTargetAtTime(level * 0.55, this.ctx.currentTime, 0.9);
  }

  setListener(pos: Vec3, yaw: number, pitch: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    const c = Math.cos(pitch);
    const fx = -Math.sin(yaw) * c;
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * c;
    if (l.positionX) {
      l.positionX.value = pos.x;
      l.positionY.value = pos.y;
      l.positionZ.value = pos.z;
      l.forwardX.value = fx;
      l.forwardY.value = fy;
      l.forwardZ.value = fz;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  dispose(): void {
    for (const n of this.loops) {
      try {
        n.stop();
      } catch {
        // already stopped
      }
    }
    this.loops.length = 0;
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  private build(ctx: AudioContext): void {
    const master = (this.master = ctx.createGain());
    // A gentle limiter keeps overlapping gunfire from clipping.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    master.connect(limiter).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.music = ctx.createGain();
    this.dialogue = ctx.createGain();
    this.sfx.connect(master);
    this.music.connect(master);
    this.dialogue.connect(master);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.applyGains();
    this.master.gain.value = this.muted ? 0 : this.volumes.master;
    this.buildAmbience(ctx);
    this.buildMusic(ctx);
  }

  private loopNoise(ctx: AudioContext, type: BiquadFilterType, freq: number, q: number, gain: number, dest: AudioNode): GainNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(dest);
    src.start();
    this.loops.push(src);
    return g;
  }

  private loopTone(ctx: AudioContext, type: OscillatorType, freq: number, gain: number, dest: AudioNode): GainNode {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = gain;
    o.connect(g).connect(dest);
    o.start();
    this.loops.push(o);
    return g;
  }

  /** Slow gain wobble so sustained layers never sit perfectly still. */
  private wobble(ctx: AudioContext, target: AudioParam, rate: number, depth: number): void {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rate;
    const g = ctx.createGain();
    g.gain.value = depth;
    lfo.connect(g).connect(target);
    lfo.start();
    this.loops.push(lfo);
  }

  /** Dead station: low rumble, moving air and a faint hum from the emergency circuit. */
  private buildAmbience(ctx: AudioContext): void {
    const sfx = this.sfx!;
    this.loopNoise(ctx, 'lowpass', 130, 0.7, 0.22, sfx);
    const air = this.loopNoise(ctx, 'bandpass', 950, 0.5, 0.022, sfx);
    this.wobble(ctx, air.gain, 0.07, 0.012);
    this.loopTone(ctx, 'sine', 100, 0.012, sfx);
    this.loopTone(ctx, 'sine', 200, 0.004, sfx);
  }

  /** Exploration pad plus a pulsing combat layer that is faded in by setCombat. */
  private buildMusic(ctx: AudioContext): void {
    const music = this.music!;
    const pad = ctx.createBiquadFilter();
    pad.type = 'lowpass';
    pad.frequency.value = 520;
    pad.connect(music);
    // D minor: D2, A2, F3, with a slightly detuned upper voice.
    for (const [freq, gain, rate] of [
      [73.42, 0.05, 0.05],
      [110, 0.035, 0.07],
      [174.61, 0.022, 0.09],
      [175.4, 0.018, 0.11],
    ]) {
      const g = this.loopTone(ctx, 'triangle', freq, gain, pad);
      this.wobble(ctx, g.gain, rate, gain * 0.6);
    }

    const combat = (this.combat = ctx.createGain());
    combat.gain.value = 0;
    combat.connect(music);
    const drive = ctx.createBiquadFilter();
    drive.type = 'lowpass';
    drive.frequency.value = 260;
    const pulse = ctx.createGain();
    pulse.gain.value = 0.5;
    drive.connect(pulse).connect(combat);
    const bass = ctx.createOscillator();
    bass.type = 'sawtooth';
    bass.frequency.value = 55;
    const bassGain = ctx.createGain();
    bassGain.gain.value = 0.16;
    bass.connect(bassGain).connect(drive);
    bass.start();
    this.loops.push(bass);
    this.wobble(ctx, pulse.gain, 2.2, 0.5);
    // A close interval held quietly above the pulse for tension.
    this.loopTone(ctx, 'sine', 311.13, 0.012, combat);
    this.loopTone(ctx, 'sine', 329.63, 0.01, combat);
  }

  private tone(dest: AudioNode, type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  private burst(dest: AudioNode, type: BiquadFilterType, freq: number, q: number, dur: number, gain: number, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  /** Destination for a sound: positioned in the world when `pos` is given, otherwise flat. */
  private out(bus: GainNode, pos?: Vec3): AudioNode {
    if (!pos) return bus;
    const p = this.ctx!.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 4;
    p.maxDistance = 70;
    p.rolloffFactor = 1.3;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    p.connect(bus);
    return p;
  }

  play(name: SoundName, pos?: Vec3): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.sfx || !this.dialogue || this.muted) return;
    const d = this.out(name === 'radio' ? this.dialogue : this.sfx, pos);
    const jitter = 0.94 + Math.random() * 0.12;
    switch (name) {
      case 'shot':
        this.burst(d, 'bandpass', 1900 * jitter, 0.6, 0.11, 0.55);
        this.burst(d, 'lowpass', 800, 0.5, 0.28, 0.2);
        this.tone(d, 'sine', 170 * jitter, 48, 0.1, 0.6);
        this.tone(d, 'square', 2300, 1200, 0.012, 0.1);
        break;
      case 'dry':
        this.burst(d, 'highpass', 3200, 1, 0.018, 0.25);
        break;
      case 'reloadStart':
        this.burst(d, 'bandpass', 2400, 3, 0.03, 0.22, 0.12);
        this.tone(d, 'triangle', 420, 300, 0.05, 0.07, 0.14);
        this.burst(d, 'bandpass', 1500, 2, 0.05, 0.16, 0.75);
        break;
      case 'reloadEnd':
        this.burst(d, 'bandpass', 3000, 4, 0.03, 0.26);
        this.tone(d, 'triangle', 620, 880, 0.04, 0.06, 0.02);
        break;
      case 'footstep':
        this.burst(d, 'lowpass', 420 * jitter, 0.8, 0.07, 0.12);
        break;
      case 'jump':
        this.burst(d, 'lowpass', 600, 0.6, 0.08, 0.08);
        break;
      case 'land':
        this.burst(d, 'lowpass', 260, 0.7, 0.14, 0.26);
        this.tone(d, 'sine', 95, 50, 0.1, 0.22);
        break;
      case 'hurt':
        this.tone(d, 'sine', 120, 55, 0.2, 0.5);
        this.burst(d, 'lowpass', 900, 0.6, 0.12, 0.25);
        break;
      case 'death':
        this.tone(d, 'sawtooth', 180, 38, 0.9, 0.3);
        this.burst(d, 'lowpass', 500, 0.5, 0.8, 0.25);
        break;
      case 'hit':
        this.tone(d, 'triangle', 1500, 1300, 0.04, 0.16);
        break;
      case 'crit':
        this.tone(d, 'triangle', 1900, 1700, 0.04, 0.18);
        this.tone(d, 'triangle', 2600, 2400, 0.05, 0.14, 0.035);
        break;
      case 'kill':
        this.tone(d, 'triangle', 1300, 520, 0.16, 0.22);
        this.burst(d, 'bandpass', 2600, 2, 0.06, 0.12);
        break;
      case 'impact':
        this.burst(d, 'bandpass', 2800 * jitter, 2.5, 0.05, 0.3);
        break;
      case 'enemyAlert':
        this.tone(d, 'square', 660, 990, 0.09, 0.14);
        this.tone(d, 'square', 990, 1320, 0.09, 0.12, 0.09);
        break;
      case 'enemyWindup':
        this.tone(d, 'sawtooth', 260, 1150, 0.42, 0.2);
        break;
      case 'enemyFire':
        this.tone(d, 'sawtooth', 980 * jitter, 210, 0.13, 0.4);
        this.burst(d, 'bandpass', 1400, 1, 0.08, 0.25);
        break;
      case 'enemyDead':
        this.tone(d, 'sawtooth', 420, 36, 0.7, 0.4);
        this.burst(d, 'bandpass', 1800, 0.8, 0.4, 0.3);
        break;
      case 'boltImpact':
        this.burst(d, 'lowpass', 1400, 0.8, 0.09, 0.3);
        break;
      case 'objective':
        this.tone(d, 'sine', 660, 660, 0.14, 0.2);
        this.tone(d, 'sine', 990, 990, 0.2, 0.2, 0.12);
        break;
      case 'complete':
        for (const [i, f] of [440, 554.37, 659.25, 880].entries()) this.tone(d, 'sine', f, f, 0.5, 0.16, i * 0.13);
        break;
      case 'radio':
        this.burst(d, 'bandpass', 2100, 1.4, 0.07, 0.12);
        this.tone(d, 'sine', 1240, 1240, 0.05, 0.05, 0.05);
        break;
      case 'hint':
        this.tone(d, 'sine', 880, 880, 0.08, 0.07);
        break;
      case 'pickup':
        for (const [i, f] of [520, 660, 880].entries()) this.tone(d, 'triangle', f, f, 0.1, 0.14, i * 0.06);
        break;
      case 'uiClick':
        this.tone(d, 'triangle', 720, 540, 0.05, 0.1);
        break;
      case 'uiHover':
        this.tone(d, 'sine', 980, 980, 0.02, 0.025);
        break;
    }
  }
}
