import { TICK_DT } from './constants';
import { boxFree, footprintTop, overlapsXZ, SKIN, type CollisionWorld } from './collision';
import { clamp, type Vec3 } from './math';

export interface CharBody {
  /** Centre of the feet. */
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
}

export interface CharShape {
  radius: number;
  height: number;
}

export interface MoveOptions {
  stepHeight: number;
  /** Largest drop a grounded character follows without leaving the ground (slopes, stairs). */
  snapDown: number;
}

export interface MoveResult {
  hitWall: boolean;
  landed: boolean;
  landSpeed: number;
}

/** Small ledge assist while airborne so near-miss jumps onto cover still land. */
const AIR_STEP = 0.25;
const SUPPORT_TOL = 0.02;

/** Tries one sub-step along an axis. Returns false when an obstacle shortened or stopped it. */
function advance(
  world: CollisionWorld,
  body: CharBody,
  shape: CharShape,
  axis: 'x' | 'z',
  d: number,
  stepHeight: number,
): boolean {
  const p = body.pos;
  const r = shape.radius;
  const h = shape.height;
  let target = p[axis] + d;
  let unobstructed = true;
  for (let iter = 0; iter < 3; iter++) {
    const x = axis === 'x' ? target : p.x;
    const z = axis === 'z' ? target : p.z;
    let limit = target;
    let blocked = false;
    let stepTo = p.y;
    for (const s of world.solids) {
      if (!overlapsXZ(s, x, z, r)) continue;
      const top = footprintTop(s, x, z, r);
      if (top <= p.y + SKIN || s.min.y >= p.y + h - SKIN) continue;
      if (top - p.y <= stepHeight) {
        if (top > stepTo) stepTo = top;
        continue;
      }
      blocked = true;
      const face = d > 0 ? s.min[axis] - r - SKIN : s.max[axis] + r + SKIN;
      limit = d > 0 ? Math.min(limit, face) : Math.max(limit, face);
    }
    if (!blocked && stepTo > p.y && !boxFree(world, x, stepTo, z, r, h)) {
      blocked = true;
      limit = p[axis];
    }
    if (!blocked) {
      p[axis] = target;
      if (stepTo > p.y) {
        p.y = stepTo;
        if (body.vel.y < 0) body.vel.y = 0;
      }
      return unobstructed;
    }
    unobstructed = false;
    // Slide up to the obstacle face, never backwards.
    const next = d > 0 ? Math.max(p[axis], limit) : Math.min(p[axis], limit);
    if (next === p[axis]) return false;
    target = next;
  }
  return false;
}

function moveAxis(
  world: CollisionWorld,
  body: CharBody,
  shape: CharShape,
  axis: 'x' | 'z',
  delta: number,
  stepHeight: number,
): boolean {
  if (delta === 0) return false;
  // Sub-step so a fast character cannot skip past thin geometry.
  const n = Math.max(1, Math.ceil(Math.abs(delta) / (shape.radius * 0.9)));
  const d = delta / n;
  for (let i = 0; i < n; i++) {
    if (!advance(world, body, shape, axis, d, stepHeight)) {
      body.vel[axis] = 0;
      return true;
    }
  }
  return false;
}

/** Moves a character box by its velocity, resolving walls, steps, slopes, floors and ceilings. */
export function moveBody(
  world: CollisionWorld,
  body: CharBody,
  shape: CharShape,
  dt: number,
  opts: MoveOptions,
): MoveResult {
  const res: MoveResult = { hitWall: false, landed: false, landSpeed: 0 };
  const wasGrounded = body.onGround;
  const step = wasGrounded ? opts.stepHeight : Math.min(opts.stepHeight, AIR_STEP);
  if (moveAxis(world, body, shape, 'x', body.vel.x * dt, step)) res.hitWall = true;
  if (moveAxis(world, body, shape, 'z', body.vel.z * dt, step)) res.hitWall = true;

  const p = body.pos;
  const r = shape.radius;
  const dy = body.vel.y * dt;
  if (dy <= 0) {
    let support = -Infinity;
    for (const s of world.solids) {
      if (!overlapsXZ(s, p.x, p.z, r)) continue;
      const top = footprintTop(s, p.x, p.z, r);
      if (top <= p.y + SUPPORT_TOL && top > support) support = top;
    }
    if (support >= p.y + dy - SKIN) {
      if (!wasGrounded) {
        res.landed = true;
        res.landSpeed = -body.vel.y;
      }
      p.y = support;
      body.vel.y = 0;
      body.onGround = true;
    } else if (wasGrounded && p.y - support <= opts.snapDown) {
      p.y = support;
      body.vel.y = 0;
      body.onGround = true;
    } else {
      p.y += dy;
      body.onGround = false;
    }
  } else {
    let ceiling = Infinity;
    const head = p.y + shape.height;
    for (const s of world.solids) {
      if (!overlapsXZ(s, p.x, p.z, r)) continue;
      if (s.min.y >= head - SUPPORT_TOL && s.min.y < ceiling) ceiling = s.min.y;
    }
    if (head + dy > ceiling) {
      p.y = ceiling - shape.height;
      body.vel.y = 0;
    } else {
      p.y += dy;
    }
    body.onGround = false;
  }
  return res;
}

