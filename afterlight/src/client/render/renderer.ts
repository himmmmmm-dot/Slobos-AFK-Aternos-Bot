import * as THREE from 'three';
import type { SimEvent } from '../../game/events';
import type { LevelDef } from '../../game/level';
import type { Simulation } from '../../game/sim';
import type { Vec3 } from '../../shared/math';
import type { Quality, Settings } from '../persistence/settings';
import { Effects } from './effects';
import { EnemyViews } from './enemyView';
import { buildLevel, type LevelView } from './levelMesh';
import { Viewmodel } from './viewmodel';

export interface FrameInput {
  sim: Simulation | null;
  /** Fraction of a tick since the last simulation step, for interpolation. */
  alpha: number;
  /** Zero while paused, so effects and animation freeze with the simulation. */
  dt: number;
  time: number;
  yaw: number;
  pitch: number;
  swayX: number;
  swayY: number;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  pixelRatio: number;
  width: number;
  height: number;
}

/** Low keeps the same lighting and palette at a lower resolution without the shadowed key light. */
const QUALITY: Record<Quality, { maxDpr: number; scale: number; shadowSize: number }> = {
  low: { maxDpr: 1, scale: 0.75, shadowSize: 0 },
  medium: { maxDpr: 1.5, scale: 1, shadowSize: 1024 },
  high: { maxDpr: 2, scale: 1, shadowSize: 2048 },
};

