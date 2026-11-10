import * as THREE from 'three';
import type { Solid } from '../../shared/collision';
import type { LevelDef } from '../../game/level';

type V = [number, number, number];

/** One texture tile covers 2 m, so every panel seam in the level is a 1 m scale reference. */
const UV_SCALE = 0.5;

/** Builds flat-shaded geometry with world-space UVs from boxes and wedges. */
class GeoBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];

  /** Adds a convex face. `hint` is any vector on the outward side; winding is fixed to match it. */
  face(verts: V[], hint: V): void {
    const [a, b, c] = verts;
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) {
      verts = [...verts].reverse();
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const base = this.pos.length / 3;
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    for (const v of verts) {
      this.pos.push(v[0], v[1], v[2]);
      this.nrm.push(nx, ny, nz);
      if (ay >= ax && ay >= az) this.uv.push(v[0] * UV_SCALE, v[2] * UV_SCALE);
      else if (ax >= az) this.uv.push(v[2] * UV_SCALE, v[1] * UV_SCALE);
      else this.uv.push(v[0] * UV_SCALE, v[1] * UV_SCALE);
    }
    for (let i = 1; i < verts.length - 1; i++) this.idx.push(base, base + i, base + i + 1);
  }

  solid(s: Solid): void {
    const a = s.min;
    const b = s.max;
    if (!s.ramp) {
      this.face([[b.x, a.y, a.z], [b.x, b.y, a.z], [b.x, b.y, b.z], [b.x, a.y, b.z]], [1, 0, 0]);
      this.face([[a.x, a.y, a.z], [a.x, b.y, a.z], [a.x, b.y, b.z], [a.x, a.y, b.z]], [-1, 0, 0]);
      this.face([[a.x, b.y, a.z], [b.x, b.y, a.z], [b.x, b.y, b.z], [a.x, b.y, b.z]], [0, 1, 0]);
      this.face([[a.x, a.y, a.z], [b.x, a.y, a.z], [b.x, a.y, b.z], [a.x, a.y, b.z]], [0, -1, 0]);
      this.face([[a.x, a.y, b.z], [b.x, a.y, b.z], [b.x, b.y, b.z], [a.x, b.y, b.z]], [0, 0, 1]);
      this.face([[a.x, a.y, a.z], [b.x, a.y, a.z], [b.x, b.y, a.z], [a.x, b.y, a.z]], [0, 0, -1]);
      return;
    }
    const axis = s.ramp.axis;
    const lo = s.ramp.dir === 1 ? a[axis] : b[axis];
    const hi = s.ramp.dir === 1 ? b[axis] : a[axis];
    const p0 = axis === 'x' ? a.z : a.x;
    const p1 = axis === 'x' ? b.z : b.x;
    const pt = (along: number, perp: number, y: number): V => (axis === 'x' ? [along, y, perp] : [perp, y, along]);
    const sign = hi > lo ? 1 : -1;
    const alongDir: V = axis === 'x' ? [sign, 0, 0] : [0, 0, sign];
    const perpDir: V = axis === 'x' ? [0, 0, 1] : [1, 0, 0];
    this.face([pt(lo, p0, a.y), pt(lo, p1, a.y), pt(hi, p1, b.y), pt(hi, p0, b.y)], [0, 1, 0]);
    this.face([pt(hi, p0, a.y), pt(hi, p1, a.y), pt(hi, p1, b.y), pt(hi, p0, b.y)], alongDir);
    this.face([pt(lo, p0, a.y), pt(lo, p1, a.y), pt(hi, p1, a.y), pt(hi, p0, a.y)], [0, -1, 0]);
    this.face([pt(lo, p0, a.y), pt(hi, p0, a.y), pt(hi, p0, b.y)], [-perpDir[0], 0, -perpDir[2]]);
    this.face([pt(lo, p1, a.y), pt(hi, p1, a.y), pt(hi, p1, b.y)], perpDir);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Neutral panel texture drawn at runtime; each surface tints it through its material colour. */
function panelTexture(): THREE.CanvasTexture {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c9cdd2';
  g.fillRect(0, 0, size, size);
  const img = g.getImageData(0, 0, size, size);
  let seed = 90210;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const n = ((seed >>> 24) - 128) * 0.1;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const half = size / 2;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const x = i * half;
      const y = j * half;
      g.strokeStyle = 'rgba(16,22,30,0.6)';
      g.lineWidth = 4;
      g.strokeRect(x + 2, y + 2, half - 4, half - 4);
      g.strokeStyle = 'rgba(255,255,255,0.2)';
      g.lineWidth = 1;
      g.strokeRect(x + 6.5, y + 6.5, half - 13, half - 13);
      g.fillStyle = 'rgba(16,22,30,0.45)';
      for (const [rx, ry] of [[18, 18], [half - 18, 18], [18, half - 18], [half - 18, half - 18]]) {
        g.beginPath();
        g.arc(x + rx, y + ry, 3.5, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Deep blue-grey architecture, warmer props for cover, so the playable shapes read first. */
const SURFACES: Record<string, { color: number; roughness: number; metalness: number }> = {
  floor: { color: 0x3b4551, roughness: 0.5, metalness: 0.15 },
  wall: { color: 0x48535f, roughness: 0.9, metalness: 0.05 },
  ceiling: { color: 0x272e36, roughness: 0.95, metalness: 0 },
  pillar: { color: 0x596572, roughness: 0.8, metalness: 0.1 },
  platform: { color: 0x40505f, roughness: 0.6, metalness: 0.45 },
  rail: { color: 0x687582, roughness: 0.5, metalness: 0.6 },
  cover: { color: 0x7a848e, roughness: 0.75, metalness: 0.2 },
  hazard: { color: 0x6c7076, roughness: 0.7, metalness: 0.3 },
  kiosk: { color: 0x2e3a46, roughness: 0.45, metalness: 0.5 },
  bench: { color: 0x4e5964, roughness: 0.6, metalness: 0.4 },
  crate: { color: 0x846848, roughness: 0.85, metalness: 0.05 },
  console: { color: 0x26333e, roughness: 0.4, metalness: 0.6 },
  rack: { color: 0x2c3741, roughness: 0.5, metalness: 0.6 },
};

export interface LevelView {
  group: THREE.Group;
  spot: THREE.SpotLight | null;
  pickups: Map<string, THREE.Object3D>;
  dispose(): void;
}

export function buildLevel(level: LevelDef): LevelView {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const texture = panelTexture();
  disposables.push(texture);

  // One merged mesh per surface type keeps the static world to a dozen draw calls.
  const byTag = new Map<string, GeoBuilder>();
  for (const s of level.solids) {
    const tag = s.tag && SURFACES[s.tag] ? s.tag : 'wall';
    let b = byTag.get(tag);
    if (!b) byTag.set(tag, (b = new GeoBuilder()));
    b.solid(s);
  }
  for (const [tag, builder] of byTag) {
    const geo = builder.build();
    const mat = new THREE.MeshStandardMaterial({ ...SURFACES[tag], map: texture });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    disposables.push(geo, mat);
  }

  const amb = level.ambient;
  group.add(new THREE.HemisphereLight(amb.sky, amb.ground, amb.hemi));

  const fixtureGeo = new THREE.BoxGeometry(0.7, 0.1, 0.24);
  disposables.push(fixtureGeo);
  const fixtureMats = new Map<number, THREE.MeshStandardMaterial>();
  for (const l of level.lights) {
    const light = new THREE.PointLight(l.color, l.intensity, l.distance, 2);
    light.position.set(l.pos.x, l.pos.y, l.pos.z);
    group.add(light);
    let mat = fixtureMats.get(l.color);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color: 0x111417, emissive: l.color, emissiveIntensity: 3 });
      fixtureMats.set(l.color, mat);
      disposables.push(mat);
    }
    // Every light has a visible source, placed just above it.
    const fixture = new THREE.Mesh(fixtureGeo, mat);
    fixture.position.set(l.pos.x, l.pos.y + 0.22, l.pos.z);
    group.add(fixture);
  }

  let spot: THREE.SpotLight | null = null;
  if (level.spot) {
    const s = level.spot;
    spot = new THREE.SpotLight(s.color, s.intensity, 30, s.angle, 0.55, 2);
    spot.position.set(s.pos.x, s.pos.y, s.pos.z);
    spot.target.position.set(s.target.x, s.target.y, s.target.z);
    spot.shadow.bias = -0.0015;
    spot.shadow.normalBias = 0.03;
    spot.shadow.camera.near = 0.5;
    spot.shadow.camera.far = 30;
    group.add(spot, spot.target);
  }

  for (const a of level.accents) {
    const geo = new THREE.BoxGeometry(a.max.x - a.min.x, a.max.y - a.min.y, a.max.z - a.min.z);
    const mat = new THREE.MeshStandardMaterial({ color: 0x0b1014, emissive: a.color, emissiveIntensity: a.intensity });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((a.min.x + a.max.x) / 2, (a.min.y + a.max.y) / 2, (a.min.z + a.max.z) / 2);
    group.add(mesh);
    disposables.push(geo, mat);
  }

  // Medical cells: a cross shape, so they read without relying on colour.
  const pickups = new Map<string, THREE.Object3D>();
  const barGeo = new THREE.BoxGeometry(0.34, 0.11, 0.11);
  const cellMat = new THREE.MeshStandardMaterial({ color: 0x18241f, emissive: 0x7dffb0, emissiveIntensity: 1.8 });
  disposables.push(barGeo, cellMat);
  for (const p of level.pickups) {
    const cell = new THREE.Group();
    const h = new THREE.Mesh(barGeo, cellMat);
    const v = new THREE.Mesh(barGeo, cellMat);
    v.rotation.z = Math.PI / 2;
    cell.add(h, v);
    cell.position.set(p.pos.x, p.pos.y + 0.6, p.pos.z);
    group.add(cell);
    pickups.set(p.id, cell);
  }

  group.updateMatrixWorld(true);
  return {
    group,
    spot,
    pickups,
    dispose: () => {
      for (const d of disposables) d.dispose();
      spot?.shadow.map?.dispose();
    },
  };
}