export const PLAYER = {
  radius: 0.32,
  standHeight: 1.8,
  crouchHeight: 1.15,
  standEye: 1.62,
  crouchEye: 0.98,
  walkSpeed: 4.8,
  sprintSpeed: 7,
  crouchSpeed: 2.4,
  groundAccel: 60,
  airAccel: 14,
  gravity: 20,
  jumpSpeed: 6.6,
  terminalSpeed: 40,
  stepHeight: 0.5,
  snapDown: 0.35,
  /** Grace ticks after leaving a ledge during which a jump still counts. */
  coyoteTicks: 6,
  /** A jump pressed this many ticks before landing still fires. */
  jumpBufferTicks: 7,
} as const;

export interface MoveInput {
  /** Strafe, right positive, -1..1. */
  moveX: number;
  /** Forward positive, -1..1. */
  moveZ: number;
  yaw: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
}

export interface PlayerMove {
  body: CharBody;
  crouched: boolean;
  sprinting: boolean;
  /** Smoothed eye height above the feet. */
  eye: number;
  coyote: number;
  jumpBuffer: number;
  jumpWasDown: boolean;
  stride: number;
}

export interface MoveEvents {
  jumped: boolean;
  landed: boolean;
  landSpeed: number;
  footstep: boolean;
}

export function createPlayerMove(pos: Vec3): PlayerMove {
  return {
    body: { pos: { x: pos.x, y: pos.y, z: pos.z }, vel: { x: 0, y: 0, z: 0 }, onGround: false },
    crouched: false,
    sprinting: false,
    eye: PLAYER.standEye,
    coyote: 0,
    jumpBuffer: 0,
    jumpWasDown: false,
    stride: 0,
  };
}

export function playerShape(m: PlayerMove): CharShape {
  return { radius: PLAYER.radius, height: m.crouched ? PLAYER.crouchHeight : PLAYER.standHeight };
}

/** Advances the first-person controller by one fixed tick. */
export function stepPlayerMove(world: CollisionWorld, m: PlayerMove, input: MoveInput, dt = TICK_DT): MoveEvents {
  const ev: MoveEvents = { jumped: false, landed: false, landSpeed: 0, footstep: false };
  const b = m.body;
  const p = b.pos;

  if (input.crouch) m.crouched = true;
  else if (m.crouched && boxFree(world, p.x, p.y, p.z, PLAYER.radius, PLAYER.standHeight)) m.crouched = false;

  let mx = clamp(input.moveX, -1, 1);
  let mz = clamp(input.moveZ, -1, 1);
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  const wishX = cos * mx - sin * mz;
  const wishZ = -sin * mx - cos * mz;
  m.sprinting = input.sprint && !m.crouched && mz > 0.1;
  const speed = m.crouched ? PLAYER.crouchSpeed : m.sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed;

  // Momentum is kept in the air when no direction is held.
  if (b.onGround || len > 0) {
    const dvx = wishX * speed - b.vel.x;
    const dvz = wishZ * speed - b.vel.z;
    const dl = Math.hypot(dvx, dvz);
    const maxDv = (b.onGround ? PLAYER.groundAccel : PLAYER.airAccel) * dt;
    const k = dl > maxDv ? maxDv / dl : 1;
    b.vel.x += dvx * k;
    b.vel.z += dvz * k;
  }

  if (input.jump && !m.jumpWasDown) m.jumpBuffer = PLAYER.jumpBufferTicks;
  m.jumpWasDown = input.jump;
  if (b.onGround) m.coyote = PLAYER.coyoteTicks;
  else if (m.coyote > 0) m.coyote--;
  if (m.jumpBuffer > 0) {
    if (m.coyote > 0) {
      b.vel.y = PLAYER.jumpSpeed;
      b.onGround = false;
      m.coyote = 0;
      m.jumpBuffer = 0;
      ev.jumped = true;
    } else {
      m.jumpBuffer--;
    }
  }

  b.vel.y = Math.max(b.vel.y - PLAYER.gravity * dt, -PLAYER.terminalSpeed);
  const beforeX = p.x;
  const beforeZ = p.z;
  const res = moveBody(world, b, playerShape(m), dt, { stepHeight: PLAYER.stepHeight, snapDown: PLAYER.snapDown });
  ev.landed = res.landed;
  ev.landSpeed = res.landSpeed;

  const targetEye = m.crouched ? PLAYER.crouchEye : PLAYER.standEye;
  m.eye += (targetEye - m.eye) * (1 - Math.exp(-16 * dt));

  if (b.onGround) {
    m.stride += Math.hypot(p.x - beforeX, p.z - beforeZ);
    if (m.stride > (m.sprinting ? 2.5 : 1.9)) {
      m.stride = 0;
      ev.footstep = true;
    }
  }
  return ev;
}