export class GameRenderer {
  readonly camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 200);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly enemies: EnemyViews;
  private readonly effects: Effects;
  private readonly viewmodel = new Viewmodel();
  private readonly observer: ResizeObserver;
  private readonly muzzle = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private level: LevelView | null = null;
  private levelDef: LevelDef | null = null;
  private settings: Settings;
  private viewY = 0;
  private shake = 0;
  private death = 0;
  private stats: RenderStats = { drawCalls: 0, triangles: 0, geometries: 0, textures: 0, pixelRatio: 1, width: 0, height: 0 };

  constructor(
    private readonly container: HTMLElement,
    settings: Settings,
    private readonly onContextLost: () => void,
  ) {
    this.settings = settings;
    // Throws when WebGL 2 is unavailable; the caller turns that into a readable error screen.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.autoClear = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.info.autoReset = false;
    const canvas = this.renderer.domElement;
    canvas.addEventListener('webglcontextlost', this.contextLost);
    container.appendChild(canvas);
    this.camera.rotation.order = 'YXZ';
    this.enemies = new EnemyViews(this.scene);
    this.effects = new Effects(this.scene);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.applySettings(settings);
  }

  private contextLost = (e: Event): void => {
    e.preventDefault();
    this.onContextLost();
  };

  loadLevel(def: LevelDef): void {
    if (this.level) {
      this.scene.remove(this.level.group);
      this.level.dispose();
    }
    this.levelDef = def;
    this.level = buildLevel(def);
    this.scene.add(this.level.group);
    this.scene.background = new THREE.Color(def.ambient.fog);
    this.scene.fog = new THREE.FogExp2(def.ambient.fog, def.ambient.fogDensity);
    this.applySettings(this.settings);
  }

  /** Compiles every shader up front so the first seconds of play do not hitch. */
  async warmUp(): Promise<void> {
    await this.renderer.compileAsync(this.scene, this.camera);
    await this.renderer.compileAsync(this.viewmodel.scene, this.viewmodel.camera);
  }

  applySettings(s: Settings): void {
    this.settings = s;
    const q = QUALITY[s.quality];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.maxDpr) * q.scale);
    this.renderer.toneMappingExposure = 1.1 * s.brightness;
    // The setting is a horizontal FOV on a 16:9 view; the vertical FOV stays fixed on wider screens.
    const h = (s.fov * Math.PI) / 180;
    this.camera.fov = (2 * Math.atan(Math.tan(h / 2) * (9 / 16)) * 180) / Math.PI;
    const shadows = q.shadowSize > 0;
    if (this.renderer.shadowMap.enabled !== shadows) {
      this.renderer.shadowMap.enabled = shadows;
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) m.needsUpdate = true;
      });
    }
    const spot = this.level?.spot;
    if (spot) {
      spot.castShadow = shadows;
      if (shadows && spot.shadow.mapSize.x !== q.shadowSize) {
        spot.shadow.mapSize.set(q.shadowSize, q.shadowSize);
        spot.shadow.map?.dispose();
        spot.shadow.map = null;
      }
    }
    this.resize();
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewmodel.setAspect(w / h);
    this.stats.width = w;
    this.stats.height = h;
    this.stats.pixelRatio = this.renderer.getPixelRatio();
  }

  /** Attaches a new run, or null to return to the menu backdrop. */
  bindSim(sim: Simulation | null): void {
    this.enemies.sync(sim);
    this.effects.reset();
    this.viewmodel.reset();
    this.shake = 0;
    this.death = 0;
    if (sim) this.viewY = sim.player.move.body.pos.y;
    if (this.level) for (const p of this.level.pickups.values()) p.visible = true;
  }

  onEvent(ev: SimEvent, sim: Simulation): void {
    this.enemies.onEvent(ev);
    this.effects.onEvent(ev, this.muzzle);
    if (ev.type === 'playerHurt' && this.settings.screenShake) this.shake = Math.min(1, this.shake + ev.amount / 30);
    else if (ev.type === 'pickup') {
      const p = this.level?.pickups.get(ev.id);
      if (p) p.visible = false;
    } else if (ev.type === 'enemyDead') {
      const e = sim.enemies[ev.id];
      this.effects.burst({ x: e.body.pos.x, y: e.body.pos.y + 1.3, z: e.body.pos.z }, 26);
    }
  }

  /** Screen position of a world point in CSS pixels. `behind` means it is behind the camera. */
  project(p: Vec3): { x: number; y: number; behind: boolean } {
    this.tmp.set(p.x, p.y, p.z).applyMatrix4(this.camera.matrixWorldInverse);
    const behind = this.tmp.z > 0;
    this.tmp.applyMatrix4(this.camera.projectionMatrix);
    return { x: (this.tmp.x * 0.5 + 0.5) * this.stats.width, y: (-this.tmp.y * 0.5 + 0.5) * this.stats.height, behind };
  }

  get verticalFov(): number {
    return (this.camera.fov * Math.PI) / 180;
  }

  getStats(): RenderStats {
    return { ...this.stats };
  }

  render(f: FrameInput): void {
    const sim = f.sim;
    const cam = this.camera;
    if (sim) {
      const p = sim.player;
      const pos = p.move.body.pos;
      const a = f.alpha;
      const feetY = p.prevPos.y + (pos.y - p.prevPos.y) * a;
      // Ease the camera over steps and stair treads; follow exactly while airborne.
      if (p.move.body.onGround && Math.abs(this.viewY - feetY) < 0.8 && f.dt > 0) {
        this.viewY += (feetY - this.viewY) * (1 - Math.exp(-22 * f.dt));
      } else if (f.dt > 0 || Math.abs(this.viewY - feetY) >= 0.8) {
        this.viewY = feetY;
      }
      const eye = p.prevEye + (p.move.eye - p.prevEye) * a;
      if (!p.alive) this.death = Math.min(1, this.death + f.dt * 1.4);
      const fall = this.death * this.death * (3 - 2 * this.death);
      cam.position.set(
        p.prevPos.x + (pos.x - p.prevPos.x) * a,
        this.viewY + eye - fall * (eye - 0.35),
        p.prevPos.z + (pos.z - p.prevPos.z) * a,
      );
      this.shake = Math.max(0, this.shake - f.dt * 3.5);
      const s = this.shake * this.shake * 0.02;
      cam.rotation.set(
        f.pitch + p.recoilPitch + Math.sin(f.time * 71) * s,
        f.yaw + p.recoilYaw + Math.sin(f.time * 53) * s,
        fall * 0.5,
      );
      cam.updateMatrixWorld();

      // Tracers start where the pistol's muzzle appears, slightly right of and below the eye.
      this.muzzle.set(0.16, -0.11, -0.7).applyMatrix4(cam.matrixWorld);
      this.enemies.update(sim, a, f.dt, f.time);
      this.effects.update(sim, a, f.dt);
      this.viewmodel.update(sim, { dt: f.dt, time: f.time, swayX: f.swayX, swayY: f.swayY, viewBob: this.settings.viewBob });
      if (this.level) {
        for (const cell of this.level.pickups.values()) {
          cell.rotation.y = f.time * 1.4;
          cell.position.y += Math.sin(f.time * 2.2) * 0.0008;
        }
      }
    } else if (this.levelDef) {
      // Menu backdrop: a slow drift over the concourse.
      const t = f.time * 0.06;
      cam.position.set(8 + Math.sin(t) * 2.5, 4.4, 11 + Math.cos(t) * 1.2);
      cam.lookAt(-1, 1.6, -4);
      cam.updateMatrixWorld();
    }

    const info = this.renderer.info;
    info.reset();
    this.renderer.clear();
    this.renderer.render(this.scene, cam);
    if (sim && sim.player.alive) {
      this.renderer.clearDepth();
      this.renderer.render(this.viewmodel.scene, this.viewmodel.camera);
    }
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.geometries = info.memory.geometries;
    this.stats.textures = info.memory.textures;
  }

  dispose(): void {
    this.observer.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.enemies.dispose();
    this.effects.dispose();
    this.viewmodel.dispose();
    this.level?.dispose();
    this.renderer.dispose();
    canvas.remove();
  }
}
