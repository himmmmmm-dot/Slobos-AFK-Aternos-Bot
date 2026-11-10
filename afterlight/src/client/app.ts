import type { BotController } from '../game/bot';
import type { SimEvent } from '../game/events';
import type { LevelDef } from '../game/level';
import type { NavGrid } from '../game/nav';
import type { Simulation } from '../game/sim';
import { FixedStep } from '../shared/loop';
import { distance, wrapAngle } from '../shared/math';
import { PLAYER } from '../shared/movement';
import { currentSpread } from '../shared/weapons';
import { AppStateMachine, type AppState } from './appState';
import { AudioEngine } from './audio/audio';
import { keyLabel } from './bindings';
import { Input } from './input';
import { bindPlatformLifecycle } from './lifecycle';
import { defaultSettings, loadSettings, saveSettings, type Settings } from './persistence/settings';
import { browserStore, resolveStore, SafeStore } from './persistence/storage';
import { createPlatform } from './platform';
import type { PlatformAdapter } from './platform/types';
import type { GameRenderer } from './render/renderer';
import { UI } from './ui/ui';

type Engine = typeof import('./engine');

/** How long the world keeps running after a mission ends before the result screen appears. */
const END_DELAY_TICKS = { complete: 60 * 4, failed: 60 * 2 };

const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Owns startup, the frame loop and the wiring between simulation, renderer, audio, UI and platform. */
export class App {
  readonly sm = new AppStateMachine();
  readonly platform: PlatformAdapter = createPlatform();
  private store = new SafeStore(null);
  private settings: Settings = defaultSettings();
  private readonly audio = new AudioEngine();
  private readonly loop = new FixedStep();
  private readonly ui: UI;
  private readonly input: Input;
  private readonly debug: boolean;
  private engine: Engine | null = null;
  private renderer: GameRenderer | null = null;
  private level: LevelDef | null = null;
  private nav: NavGrid | null = null;
  private sim: Simulation | null = null;
  private bot: BotController | null = null;
  private autopilot: boolean;
  private layout: Map<string, string> | null = null;
  private raf = 0;
  private last = 0;
  private time = 0;
  private wantLock = false;
  private lockRetried = false;
  private readonly frameMs = new Float32Array(240);
  private frames = 0;
  private notices = { storage: '', platform: '', settings: '', lock: '' };

