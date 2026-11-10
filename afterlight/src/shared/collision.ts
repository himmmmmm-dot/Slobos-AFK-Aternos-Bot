import type { Vec3 } from './math';

export interface Solid {
  min: Vec3;
  max: Vec3;
  /** Wedge whose top surface rises from min.y to max.y towards +axis (dir 1) or -axis (dir -1). */
  ramp?: { axis: 'x' | 'z'; dir: 1 | -1 };
  /** Presentation hint; the simulation never reads it. */
  tag?: string;
}

export interface CollisionWorld {
  solids: Solid[];
}

export interface RayHit {
  t: number;
  point: Vec3;
  normal: Vec3;
  solid: Solid;
}

const EDGE = 1e-4;
export const SKIN = 1e-3;

/** Does the square footprint centred on (x, z) with half-width r overlap the solid in plan view? */
export function overlapsXZ(s: Solid, x: number, z: number, r: number): boolean {
  return x + r > s.min.x + EDGE && x - r < s.max.x - EDGE && z + r > s.min.z + EDGE && z - r < s.max.z - EDGE;
}

/** Highest point of the solid's top surface under the footprint. Ramps use the uphill edge. */
export function footprintTop(s: Solid, x: number, z: number, r: number): number {
  const ramp = s.ramp;
  if (!ramp) return s.max.y;
  const lo = s.min[ramp.axis];
  const hi = s.max[ramp.axis];
  const c = ramp.axis === 'x' ? x : z;
  const t = ramp.dir === 1 ? (c + r - lo) / (hi - lo) : (hi - (c - r)) / (hi - lo);
  return s.min.y + (t < 0 ? 0 : t > 1 ? 1 : t) * (s.max.y - s.min.y);
}

/** True when a character box with its feet at y fits without intersecting any solid. */
export function boxFree(world: CollisionWorld, x: number, y: number, z: number, r: number, h: number): boolean {
  for (const s of world.solids) {
    if (!overlapsXZ(s, x, z, r)) continue;
    if (footprintTop(s, x, z, r) > y + SKIN && s.min.y < y + h - SKIN) return false;
  }
  return true;
}

let nx = 0;
let ny = 0;
let nz = 0;

/** Entry distance of a ray into an axis-aligned box, or -1. Sets the scratch normal. */
function slab(o: Vec3, d: Vec3, min: Vec3, max: Vec3, maxT: number, out: { t0: number; t1: number }): boolean {
  let t0 = 0;
  let t1 = maxT;
  nx = ny = nz = 0;
  let ta: number;
  let tb: number;
  let sign: number;

  if (Math.abs(d.x) < 1e-12) {
    if (o.x < min.x || o.x > max.x) return false;
  } else {
    ta = (min.x - o.x) / d.x;
    tb = (max.x - o.x) / d.x;
    sign = -1;
    if (ta > tb) {
      const tmp = ta;
      ta = tb;
      tb = tmp;
      sign = 1;
    }
    if (ta > t0) {
      t0 = ta;
      nx = sign;
      ny = nz = 0;
    }
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }

  if (Math.abs(d.y) < 1e-12) {
    if (o.y < min.y || o.y > max.y) return false;
  } else {
    ta = (min.y - o.y) / d.y;
    tb = (max.y - o.y) / d.y;
    sign = -1;
    if (ta > tb) {
      const tmp = ta;
      ta = tb;
      tb = tmp;
      sign = 1;
    }
    if (ta > t0) {
      t0 = ta;
      ny = sign;
      nx = nz = 0;
    }
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }

  if (Math.abs(d.z) < 1e-12) {
    if (o.z < min.z || o.z > max.z) return false;
  } else {
    ta = (min.z - o.z) / d.z;
    tb = (max.z - o.z) / d.z;
    sign = -1;
    if (ta > tb) {
      const tmp = ta;
      ta = tb;
      tb = tmp;
      sign = 1;
    }
    if (ta > t0) {
      t0 = ta;
      nz = sign;
      nx = ny = 0;
    }
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }

  out.t0 = t0;
  out.t1 = t1;
  return true;
}

const span = { t0: 0, t1: 0 };

/** Ray against a box (entities). Returns the entry distance or -1; d must be normalised. */
export function rayAabb(o: Vec3, d: Vec3, min: Vec3, max: Vec3, maxT: number): number {
  return slab(o, d, min, max, maxT, span) ? span.t0 : -1;
}

function raySolid(o: Vec3, d: Vec3, s: Solid, maxT: number): number {
  if (!slab(o, d, s.min, s.max, maxT, span)) return -1;
  let t0 = span.t0;
  const ramp = s.ramp;
  if (ramp) {
    // The wedge is the box clipped by the half-space under the sloped plane f(p) <= 0.
    const lo = s.min[ramp.axis];
    const hi = s.max[ramp.axis];
    const k = (s.max.y - s.min.y) / (hi - lo);
    const u0 = ramp.dir === 1 ? o[ramp.axis] - lo : hi - o[ramp.axis];
    const f0 = o.y - s.min.y - k * u0;
    const fd = d.y - k * ramp.dir * d[ramp.axis];
    let t1 = span.t1;
    if (Math.abs(fd) < 1e-12) {
      if (f0 > 0) return -1;
    } else {
      const tc = -f0 / fd;
      if (fd > 0) {
        if (tc < t1) t1 = tc;
      } else if (tc > t0) {
        t0 = tc;
        const inv = 1 / Math.hypot(k, 1);
        nx = ramp.axis === 'x' ? -k * ramp.dir * inv : 0;
        nz = ramp.axis === 'z' ? -k * ramp.dir * inv : 0;
        ny = inv;
      }
      if (t0 > t1) return -1;
    }
  }
  if (nx === 0 && ny === 0 && nz === 0) {
    // Origin started inside the solid: report an immediate hit facing the ray.
    nx = -d.x;
    ny = -d.y;
    nz = -d.z;
  }
  return t0;
}

/** Nearest solid hit along a normalised ray within maxDist, or null. */
export function raycast(world: CollisionWorld, o: Vec3, d: Vec3, maxDist: number): RayHit | null {
  let best = maxDist;
  let hit: Solid | null = null;
  let bx = 0;
  let by = 0;
  let bz = 0;
  for (const s of world.solids) {
    const t = raySolid(o, d, s, best);
    if (t >= 0 && t < best) {
      best = t;
      hit = s;
      bx = nx;
      by = ny;
      bz = nz;
    }
  }
  if (!hit) return null;
  return {
    t: best,
    point: { x: o.x + d.x * best, y: o.y + d.y * best, z: o.z + d.z * best },
    normal: { x: bx, y: by, z: bz },
    solid: hit,
  };
}

/** True when nothing solid lies between two points. */
export function clearLine(world: CollisionWorld, a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  return raycast(world, a, { x: dx / len, y: dy / len, z: dz / len }, Math.max(0, len - 0.05)) === null;
}
