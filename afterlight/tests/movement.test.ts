import { describe, expect, it } from 'vitest';
import { clearLine, raycast, type CollisionWorld, type Solid } from '../src/shared/collision';
import { normalize, vec3 } from '../src/shared/math';
import { createPlayerMove, PLAYER, stepPlayerMove, type MoveInput, type PlayerMove } from '../src/shared/movement';
import { NavGrid } from '../src/game/nav';
import { box } from './helpers';

const FLOOR = box(-50, -1, -50, 50, 0, 50);
const world = (...extra: Solid[]): CollisionWorld => ({ solids: [FLOOR, ...extra] });
const IDLE: MoveInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, sprint: false, crouch: false };

/** Settles the player on the ground, then runs `ticks` of input. Yaw 0 walks towards -Z. */
function walk(
  w: CollisionWorld,
  m: PlayerMove,
  ticks: number,
  input: Partial<MoveInput> | ((t: number) => Partial<MoveInput>),
  each?: (m: PlayerMove, t: number) => void,
): void {
  for (let t = 0; t < ticks; t++) {
    stepPlayerMove(w, m, { ...IDLE, ...(typeof input === 'function' ? input(t) : input) });
    each?.(m, t);
  }
}

function spawn(w: CollisionWorld, x = 0, y = 0, z = 0): PlayerMove {
  const m = createPlayerMove(vec3(x, y, z));
  walk(w, m, 5, {});
  return m;
}

