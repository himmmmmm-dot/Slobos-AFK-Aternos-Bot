import * as THREE from 'three';
import type { Simulation } from '../../game/sim';
import { PLAYER } from '../../shared/movement';

function flashTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 2, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,214,150,0.9)');
  grad.addColorStop(1, 'rgba(255,120,30,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  // Four spikes give the flash a shape instead of a soft blob.
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgba(255,230,190,0.7)';
  for (let i = 0; i < 4; i++) {
    g.save();
    g.translate(64, 64);
    g.rotate((i * Math.PI) / 2 + 0.4);
    g.beginPath();
    g.moveTo(0, -5);
    g.lineTo(60, 0);
    g.lineTo(0, 5);
    g.closePath();
    g.fill();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface ViewmodelFrame {
  dt: number;
  time: number;
  swayX: number;
  swayY: number;
  viewBob: boolean;
}

/**
 * First-person service pistol. It is drawn in its own scene over a cleared depth buffer with a
 * fixed field of view, so it never clips into walls and does not stretch when the FOV setting changes.
 */
export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.01, 5);
  private readonly rig = new THREE.Group();
  private readonly gun = new THREE.Group();
  private readonly slide: THREE.Mesh;
  private readonly charge: THREE.Mesh;
  private readonly flash: THREE.Mesh;
  private readonly owned: { dispose(): void }[] = [];
  private kick = 0;
  private kickVel = 0;
  private flashLife = 0;
  private swayX = 0;
  private swayY = 0;
  private bob = 0;
  private sprint = 0;
  private lastShots = 0;

  constructor() {
    // Without an environment map, strongly metallic surfaces render black, so the pistol leans on
    // diffuse response and bright dedicated lights. Reflections arrive with the Milestone 2 art pass.
    this.scene.add(new THREE.HemisphereLight(0xb9d0ee, 0x4a3524, 2.6));
    const key = new THREE.DirectionalLight(0xffd9b0, 4.5);
    key.position.set(-0.6, 1, 0.8);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7fd6ff, 2);
    rim.position.set(0.8, 0.3, -0.6);
    this.scene.add(rim);

    const box = new THREE.BoxGeometry(1, 1, 1);
    const steel = new THREE.MeshStandardMaterial({ color: 0x59636e, roughness: 0.42, metalness: 0.35 });
    const polymer = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.8, metalness: 0.05 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x46566a, roughness: 0.9, metalness: 0 });
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x7a5236, roughness: 0.95, metalness: 0 });
    const cyan = new THREE.MeshStandardMaterial({ color: 0x06141a, emissive: 0x4fd8ff, emissiveIntensity: 2.6 });
    const part = (parent: THREE.Object3D, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh => {
      const m = new THREE.Mesh(box, mat);
      m.scale.set(w, h, d);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };

    // The barrel points down -Z, like the camera.
    this.slide = part(this.gun, steel, 0.05, 0.052, 0.27, 0, 0.032, -0.035);
    part(this.gun, polymer, 0.046, 0.04, 0.23, 0, -0.012, -0.02);
    part(this.gun, steel, 0.026, 0.026, 0.03, 0, 0.03, -0.18);
    part(this.gun, steel, 0.03, 0.012, 0.012, 0, 0.064, 0.085);
    part(this.gun, steel, 0.01, 0.012, 0.012, 0, 0.064, -0.155);
    this.charge = part(this.gun, cyan, 0.053, 0.007, 0.13, 0, 0.012, -0.03);
    const grip = part(this.gun, polymer, 0.044, 0.125, 0.062, 0, -0.085, 0.075);
    grip.rotation.x = -0.24;
    part(this.gun, polymer, 0.01, 0.04, 0.07, 0, -0.045, 0.005);
    const hand = part(this.gun, glove, 0.075, 0.1, 0.1, 0.004, -0.095, 0.085);
    hand.rotation.x = -0.24;
    const arm = part(this.gun, sleeve, 0.085, 0.085, 0.55, 0.05, -0.2, 0.34);
    arm.rotation.set(-0.42, -0.16, 0);

    const flashTex = flashTexture();
    const flashMat = new THREE.MeshBasicMaterial({ map: flashTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    const flashGeo = new THREE.PlaneGeometry(0.2, 0.2);
    this.flash = new THREE.Mesh(flashGeo, flashMat);
    this.flash.position.set(0, 0.03, -0.22);
    this.flash.visible = false;
    this.gun.add(this.flash);

    this.rig.add(this.gun);
    this.scene.add(this.rig);
    this.owned.push(box, steel, polymer, glove, sleeve, cyan, flashTex, flashMat, flashGeo);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  reset(): void {
    this.kick = this.kickVel = this.flashLife = this.swayX = this.swayY = this.sprint = 0;
    this.lastShots = 0;
    this.flash.visible = false;
  }

  update(sim: Simulation, f: ViewmodelFrame): void {
    const p = sim.player;
    const w = p.weapon;
    const def = p.weaponDef;
    const dt = f.dt;

    if (w.shots !== this.lastShots) {
      if (w.shots > this.lastShots) {
        this.kickVel += 9;
        this.flashLife = 0.045;
        this.flash.rotation.z = Math.random() * Math.PI * 2;
        this.flash.scale.setScalar(0.8 + Math.random() * 0.5);
      }
      this.lastShots = w.shots;
    }
    // Critically damped spring: one firm kick that settles without oscillating. It is integrated in
    // small steps so a slow frame cannot make it unstable and fling the weapon off screen.
    const stiffness = 320;
    const damping = 36;
    for (let left = dt; left > 0; left -= 1 / 120) {
      const h = Math.min(left, 1 / 120);
      this.kickVel += (-stiffness * this.kick - damping * this.kickVel) * h;
      this.kick = Math.max(0, this.kick + this.kickVel * h);
    }
    this.flashLife -= dt;
    this.flash.visible = this.flashLife > 0;

    const body = p.move.body;
    const speed = Math.hypot(body.vel.x, body.vel.z);
    const moving = body.onGround ? Math.min(1, speed / PLAYER.walkSpeed) : 0;
    this.bob += dt * (4 + speed * 1.5);
    const bobAmp = f.viewBob ? 0.006 * moving : 0;
    this.sprint += ((p.move.sprinting && moving > 0.5 ? 1 : 0) - this.sprint) * Math.min(1, dt * 9);

    // The weapon trails the mouse slightly, then catches up.
    const lag = Math.min(1, dt * 12);
    this.swayX += (Math.max(-40, Math.min(40, f.swayX)) * -0.0009 - this.swayX) * lag;
    this.swayY += (Math.max(-40, Math.min(40, f.swayY)) * 0.0009 - this.swayY) * lag;

    let dip = 0;
    if (w.reloadLeft > 0) {
      const t = 1 - w.reloadLeft / def.reloadTicks;
      dip = Math.sin(Math.min(1, t * 1.15) * Math.PI);
    } else if (w.equipLeft > 0) {
      dip = w.equipLeft / def.equipTicks;
    }

    const breathe = Math.sin(f.time * 1.3) * 0.0015;
    this.gun.position.set(
      0.17 + this.swayX + Math.cos(this.bob) * bobAmp - this.sprint * 0.03,
      -0.155 + this.swayY + Math.abs(Math.sin(this.bob)) * bobAmp + breathe - dip * 0.16 - this.sprint * 0.05,
      -0.42 + this.kick * 0.9,
    );
    this.gun.rotation.set(this.kick * 2.4 - dip * 0.95 - this.sprint * 0.35, this.swayX * 2 + this.sprint * 0.5, dip * 0.35 + this.sprint * 0.2);
    this.slide.position.z = -0.035 + Math.min(0.045, this.kick * 1.2);

    // The charge strip shortens as the magazine empties: ammunition is readable on the weapon itself.
    const fill = Math.max(0.02, w.mag / def.magSize);
    this.charge.scale.z = 0.13 * fill;
    this.charge.position.z = -0.03 + (0.13 * (1 - fill)) / 2;
  }

  dispose(): void {
    for (const d of this.owned) d.dispose();
  }
}