  constructor(
    private readonly view: HTMLElement,
    uiRoot: HTMLElement,
  ) {
    const q = new URLSearchParams(location.search);
    this.debug = import.meta.env.DEV || q.has('debug');
    this.autopilot = q.has('autopilot');
    this.input = new Input(
      view,
      () => this.settings,
      {
        onLockChange: (locked) => this.onLockChange(locked),
        onLockError: () => this.onLockError(),
        onPause: () => this.togglePause(),
      },
      q.has('nolock'),
    );
    this.ui = new UI(
      uiRoot,
      {
        start: () => this.startMission(),
        resume: () => this.requestPlay(),
        quit: () => this.quitToMenu(),
        reload: () => location.reload(),
        changeSettings: (next) => this.changeSettings(next),
        sound: (kind) => this.audio.play(kind),
      },
      () => this.settings,
      (code) => keyLabel(code, this.layout),
    );
    this.sm.onChange((to) => this.onState(to));
    bindPlatformLifecycle(this.sm, this.platform);
    this.input.attach();

    const unfocus = (): void => {
      this.audio.setMuted('focus', true);
      if (this.sm.state === 'playing') this.pauseGame();
    };
    window.addEventListener('blur', unfocus);
    window.addEventListener('focus', () => this.audio.setMuted('focus', false));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) unfocus();
      else this.audio.setMuted('focus', false);
    });
    // Browsers only allow audio after a gesture; the first click or key press starts it.
    const unlock = (): void => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    if (this.debug) {
      (window as unknown as { __afterlight: unknown }).__afterlight = {
        state: () => this.sm.state,
        sim: () => this.sim,
        perf: () => this.perf(),
        settings: () => this.settings,
        storage: () => ({ kind: this.store.kind, persistent: this.store.persistent }),
        platform: () => ({
          id: this.platform.id,
          status: this.platform.status,
          environment: this.platform.environment,
          reason: this.platform.unavailableReason,
          data: this.platform.dataStore?.kind ?? null,
          muteAudio: this.platform.muteAudio,
        }),
        audioMuted: () => this.audio.muted,
        resetPerf: () => {
          this.frames = 0;
        },
        autopilot: (on: boolean) => {
          this.autopilot = on;
          this.bot = on && this.sim && this.engine ? new this.engine.BotController(this.sim, this.engine.BOT_CASUAL) : null;
        },
      };
    }
  }

  async boot(): Promise<void> {
    // Mobile is outside this release: say so instead of presenting controls that cannot work.
    if (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches) {
      this.ui.show('unsupported');
      return;
    }
    this.ui.show('loading');
    const steps: [string, () => Promise<void> | void][] = [
      [
        'Contacting platform services',
        async () => {
          await this.platform.init();
          this.afterPlatform();
          this.sm.go('loading');
        },
      ],
      [
        'Loading engine',
        async () => {
          this.engine = await import('./engine');
        },
      ],
      [
        'Loading mission data',
        async () => {
          this.level = (await import('../game/levels/graybox')).GRAYBOX;
        },
      ],
      [
        'Mapping navigation',
        () => {
          this.nav = this.engine!.Simulation.buildNav(this.level!);
        },
      ],
      [
        'Preparing renderer',
        async () => {
          this.renderer = new this.engine!.GameRenderer(this.view, this.settings, () =>
            this.fail(new Error('The graphics context was lost.')),
          );
          this.renderer.loadLevel(this.level!);
          await this.renderer.warmUp();
        },
      ],
    ];
    try {
      for (let i = 0; i < steps.length; i++) {
        this.ui.setLoading(i / steps.length, steps[i][0]);
        await pause();
        await steps[i][1]();
      }
      this.ui.setLoading(1, 'Ready');
      this.sm.go('menu');
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Storage and settings depend on the platform, which may provide the save store. */
  private afterPlatform(): void {
    const p = this.platform;
    this.store = resolveStore(p.dataStore, browserStore());
    const loaded = loadSettings(this.store);
    this.settings = loaded.settings;
    if (loaded.status === 'recovered') {
      this.notices.settings = 'Your saved settings could not be read and were reset to defaults.';
      saveSettings(this.store, this.settings);
    }
    if (!this.store.persistent) this.notices.storage = 'This browser is blocking storage, so settings will last for this session only.';
    if (p.id === 'crazygames' && p.status !== 'ready') {
      this.notices.platform = `${p.unavailableReason ?? 'CrazyGames services are unavailable'}. The game runs without them.`;
    }
    this.audio.setMuted('platform', p.muteAudio);
    p.onMuteAudioChange((mute) => this.audio.setMuted('platform', mute));
    this.applySettings();
    const kb = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
    kb?.getLayoutMap?.().then(
      (map) => (this.layout = map),
      () => {},
    );
  }

  private applySettings(): void {
    const s = this.settings;
    this.audio.setVolumes({ master: s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume, dialogue: s.dialogueVolume });
    this.audio.setMuted('user', s.muted);
    this.renderer?.applySettings(s);
    this.ui.applySettings(s);
    this.refreshNotice();
  }

  private changeSettings(next: Settings): void {
    this.settings = next;
    if (!saveSettings(this.store, next)) {
      this.notices.storage = 'Settings could not be saved in this browser and will last for this session only.';
    }
    this.applySettings();
  }

  private refreshNotice(): void {
    this.ui.setNotice(Object.values(this.notices).filter(Boolean).join(' '));
  }

  private fail(e: unknown): void {
    if (this.sm.state === 'error') return;
    console.error('[afterlight]', e);
    cancelAnimationFrame(this.raf);
    this.input.exitLock();
    const raw = e instanceof Error ? e.message : String(e);
    const detail = /webgl/i.test(raw)
      ? `This browser could not start WebGL 2, which the game needs. Check that hardware acceleration is on, then reload. (${raw})`
      : `${raw} Reloading usually fixes this.`;
    this.sm.go('error');
    this.ui.showError(detail);
  }

  private onState(to: AppState): void {
    this.input.capture = to === 'playing';
    if (to !== 'playing') this.input.clear();
    this.ui.setHudVisible(to === 'playing' || to === 'paused');
    switch (to) {
      case 'loading':
        this.ui.show('loading');
        break;
      case 'menu':
        this.sim = null;
        this.bot = null;
        this.renderer?.bindSim(null);
        this.audio.setCombat(0);
        this.ui.show('menu');
        break;
      case 'playing':
        this.notices.lock = '';
        this.refreshNotice();
        this.loop.reset();
        this.ui.show(null);
        break;
      case 'paused':
        this.ui.show('pause');
        break;
      case 'failed':
        this.audio.setCombat(0);
        this.ui.show('failed');
        break;
      case 'results':
        this.audio.setCombat(0);
        this.showResults();
        break;
      default:
        break;
    }
  }

  private showResults(): void {
    const sim = this.sim;
    if (!sim) return;
    const secs = Math.round(sim.mission.endedTick / 60);
    const st = sim.stats;
    this.ui.showResults({
      time: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`,
      accuracy: st.shots ? `${Math.round((st.hits / st.shots) * 100)}%` : '—',
      crits: st.crits,
      damageTaken: Math.round(st.damageTaken),
    });
  }

  private startMission(): void {
    if (!this.engine || !this.level || !this.nav || !this.renderer) return;
    this.audio.unlock();
    this.sim = new this.engine.Simulation(this.level, this.nav, (Math.random() * 0xffffffff) >>> 0);
    this.bot = this.autopilot ? new this.engine.BotController(this.sim, this.engine.BOT_CASUAL) : null;
    this.input.yaw = this.level.spawn.yaw;
    this.input.pitch = 0;
    this.renderer.bindSim(this.sim);
    this.ui.hud.reset();
    this.requestPlay();
  }

  /** Gameplay starts only once the browser grants pointer lock; see onLockChange. */
  private requestPlay(): void {
    if (!this.sim) return;
    this.wantLock = true;
    this.lockRetried = false;
    this.input.requestLock();
  }

  private onLockChange(locked: boolean): void {
    if (locked) {
      if (!this.wantLock || !this.sim) return;
      this.wantLock = false;
      this.sm.go('playing');
    } else if (this.sm.state === 'playing') {
      // Escape, or the browser, released the mouse: that is a pause.
      this.sm.go('paused');
    }
  }

  private onLockError(): void {
    if (!this.wantLock) return;
    // Browsers refuse a new lock for about a second after Escape released the last one.
    if (!this.lockRetried) {
      this.lockRetried = true;
      setTimeout(() => this.wantLock && this.input.requestLock(), 1100);
      return;
    }
    this.wantLock = false;
    this.notices.lock = 'The browser did not allow the mouse to be captured. Click inside the game and try again.';
    this.refreshNotice();
    if (this.sm.state === 'menu' && this.sim) this.sm.go('playing') && this.sm.go('paused');
  }

  private pauseGame(): void {
    if (this.sm.go('paused')) this.input.exitLock();
  }

  private togglePause(): void {
    if (this.sm.state === 'playing') this.pauseGame();
    else if (this.sm.state === 'paused' && this.ui.current === 'pause') this.requestPlay();
  }

  private quitToMenu(): void {
    this.wantLock = false;
    this.input.exitLock();
    this.sm.go('menu');
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.time += dt;
    this.frameMs[this.frames++ % this.frameMs.length] = dt * 1000;
    try {
      const sim = this.sim;
      const playing = this.sm.state === 'playing' && sim !== null;
      if (playing) {
        const ticks = this.loop.advance(dt);
        for (let i = 0; i < ticks; i++) {
          const input = this.bot ? this.bot.next() : this.input.sample();
          if (this.bot) {
            this.input.yaw = input.yaw;
            this.input.pitch = input.pitch;
          }
          sim.step(input);
        }
        this.drainEvents(sim);
      }
      const sway = this.input.takeSway();
      this.renderer?.render({
        sim,
        alpha: playing ? this.loop.alpha : 1,
        dt: playing || !sim ? dt : 0,
        time: this.time,
        yaw: this.input.yaw,
        pitch: this.input.pitch,
        swayX: sway.x,
        swayY: sway.y,
      });
      if (sim) this.updateHud(sim, playing ? dt : 0);
      if (playing) this.checkMissionEnd(sim);
    } catch (e) {
      this.fail(e);
    }
  };

  private checkMissionEnd(sim: Simulation): void {
    const m = sim.mission;
    if (m.status === 'active' || sim.tick - m.endedTick < END_DELAY_TICKS[m.status]) return;
    this.sm.go(m.status === 'complete' ? 'results' : 'failed');
    this.input.exitLock();
  }

  private drainEvents(sim: Simulation): void {
    const events = sim.events;
    if (events.length === 0) return;
    sim.events = [];
    const hud = this.ui.hud;
    const a = this.audio;
    const feet = sim.player.move.body.pos;
    const at = (id: number): { x: number; y: number; z: number } => {
      const p = sim.enemies[id].body.pos;
      return { x: p.x, y: p.y + 1.4, z: p.z };
    };
    for (const ev of events as SimEvent[]) {
      this.renderer!.onEvent(ev, sim);
      switch (ev.type) {
        case 'shot':
          a.play('shot');
          for (const hit of ev.hits) {
            if (hit.enemyId !== null) {
              const kind = hit.killed ? 'kill' : hit.crit ? 'crit' : 'hit';
              hud.hitmarker(kind);
              a.play(kind);
            } else if (hit.surface) a.play('impact', hit.point);
          }
          break;
        case 'dry':
        case 'reloadStart':
        case 'reloadEnd':
        case 'jump':
        case 'land':
        case 'footstep':
          a.play(ev.type);
          break;
        case 'playerHurt':
          a.play('hurt');
          if (ev.from) {
            const toward = Math.atan2(-(ev.from.x - feet.x), -(ev.from.z - feet.z));
            hud.damage(wrapAngle(toward - this.input.yaw));
          }
          break;
        case 'playerDead':
          a.play('death');
          break;
        case 'enemyWindup':
          a.play('enemyWindup', at(ev.id));
          break;
        case 'enemyFire':
          a.play('enemyFire', ev.origin);
          break;
        case 'enemyDead':
          a.play('enemyDead', at(ev.id));
          break;
        case 'enemyState':
          if (ev.state === 'combat') a.play('enemyAlert', at(ev.id));
          break;
        case 'boltImpact':
          if (!ev.hitPlayer) a.play('boltImpact', ev.point);
          break;
        case 'objective':
          a.play('objective');
          hud.objectiveChanged();
          break;
        case 'missionComplete':
          a.play('complete');
          break;
        case 'hint':
          a.play('hint');
          hud.hint(ev.text);
          break;
        case 'radio':
          a.play('radio');
          hud.say(ev.lines);
          break;
        case 'pickup':
          a.play('pickup');
          break;
        default:
          break;
      }
    }
    let fighting = 0;
    for (const e of sim.enemies) if (e.state === 'combat') fighting++;
    a.setCombat(fighting > 0 && sim.player.alive ? 1 : 0);
  }

  private updateHud(sim: Simulation, dt: number): void {
    const r = this.renderer!;
    const p = sim.player;
    const body = p.move.body;
    const stats = r.getStats();
    const obj = sim.currentObjective();
    const target = sim.objectiveMarker();
    const it = p.interactTarget ? sim.level.interactables.find((i) => i.id === p.interactTarget) : undefined;
    const spread = currentSpread(p.weaponDef, p.weapon.bloom, {
      moving: Math.hypot(body.vel.x, body.vel.z) / PLAYER.walkSpeed,
      airborne: !body.onGround,
      crouched: p.move.crouched,
    });
    this.ui.hud.update({
      hp: p.hp,
      maxHp: p.maxHp,
      weaponName: p.weaponDef.name,
      mag: p.weapon.mag,
      magSize: p.weaponDef.magSize,
      reserve: p.weaponDef.infiniteReserve ? '∞' : String(p.weapon.reserve),
      reload: p.weapon.reloadLeft > 0 ? 1 - p.weapon.reloadLeft / p.weaponDef.reloadTicks : null,
      objective: obj ? obj.text : '',
      count: obj && obj.kind === 'eliminate' ? `${sim.mission.done} / ${sim.mission.total}` : '',
      marker: target ? { ...r.project(target), distance: distance(target, body.pos) } : null,
      prompt: it ? it.prompt : null,
      promptProgress: it ? p.interactProgress / it.holdTicks : 0,
      crosshairGap: (Math.tan(spread) / Math.tan(r.verticalFov / 2)) * (stats.height / 2) + 3,
      width: stats.width,
      height: stats.height,
    });
    this.ui.hud.tick(dt);
    this.audio.setListener({ x: body.pos.x, y: body.pos.y + p.move.eye, z: body.pos.z }, this.input.yaw, this.input.pitch);
    if (this.debug && this.frames % 30 === 0) {
      const perf = this.perf();
      this.ui.hud.setPerf(`${perf.fps.toFixed(0)} fps · ${perf.avgMs.toFixed(1)} ms · ${perf.drawCalls} calls · ${perf.triangles} tris`);
    } else if (!this.debug && this.frames === 1) {
      this.ui.hud.setPerf(null);
    }
  }

  private perf(): { fps: number; avgMs: number; p95Ms: number; drawCalls: number; triangles: number; geometries: number; textures: number; pixelRatio: number; width: number; height: number } {
    const n = Math.min(this.frames, this.frameMs.length);
    const sorted = Array.from(this.frameMs.subarray(0, n)).sort((x, y) => x - y);
    const avg = n ? sorted.reduce((s, v) => s + v, 0) / n : 0;
    const stats = this.renderer?.getStats() ?? { drawCalls: 0, triangles: 0, geometries: 0, textures: 0, pixelRatio: 1, width: 0, height: 0 };
    return { fps: avg ? 1000 / avg : 0, avgMs: avg, p95Ms: n ? sorted[Math.min(n - 1, Math.floor(n * 0.95))] : 0, ...stats };
  }
}
