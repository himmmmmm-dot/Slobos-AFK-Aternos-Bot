import * as THREE from 'three';
import type { SimEvent } from '../../game/events';
import type { Simulation } from '../../game/sim';
import type { Vec3 } from '../../shared/math';

const MAX_PARTICLES = 320;
const MAX_TRACERS = 12;
const MAX_DECALS = 48;
const MAX_BOLTS = 32;
const HIDDEN = -9999;

function scorchTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(0,0,0,0.95)');
  grad.addColorStop(0.45, 'rgba(10,10,12,0.7)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Pooled combat feedback: tracers, sparks, scorch marks, enemy bolts and the muzzle light. */
export class Effects {
  private readonly points: THREE.Points;
  private readonly pPos = new Float32Array(MAX_PARTICLES * 3);
  private readonly pCol = new Float32Array(MAX_PARTICLES * 3);
  private readonly pVel = new Float32Array(MAX_PARTICLES * 3);
  private readonly pLife = new Float32Array(MAX_PARTICLES);
  private pNext = 0;
  private readonly tracers: { mesh: THREE.Mesh; life: number }[] = [];
  private tNext = 0;
  private readonly decals: THREE.Mesh[] = [];
  private dNext = 0;
  private readonly bolts: THREE.Mesh[] = [];
  private readonly muzzle = new THREE.PointLight(0xffc37a, 0, 9, 2);
  private readonly owned: { dispose(): void }[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene) {
    this.pPos.fill(HIDDEN);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    const mat = new THREE.PointsMaterial({ size: 0.07, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);

    const unit = new THREE.BoxGeometry(1, 1, 1);
    const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffe2b0, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < MAX_TRACERS; i++) {
      const mesh = new THREE.Mesh(unit, tracerMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }

    const scorch = scorchTexture();
    const decalGeo = new THREE.PlaneGeometry(0.2, 0.2);
    const decalMat = new THREE.MeshBasicMaterial({ map: scorch, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    for (let i = 0; i < MAX_DECALS; i++) {
      const mesh = new THREE.Mesh(decalGeo, decalMat);
      mesh.visible = false;
      scene.add(mesh);
      this.decals.push(mesh);
    }

    const boltMat = new THREE.MeshBasicMaterial({ color: 0xff6a2a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < MAX_BOLTS; i++) {
      const mesh = new THREE.Mesh(unit, boltMat);
      mesh.scale.set(0.07, 0.07, 1.1);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.bolts.push(mesh);
    }

    scene.add(this.muzzle);
    this.owned.push(geo, mat, unit, tracerMat, scorch, decalGeo, decalMat, boltMat);
  }

  private sparks(p: Vec3, n: Vec3, count: number, speed: number, r: number, g: number, b: number): void {
    for (let i = 0; i < count; i++) {
      const k = this.pNext;
      this.pNext = (this.pNext + 1) % MAX_PARTICLES;
      const j = k * 3;
      this.pPos[j] = p.x + n.x * 0.03;
      this.pPos[j + 1] = p.y + n.y * 0.03;
      this.pPos[j + 2] = p.z + n.z * 0.03;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.pVel[j] = (n.x + (Math.random() - 0.5) * 1.4) * s;
      this.pVel[j + 1] = (n.y + (Math.random() - 0.5) * 1.4) * s + 0.6;
      this.pVel[j + 2] = (n.z + (Math.random() - 0.5) * 1.4) * s;
      this.pCol[j] = r;
      this.pCol[j + 1] = g;
      this.pCol[j + 2] = b;
      this.pLife[k] = 0.18 + Math.random() * 0.3;
    }
  }

  private tracer(from: THREE.Vector3, to: Vec3): void {
    const t = this.tracers[this.tNext];
    this.tNext = (this.tNext + 1) % MAX_TRACERS;
    this.tmp.set(to.x, to.y, to.z);
    const len = from.distanceTo(this.tmp);
    if (len < 1.5) return;
    t.mesh.position.copy(from).lerp(this.tmp, 0.5);
    t.mesh.lookAt(this.tmp);
    t.mesh.scale.set(0.012, 0.012, len);
    t.mesh.visible = true;
    t.life = 0.055;
  }

  private decal(p: Vec3, n: Vec3): void {
    const m = this.decals[this.dNext];
    this.dNext = (this.dNext + 1) % MAX_DECALS;
    m.position.set(p.x + n.x * 0.012, p.y + n.y * 0.012, p.z + n.z * 0.012);
    m.lookAt(p.x + n.x, p.y + n.y, p.z + n.z);
    m.rotation.z = Math.random() * Math.PI * 2;
    m.visible = true;
  }

  /** `muzzleWorld` is where the first-person weapon's barrel appears to be in the world. */
  onEvent(ev: SimEvent, muzzleWorld: THREE.Vector3): void {
    if (ev.type === 'shot') {
      this.muzzle.position.copy(muzzleWorld);
      this.muzzle.intensity = 26;
      for (const h of ev.hits) {
        this.tracer(muzzleWorld, h.point);
        if (!h.surface) continue;
        if (h.enemyId !== null) this.sparks(h.point, h.normal, h.crit ? 16 : 9, 3.2, 0.6, 0.9, 1);
        else {
          this.sparks(h.point, h.normal, 7, 2.6, 1, 0.75, 0.4);
          this.decal(h.point, h.normal);
        }
      }
    } else if (ev.type === 'boltImpact' && !ev.hitPlayer) {
      // A bolt that hits the player is shown by the HUD, not by sparks an inch from the camera.
      this.sparks(ev.point, ev.normal, 8, 2.4, 1, 0.4, 0.15);
      this.decal(ev.point, ev.normal);
    }
  }

  burst(p: Vec3, count: number): void {
    this.sparks(p, { x: 0, y: 1, z: 0 }, count, 3.5, 1, 0.6, 0.25);
  }

  update(sim: Simulation, alpha: number, dt: number): void {
    for (let k = 0; k < MAX_PARTICLES; k++) {
      if (this.pLife[k] <= 0) continue;
      const j = k * 3;
      this.pLife[k] -= dt;
      if (this.pLife[k] <= 0) {
        this.pPos[j + 1] = HIDDEN;
        continue;
      }
      this.pVel[j + 1] -= 9 * dt;
      this.pPos[j] += this.pVel[j] * dt;
      this.pPos[j + 1] += this.pVel[j + 1] * dt;
      this.pPos[j + 2] += this.pVel[j + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;

    for (const t of this.tracers) {
      if (!t.mesh.visible) continue;
      t.life -= dt;
      if (t.life <= 0) t.mesh.visible = false;
    }
    this.muzzle.intensity = Math.max(0, this.muzzle.intensity - dt * 420);

    for (let i = 0; i < MAX_BOLTS; i++) {
      const mesh = this.bolts[i];
      const b = sim.bolts[i];
      if (!b) {
        mesh.visible = false;
        continue;
      }
      mesh.position.set(
        b.prev.x + (b.pos.x - b.prev.x) * alpha,
        b.prev.y + (b.pos.y - b.prev.y) * alpha,
        b.prev.z + (b.pos.z - b.prev.z) * alpha,
      );
      this.tmp2.set(mesh.position.x + b.dir.x, mesh.position.y + b.dir.y, mesh.position.z + b.dir.z);
      mesh.lookAt(this.tmp2);
      mesh.visible = true;
    }
  }

  reset(): void {
    this.pLife.fill(0);
    this.pPos.fill(HIDDEN);
    for (const t of this.tracers) t.mesh.visible = false;
    for (const d of this.decals) d.visible = false;
    for (const b of this.bolts) b.visible = false;
    this.muzzle.intensity = 0;
  }

  dispose(): void {
    this.scene.remove(this.points, this.muzzle);
    for (const t of this.tracers) this.scene.remove(t.mesh);
    for (const d of this.decals) this.scene.remove(d);
    for (const b of this.bolts) this.scene.remove(b);
    for (const d of this.owned) d.dispose();
  }
}