describe('player movement', () => {
  it('reaches walk speed, sprints faster and crouch-walks slower', () => {
    const w = world();
    const speedOf = (input: Partial<MoveInput>): number => {
      const m = spawn(w);
      walk(w, m, 90, { moveZ: 1, ...input });
      return Math.hypot(m.body.vel.x, m.body.vel.z);
    };
    expect(speedOf({})).toBeCloseTo(PLAYER.walkSpeed, 3);
    expect(speedOf({ sprint: true })).toBeCloseTo(PLAYER.sprintSpeed, 3);
    expect(speedOf({ crouch: true })).toBeCloseTo(PLAYER.crouchSpeed, 3);
  });

  it('does not move faster on a diagonal', () => {
    const w = world();
    const m = spawn(w);
    walk(w, m, 90, { moveZ: 1, moveX: 1 });
    expect(Math.hypot(m.body.vel.x, m.body.vel.z)).toBeCloseTo(PLAYER.walkSpeed, 3);
  });

  it('stops flush against a wall without entering it', () => {
    const w = world(box(-5, 0, -6, 5, 3, -5));
    const m = spawn(w);
    walk(w, m, 240, { moveZ: 1, sprint: true });
    expect(m.body.pos.z).toBeGreaterThanOrEqual(-5 + PLAYER.radius);
    expect(m.body.pos.z).toBeLessThan(-5 + PLAYER.radius + 0.01);
    expect(m.body.vel.z).toBe(0);
  });

  it('slides along a wall when pushed into it at an angle', () => {
    const w = world(box(-20, 0, -6, 20, 3, -5));
    const m = spawn(w);
    walk(w, m, 240, { moveZ: 1, moveX: 1 });
    expect(m.body.pos.x).toBeGreaterThan(5);
    expect(m.body.pos.z).toBeGreaterThanOrEqual(-5 + PLAYER.radius);
  });

  it('does not tunnel through a thin wall at sprint speed', () => {
    const w = world(box(-5, 0, -5.05, 5, 3, -5));
    const m = spawn(w);
    walk(w, m, 300, { moveZ: 1, sprint: true });
    expect(m.body.pos.z).toBeGreaterThanOrEqual(-5 + PLAYER.radius);
  });

  it('steps onto a low ledge but is stopped by one taller than the step height', () => {
    const low = world(box(-5, 0, -10, 5, 0.45, -3));
    const a = spawn(low);
    walk(low, a, 120, { moveZ: 1 });
    expect(a.body.pos.y).toBeCloseTo(0.45, 5);
    expect(a.body.pos.z).toBeLessThan(-4);

    const tall = world(box(-5, 0, -10, 5, 0.6, -3));
    const b = spawn(tall);
    walk(tall, b, 120, { moveZ: 1 });
    expect(b.body.pos.y).toBeCloseTo(0, 5);
    expect(b.body.pos.z).toBeGreaterThanOrEqual(-3 + PLAYER.radius);
  });

  it('walks up a ramp and stays grounded all the way back down', () => {
    const ramp: Solid = { min: vec3(-2, 0, -10), max: vec3(2, 3, -2), ramp: { axis: 'z', dir: -1 } };
    const w = world(ramp, box(-2, 0, -16, 2, 3, -10));
    const m = spawn(w);
    walk(w, m, 200, { moveZ: 1 });
    expect(m.body.pos.y).toBeCloseTo(3, 5);
    expect(m.body.pos.z).toBeLessThan(-10);
    let airborne = 0;
    walk(w, m, 200, { moveZ: -1 }, (pm) => {
      if (!pm.body.onGround) airborne++;
    });
    expect(airborne).toBe(0);
    expect(m.body.pos.y).toBeCloseTo(0, 5);
  });

  it('jumps to the expected height and lands', () => {
    const w = world();
    const m = spawn(w);
    let apex = 0;
    let landed = false;
    for (let t = 0; t < 80; t++) {
      const ev = stepPlayerMove(w, m, { ...IDLE, jump: t === 0 });
      apex = Math.max(apex, m.body.pos.y);
      if (ev.landed) landed = true;
    }
    const ideal = PLAYER.jumpSpeed ** 2 / (2 * PLAYER.gravity);
    expect(apex).toBeGreaterThan(ideal - 0.12);
    expect(apex).toBeLessThan(ideal + 0.02);
    expect(landed).toBe(true);
    expect(m.body.onGround).toBe(true);
  });

  it('honours a jump pressed just before landing and just after leaving a ledge', () => {
    const w = world(box(-2, 0, -2, 2, 2, 2));
    // Buffered: press while still falling, a few ticks above the floor.
    const a = spawn(world());
    walk(world(), a, 1, { jump: true });
    let jumps = 1;
    for (let t = 0; t < 120; t++) {
      const press = !a.body.onGround && a.body.vel.y < 0 && a.body.pos.y < 0.3;
      if (stepPlayerMove(world(), a, { ...IDLE, jump: press }).jumped) jumps++;
    }
    expect(jumps).toBeGreaterThanOrEqual(2);
    // Coyote: walk off the ledge, then jump two ticks later.
    const b = spawn(w, 0, 2, 0);
    let left = -1;
    let jumped = false;
    for (let t = 0; t < 120 && !jumped; t++) {
      if (left < 0 && !b.body.onGround) left = t;
      jumped = stepPlayerMove(w, b, { ...IDLE, moveZ: 1, jump: left >= 0 && t === left + 2 }).jumped;
    }
    expect(left).toBeGreaterThan(0);
    expect(jumped).toBe(true);
  });

  it('vaults a 0.9 m barricade with a jump and is blocked without one', () => {
    const w = world(box(-5, 0, -6, 5, 0.9, -5.4));
    const blocked = spawn(w);
    walk(w, blocked, 200, { moveZ: 1 });
    expect(blocked.body.pos.z).toBeGreaterThan(-5.4);
    const m = spawn(w);
    walk(w, m, 200, (t) => ({ moveZ: 1, jump: t === 50 }));
    expect(m.body.pos.z).toBeLessThan(-7);
    expect(m.body.pos.y).toBeCloseTo(0, 5);
  });

  it('crouches under a low beam, cannot stand beneath it, and stands again once clear', () => {
    const w = world(box(-5, 1.3, -8, 5, 3, -5));
    const standing = spawn(w);
    walk(w, standing, 200, { moveZ: 1 });
    expect(standing.body.pos.z).toBeGreaterThanOrEqual(-5 + PLAYER.radius);

    const m = spawn(w);
    walk(w, m, 400, { moveZ: 1, crouch: true }, (pm) => {
      if (pm.body.pos.z < -6 && pm.body.pos.z > -7) return;
    });
    expect(m.body.pos.z).toBeLessThan(-8.5);
    // Back under the beam, releasing crouch must not stand the player up.
    const under = spawn(w);
    walk(w, under, 400, (t) => ({ moveZ: under.body.pos.z > -6.5 ? 1 : 0, crouch: t < 200 }));
    expect(under.body.pos.z).toBeLessThan(-5.5);
    expect(under.crouched).toBe(true);
    walk(w, under, 200, { moveZ: 1 });
    expect(under.body.pos.z).toBeLessThan(-8.5);
    expect(under.crouched).toBe(false);
  });

  it('falls when it walks off a ledge and reports the landing', () => {
    const w = world(box(-2, 0, -2, 2, 2, 2));
    const m = spawn(w, 0, 2, 0);
    expect(m.body.pos.y).toBeCloseTo(2, 5);
    let wasAirborne = false;
    let landSpeed = 0;
    for (let t = 0; t < 200; t++) {
      const ev = stepPlayerMove(w, m, { ...IDLE, moveZ: 1 });
      if (!m.body.onGround) wasAirborne = true;
      if (ev.landed) landSpeed = ev.landSpeed;
    }
    expect(wasAirborne).toBe(true);
    expect(landSpeed).toBeGreaterThan(4);
    expect(m.body.pos.y).toBeCloseTo(0, 5);
  });
});

