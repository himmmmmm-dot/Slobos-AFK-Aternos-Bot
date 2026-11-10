import * as THREE from 'three';
import type { Enemy } from '../../game/ai/enemy';
import type { AiState, SimEvent } from '../../game/events';
import type { Simulation } from '../../game/sim';

const VISOR: Record<AiState, number> = {
  patrol: 0x4fd8ff,
  return: 0x4fd8ff,
  investigate: 0xffb347,
  search: 0xffb347,
  combat: 0xff4a2e,
  dead: 0x000000,
};

interface View {
  group: THREE.Group;
  body: THREE.Group;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  arm: THREE.Group;
  glow: THREE.Mesh;
  visor: THREE.MeshStandardMaterial;
  plate: THREE.MeshStandardMaterial;
  marker: THREE.Sprite;
  stride: number;
  flash: number;
  dead: number;
}

/** Awareness markers differ in shape as well as colour: a ringed "?" and a filled diamond "!". */
function markerTexture(kind: 'suspect' | 'alert'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.lineWidth = 9;
  if (kind === 'suspect') {
    g.strokeStyle = '#ffb347';
    g.beginPath();
    g.arc(64, 64, 50, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#ffb347';
  } else {
    g.fillStyle = '#ff4a2e';
    g.beginPath();
    g.moveTo(64, 6);
    g.lineTo(122, 64);
    g.lineTo(64, 122);
    g.lineTo(6, 64);
    g.closePath();
    g.fill();
    g.fillStyle = '#ffffff';
  }
  g.font = 'bold 84px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(kind === 'suspect' ? '?' : '!', 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Security units built from primitives: wide shoulders, sensor head and a back mast for the silhouette. */
export class EnemyViews {
  private readonly views = new Map<number, View>();
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly sphere = new THREE.SphereGeometry(1, 12, 8);
  private readonly frame = new THREE.MeshStandardMaterial({ color: 0x4a5560, roughness: 0.6, metalness: 0.3 });
  private readonly trim = new THREE.MeshStandardMaterial({ color: 0xc8843a, roughness: 0.6, metalness: 0.3 });
  private readonly glowMat = new THREE.MeshBasicMaterial({ color: 0xff7a3a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  private readonly suspect = markerTexture('suspect');
  private readonly alert = markerTexture('alert');

  constructor(private readonly scene: THREE.Scene) {}

  private part(parent: THREE.Object3D, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
    const m = new THREE.Mesh(this.box, mat);
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  }

  private create(): View {
    const group = new THREE.Group();
    const body = new THREE.Group();
    group.add(body);
    const plate = new THREE.MeshStandardMaterial({ color: 0xa9b6c2, roughness: 0.5, metalness: 0.2, emissive: 0xffffff, emissiveIntensity: 0 });
    const visor = new THREE.MeshStandardMaterial({ color: 0x05080a, emissive: VISOR.patrol, emissiveIntensity: 3 });

    // Legs pivot at the hip, so their geometry hangs below the pivot.
    const leg = (x: number): THREE.Mesh => {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.92, 0);
      body.add(pivot);
      this.part(pivot, this.frame, 0.17, 0.92, 0.2, 0, -0.46, 0);
      this.part(pivot, plate, 0.2, 0.3, 0.24, 0, -0.3, -0.01);
      return pivot as unknown as THREE.Mesh;
    };
    const legL = leg(-0.15);
    const legR = leg(0.15);
    this.part(body, this.frame, 0.5, 0.2, 0.3, 0, 0.98, 0);
    this.part(body, plate, 0.6, 0.58, 0.36, 0, 1.36, 0);
    this.part(body, this.trim, 0.62, 0.06, 0.37, 0, 1.2, 0);
    this.part(body, plate, 0.92, 0.17, 0.32, 0, 1.63, 0);
    this.part(body, this.frame, 0.3, 0.27, 0.32, 0, 1.82, -0.01);
    this.part(body, visor, 0.31, 0.075, 0.1, 0, 1.84, -0.13);
    this.part(body, this.frame, 0.4, 0.5, 0.2, 0, 1.4, 0.26);
    this.part(body, this.frame, 0.03, 0.5, 0.03, 0.14, 1.95, 0.3);
    this.part(body, this.frame, 0.13, 0.62, 0.15, -0.5, 1.28, 0);

    const arm = new THREE.Group();
    arm.position.set(0.5, 1.55, 0);
    body.add(arm);
    this.part(arm, this.frame, 0.13, 0.13, 0.5, 0, 0, -0.2);
    this.part(arm, plate, 0.16, 0.17, 0.3, 0, 0, -0.5);
    const glow = new THREE.Mesh(this.sphere, this.glowMat);
    glow.position.set(0, 0, -0.68);
    glow.scale.setScalar(0.001);
    arm.add(glow);

    const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.suspect, depthTest: false, transparent: true }));
    marker.scale.setScalar(0.42);
    marker.position.set(0, 2.45, 0);
    marker.visible = false;
    marker.renderOrder = 5;
    group.add(marker);

    this.scene.add(group);
    return { group, body, legL, legR, arm, glow, visor, plate, marker, stride: 0, flash: 0, dead: 0 };
  }

  /** Matches the views to the simulation's units; pass null to remove them all. */
  sync(sim: Simulation | null): void {
    for (const v of this.views.values()) {
      this.scene.remove(v.group);
      // Per-unit materials are released with the unit, so restarts do not accumulate them.
      v.plate.dispose();
      v.visor.dispose();
      v.marker.material.dispose();
    }
    this.views.clear();
    if (!sim) return;
    for (const e of sim.enemies) this.views.set(e.id, this.create());
  }

  onEvent(ev: SimEvent): void {
    if (ev.type === 'enemyHurt') {
      const v = this.views.get(ev.id);
      if (v) v.flash = ev.crit ? 1 : 0.6;
    }
  }

  update(sim: Simulation, alpha: number, dt: number, time: number): void {
    for (const e of sim.enemies) {
      const v = this.views.get(e.id);
      if (v) this.pose(e, v, alpha, dt, time);
    }
  }

  private pose(e: Enemy, v: View, alpha: number, dt: number, time: number): void {
    const p = e.body.pos;
    const q = e.prevPos;
    v.group.position.set(q.x + (p.x - q.x) * alpha, q.y + (p.y - q.y) * alpha, q.z + (p.z - q.z) * alpha);
    let dyaw = e.yaw - e.prevYaw;
    if (dyaw > Math.PI) dyaw -= Math.PI * 2;
    else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
    v.group.rotation.y = e.prevYaw + dyaw * alpha;

    v.flash = Math.max(0, v.flash - dt * 6);
    v.plate.emissiveIntensity = v.flash * 1.6;

    if (e.state === 'dead') {
      // Power down and topple backwards. No gore: these are machines.
      v.dead = Math.min(1, v.dead + dt * 2.2);
      const k = 1 - (1 - v.dead) * (1 - v.dead);
      v.body.rotation.x = k * 1.5;
      v.body.position.y = k * 0.18;
      v.visor.emissiveIntensity = Math.max(0, 3 * (1 - v.dead * 3));
      v.marker.visible = false;
      v.glow.scale.setScalar(0.001);
      v.legL.rotation.x = v.legR.rotation.x = 0;
      return;
    }

    v.stride += e.speed * dt * 3.4;
    const swing = Math.sin(v.stride) * 0.55 * Math.min(1, e.speed / 1.6);
    v.legL.rotation.x = swing;
    v.legR.rotation.x = -swing;
    v.body.position.y = Math.abs(Math.sin(v.stride)) * 0.03 * Math.min(1, e.speed / 1.6);
    v.body.rotation.x = e.staggerTicks > 0 ? -0.18 : 0;

    v.visor.emissive.setHex(VISOR[e.state]);
    const aiming = e.state === 'combat';
    v.arm.rotation.x = aiming ? 0 : -1.1;

    // The emitter swells through the telegraph and flashes on each bolt.
    let glow = 0.001;
    if (e.phase === 'windup') glow = 0.05 + 0.16 * (1 - e.phaseTicks / e.def.windupTicks);
    else if (e.phase === 'burst') glow = 0.14 + 0.05 * Math.sin(time * 60);
    v.glow.scale.setScalar(glow);

    const suspicious = e.state === 'investigate' || e.state === 'search';
    v.marker.visible = suspicious || aiming;
    if (v.marker.visible) {
      const mat = v.marker.material as THREE.SpriteMaterial;
      const map = aiming ? this.alert : this.suspect;
      if (mat.map !== map) {
        mat.map = map;
        mat.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    this.sync(null);
    for (const d of [this.box, this.sphere, this.frame, this.trim, this.glowMat, this.suspect, this.alert]) d.dispose();
  }
}