describe('ray casting', () => {
  it('hits the near face of a box with the right normal and distance', () => {
    const w = world(box(-1, 0, -6, 1, 2, -5));
    const hit = raycast(w, vec3(0, 1, 0), vec3(0, 0, -1), 50);
    expect(hit?.t).toBeCloseTo(5, 6);
    expect(hit?.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(raycast(w, vec3(3, 1, 0), vec3(0, 0, -1), 50)).toBeNull();
    expect(raycast(w, vec3(0, 1, 0), vec3(0, 0, -1), 4)).toBeNull();
  });

  it('hits a ramp on its slope, not its bounding box', () => {
    const ramp: Solid = { min: vec3(-2, 0, -10), max: vec3(2, 4, -2), ramp: { axis: 'z', dir: -1 } };
    const w: CollisionWorld = { solids: [ramp] };
    // Half-way along, the surface is 2 m up; a ray at 3 m passes over the low half.
    const hit = raycast(w, vec3(0, 3, 5), vec3(0, 0, -1), 50);
    expect(hit?.point.z).toBeCloseTo(-8, 5);
    expect(hit?.normal.y).toBeGreaterThan(0.5);
    const down = raycast(w, vec3(0, 10, -6), vec3(0, -1, 0), 50);
    expect(down?.point.y).toBeCloseTo(2, 5);
  });

  it('reports whether two points can see each other', () => {
    const w = world(box(-1, 0, -1, 1, 3, 1));
    expect(clearLine(w, vec3(0, 1, 5), vec3(0, 1, -5))).toBe(false);
    expect(clearLine(w, vec3(3, 1, 5), vec3(3, 1, -5))).toBe(true);
    expect(clearLine(w, vec3(0, 4, 5), vec3(0, 4, -5))).toBe(true);
    const d = normalize(vec3(1, 0, -1));
    expect(raycast(w, vec3(-5, 1, 5), d, 50)?.t).toBeGreaterThan(5);
  });
});

describe('navigation grid', () => {
  const bounds = { minX: -12, maxX: 12, minZ: -12, maxZ: 12 };

  it('routes around a wall with a walkable path', () => {
    const w = world(box(-6, 0, -0.5, 6, 3, 0.5));
    const nav = NavGrid.build(w, bounds, [vec3(0, 0, 5)]);
    const path = nav.findPath(vec3(0, 0, 5), vec3(0, 0, -5));
    expect(path).not.toBeNull();
    let len = 0;
    for (let i = 1; i < path!.length; i++) {
      expect(nav.walkable(path![i - 1], path![i])).toBe(true);
      len += Math.hypot(path![i].x - path![i - 1].x, path![i].z - path![i - 1].z);
    }
    expect(len).toBeGreaterThan(14);
    expect(len).toBeLessThan(24);
  });

  it('climbs a ramp to an upper floor and keeps both floors as separate layers', () => {
    const ramp: Solid = { min: vec3(-2, 0, -4), max: vec3(2, 3, 4), ramp: { axis: 'z', dir: -1 } };
    const w = world(ramp, box(-8, 2.6, -10, 8, 3, -4));
    const nav = NavGrid.build(w, bounds, [vec3(0, 0, 8)]);
    const up = nav.findPath(vec3(0, 0, 8), vec3(6, 3, -8));
    expect(up).not.toBeNull();
    expect(up![up!.length - 1].y).toBeCloseTo(3, 3);
    // The floor under the platform is a different node from the platform above it.
    expect(nav.nearest(vec3(6, 0, -8))?.y).toBeCloseTo(0, 3);
    expect(nav.nearest(vec3(6, 3, -8))?.y).toBeCloseTo(3, 3);
  });

  it('returns no path to somewhere that cannot be walked to', () => {
    const sealed = world(box(-3, 0, -3, 3, 3, -2.5), box(-3, 0, 2.5, 3, 3, 3), box(-3, 0, -3, -2.5, 3, 3), box(2.5, 0, -3, 3, 3, 3));
    const nav = NavGrid.build(sealed, bounds, [vec3(8, 0, 8), vec3(0, 0, 0)]);
    expect(nav.findPath(vec3(8, 0, 8), vec3(0, 0, 0))).toBeNull();
    const ledge = world(box(4, 0, 4, 8, 2, 8));
    const nav2 = NavGrid.build(ledge, bounds, [vec3(-8, 0, -8)]);
    expect(nav2.findPath(vec3(-8, 0, -8), vec3(6, 2, 6))).toBeNull();
  });
});
