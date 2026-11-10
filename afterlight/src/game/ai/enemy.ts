import { TICK_DT } from '../../shared/constants';
import { clearLine, type CollisionWorld } from '../../shared/collision';
import {
  approach,
  clamp,
  copy,
  dirToYawPitch,
  distance,
  distanceXZ,
  normalize,
  sub,
  wrapAngle,
  yawPitchToDir,
  type Rng,
  type Vec3,
} from '../../shared/math';
import { moveBody, type CharBody, type CharShape } from '../../shared/movement';
import type { AiState, SimEvent } from '../events';
import type { NavGrid } from '../nav';

export type EnemyKind = 'security';
export type AttackPhase = 'idle' | 'windup' | 'burst' | 'cooldown';

export interface EnemyDef {
  kind: EnemyKind;
  name: string;
  maxHp: number;
  radius: number;
  height: number;
  eyeHeight: number;
  /** Hits above this fraction of the height strike the sensor head and are critical. */
  critFrom: number;
  walkSpeed: number;
  alertSpeed: number;
  combatSpeed: number;
  turnRate: number;
  visionRange: number;
  visionHalfFov: number;
  proximityRange: number;
  preferredMin: number;
  preferredMax: number;
  attackRange: number;
  /** Telegraph before a burst: the unit stands still and its emitter charges. */
  windupTicks: number;
  burstCount: number;
  burstIntervalTicks: number;
  cooldownTicks: [number, number];
  boltSpeed: number;
  boltDamage: number;
  aimError: number;
}

export const SECURITY_UNIT: EnemyDef = {
  kind: 'security',
  name: 'Security Unit',
  maxHp: 90,
  radius: 0.38,
  height: 1.9,
  eyeHeight: 1.65,
  critFrom: 0.8,
  walkSpeed: 1.7,
  alertSpeed: 2.6,
  combatSpeed: 3.6,
  turnRate: 4.5,
  visionRange: 30,
  visionHalfFov: 1,
  proximityRange: 2.5,
  preferredMin: 6,
  preferredMax: 15,
  attackRange: 26,
  windupTicks: 26,
  burstCount: 3,
  burstIntervalTicks: 9,
  cooldownTicks: [55, 95],
  boltSpeed: 30,
  boltDamage: 9,
  aimError: 0.03,
};

export const ENEMY_DEFS: Record<EnemyKind, EnemyDef> = { security: SECURITY_UNIT };

export interface Enemy {
  id: number;
  def: EnemyDef;
  body: CharBody;
  prevPos: Vec3;
  yaw: number;
  prevYaw: number;
  hp: number;
  state: AiState;
  stateTicks: number;
  /** 0..1 suspicion; 1 means the target is confirmed. */
  awareness: number;
  hasLos: boolean;
  lastKnown: Vec3 | null;
  lastSeenTick: number;
  home: Vec3;
  homeYaw: number;
  patrol: Vec3[];
  patrolIndex: number;
  waitTicks: number;
  lookTicks: number;
  lookBase: number;
  path: Vec3[] | null;
  pathIndex: number;
  goal: Vec3 | null;
  nextPathTick: number;
  stuckTicks: number;
  stuckStrikes: number;
  progressMark: Vec3;
  phase: AttackPhase;
  phaseTicks: number;
  shotsLeft: number;
  spot: Vec3 | null;
  atSpot: boolean;
  repositionAt: number;
  staggerTicks: number;
  deadTicks: number;
  speed: number;
}

export interface AiTarget {
  feet: Vec3;
  eye: Vec3;
  chest: Vec3;
  alive: boolean;
  crouched: boolean;
}

export interface AiContext {
  tick: number;
  world: CollisionWorld;
  nav: NavGrid;
  rng: Rng;
  target: AiTarget;
  enemies: Enemy[];
  emit(ev: SimEvent): void;
  spawnBolt(owner: Enemy, origin: Vec3, dir: Vec3): void;
  onNavRecover(): void;
}

const GRAVITY = 20;
const INVESTIGATE_AT = 0.35;
const ALERT_RADIUS = 16;
const MOVING = 0;
const ARRIVED = 1;
const BLOCKED = 2;

/** What the current behaviour wants this tick; applied once after the state handler runs. */
const drive = { x: 0, z: 0, speed: 0, face: NaN };

export function createEnemy(id: number, def: EnemyDef, pos: Vec3, patrol: Vec3[], yaw = 0): Enemy {
  return {
    id,
    def,
    body: { pos: copy(pos), vel: { x: 0, y: 0, z: 0 }, onGround: false },
    prevPos: copy(pos),
    yaw,
    prevYaw: yaw,
    hp: def.maxHp,
    state: 'patrol',
    stateTicks: 0,
    awareness: 0,
    hasLos: false,
    lastKnown: null,
    lastSeenTick: -10000,
    home: copy(pos),
    homeYaw: yaw,
    patrol: patrol.map(copy),
    patrolIndex: 0,
    waitTicks: 0,
    lookTicks: 0,
    lookBase: yaw,
    path: null,
    pathIndex: 0,
    goal: null,
    nextPathTick: 0,
    stuckTicks: 0,
    stuckStrikes: 0,
    progressMark: copy(pos),
    phase: 'idle',
    phaseTicks: 0,
    shotsLeft: 0,
    spot: null,
    atSpot: false,
    repositionAt: 0,
    staggerTicks: 0,
    deadTicks: 0,
    speed: 0,
  };
}

export const enemyEye = (e: Enemy): Vec3 => ({ x: e.body.pos.x, y: e.body.pos.y + e.def.eyeHeight, z: e.body.pos.z });
const shapeOf = (e: Enemy): CharShape => ({ radius: e.def.radius, height: e.def.height });

function setState(e: Enemy, ctx: AiContext, state: AiState): void {
  e.state = state;
  e.stateTicks = 0;
  e.path = null;
  e.goal = null;
  e.lookTicks = 0;
  e.waitTicks = 0;
  ctx.emit({ type: 'enemyState', id: e.id, state });
}

function enterCombat(e: Enemy, ctx: AiContext): void {
  if (e.state === 'combat' || e.state === 'dead') return;
  setState(e, ctx, 'combat');
  e.awareness = 1;
  // Reaction time before the first burst.
  e.phase = 'cooldown';
  e.phaseTicks = 16 + Math.floor(ctx.rng() * 16);
  e.spot = null;
  e.lastSeenTick = ctx.tick;
  if (!e.lastKnown) e.lastKnown = copy(ctx.target.feet);
  for (const o of ctx.enemies) {
    if (o === e || o.state === 'dead' || o.state === 'combat') continue;
    if (distance(o.body.pos, e.body.pos) > ALERT_RADIUS) continue;
    // Allies are told where to look; they still have to find the target themselves.
    o.lastKnown = copy(e.lastKnown);
    o.awareness = Math.max(o.awareness, 0.6);
  }
}

function perceive(e: Enemy, ctx: AiContext): void {
  const t = ctx.target;
  const eye = enemyEye(e);
  const dist = distance(eye, t.chest);
  // Line-of-sight rays are staggered across units so they do not all cast on the same tick.
  if ((ctx.tick + e.id * 3) % 4 === 0) {
    let los = false;
    if (t.alive && dist <= e.def.visionRange) {
      const toYaw = Math.atan2(-(t.chest.x - eye.x), -(t.chest.z - eye.z));
      const inView =
        e.state === 'combat' ||
        dist <= e.def.proximityRange ||
        Math.abs(wrapAngle(toYaw - e.yaw)) <= e.def.visionHalfFov;
      if (inView) los = clearLine(ctx.world, eye, t.eye) || clearLine(ctx.world, eye, t.chest);
    }
    e.hasLos = los;
  }
  if (e.hasLos) {
    const near = 1 - clamp(dist / e.def.visionRange, 0, 1);
    const rate = (0.7 + 2.6 * near) * (t.crouched ? 0.55 : 1);
    e.awareness = e.state === 'combat' ? 1 : Math.min(1, e.awareness + rate * TICK_DT);
    e.lastKnown = copy(t.feet);
    e.lastSeenTick = ctx.tick;
  } else if (e.state !== 'combat') {
    e.awareness = Math.max(0, e.awareness - 0.2 * TICK_DT);
  }
}

function navigate(e: Enemy, ctx: AiContext, goal: Vec3, speed: number): number {
  const pos = e.body.pos;
  const stale = !e.path || !e.goal || distanceXZ(e.goal, goal) > 1.2 || Math.abs(e.goal.y - goal.y) > 1;
  if (stale && ctx.tick >= e.nextPathTick) {
    e.nextPathTick = ctx.tick + 24 + (e.id % 5) * 3;
    e.path = ctx.nav.findPath(pos, goal);
    e.pathIndex = 0;
    e.goal = copy(goal);
    if (!e.path) return BLOCKED;
    // Skip the snap-to-grid node when the next one is directly walkable, so units do not backtrack.
    if (e.path.length > 1 && ctx.nav.walkable(pos, e.path[1])) e.pathIndex = 1;
  }
  const path = e.path;
  if (!path) return MOVING;
  while (e.pathIndex < path.length) {
    const wp = path[e.pathIndex];
    if (distanceXZ(pos, wp) < 0.3 && Math.abs(pos.y - wp.y) < 1.2) e.pathIndex++;
    else break;
  }
  if (e.pathIndex >= path.length) {
    e.path = null;
    e.goal = null;
    return ARRIVED;
  }
  const wp = path[e.pathIndex];
  const dx = wp.x - pos.x;
  const dz = wp.z - pos.z;
  const d = Math.hypot(dx, dz) || 1;
  drive.x = dx / d;
  drive.z = dz / d;
  drive.speed = speed;
  return MOVING;
}

function patrol(e: Enemy, ctx: AiContext): void {
  if (e.awareness >= 1) return enterCombat(e, ctx);
  if (e.awareness >= INVESTIGATE_AT && e.lastKnown) return setState(e, ctx, 'investigate');
  if (e.waitTicks > 0) {
    e.waitTicks--;
    drive.face = e.lookBase + Math.sin((ctx.tick + e.id * 40) * 0.02) * 0.9;
    if (e.waitTicks === 0) {
      if (e.patrol.length > 1) e.patrolIndex = (e.patrolIndex + 1) % e.patrol.length;
      else e.waitTicks = 120;
    }
    return;
  }
  const post = e.patrol[e.patrolIndex] ?? e.home;
  if (navigate(e, ctx, post, e.def.walkSpeed) !== MOVING) {
    e.waitTicks = 70 + Math.floor(ctx.rng() * 110);
    e.lookBase = e.patrol.length > 1 ? e.yaw : e.homeYaw;
  }
}

/** Shared by investigate and search: go to the last known position, sweep, then give up. */
function seek(e: Enemy, ctx: AiContext, speed: number, sweepTicks: number): void {
  if (e.awareness >= 1) return enterCombat(e, ctx);
  if (!e.lastKnown) return setState(e, ctx, 'return');
  if (e.lookTicks === 0) {
    if (navigate(e, ctx, e.lastKnown, speed) !== MOVING || e.stateTicks > 60 * 15) {
      e.lookTicks = 1;
      e.lookBase = e.yaw;
    }
    return;
  }
  e.lookTicks++;
  drive.face = e.lookBase + Math.sin(e.lookTicks * 0.045) * 1.4;
  if (e.lookTicks > sweepTicks) {
    e.awareness = 0;
    setState(e, ctx, 'return');
  }
}

function goHome(e: Enemy, ctx: AiContext): void {
  if (e.awareness >= 1) return enterCombat(e, ctx);
  if (e.awareness >= INVESTIGATE_AT && e.lastKnown) return setState(e, ctx, 'investigate');
  const post = e.patrol[e.patrolIndex] ?? e.home;
  if (navigate(e, ctx, post, e.def.walkSpeed) !== MOVING) setState(e, ctx, 'patrol');
}

function pickSpot(e: Enemy, ctx: AiContext): void {
  const t = ctx.target;
  const def = e.def;
  const pos = e.body.pos;
  e.repositionAt = ctx.tick + 140 + Math.floor(ctx.rng() * 140);
  e.atSpot = false;
  const cands = ctx.nav.sampleRing(t.feet, t.feet.y, def.preferredMin, def.preferredMax, 14, ctx.rng);
  // Also consider the unit's own floor so elevated units keep their height advantage.
  if (Math.abs(pos.y - t.feet.y) > 1) {
    for (const n of ctx.nav.sampleRing(t.feet, pos.y, def.preferredMin, def.preferredMax, 10, ctx.rng)) cands.push(n);
  }
  const mid = (def.preferredMin + def.preferredMax) / 2;
  let best: Vec3 | null = null;
  let bestScore = -Infinity;
  for (const n of cands) {
    if (!clearLine(ctx.world, { x: n.x, y: n.y + def.eyeHeight, z: n.z }, t.chest)) continue;
    let score =
      ctx.rng() * 2 -
      distanceXZ(pos, n) * 0.5 -
      Math.abs(n.y - pos.y) * 1.5 -
      Math.abs(distanceXZ(n, t.feet) - mid) * 0.25;
    for (const o of ctx.enemies) {
      if (o !== e && o.state === 'combat' && o.spot && distanceXZ(o.spot, n) < 2.5) score -= 6;
    }
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  e.spot = best ? { x: best.x, y: best.y, z: best.z } : null;
}

function fireBolt(e: Enemy, ctx: AiContext): void {
  const eye = enemyEye(e);
  let muzzle: Vec3 = { x: eye.x - Math.sin(e.yaw) * 0.45, y: eye.y - 0.28, z: eye.z - Math.cos(e.yaw) * 0.45 };
  // Never start a bolt on the far side of something the unit is pressed against.
  if (!clearLine(ctx.world, eye, muzzle)) muzzle = eye;
  const aim = dirToYawPitch(normalize(sub(ctx.target.chest, muzzle)));
  const err = e.def.aimError;
  const dir = yawPitchToDir(aim.yaw + (ctx.rng() - 0.5) * 2 * err, aim.pitch + (ctx.rng() - 0.5) * 2 * err);
  ctx.spawnBolt(e, muzzle, dir);
  ctx.emit({ type: 'enemyFire', id: e.id, origin: muzzle });
}

function combat(e: Enemy, ctx: AiContext): void {
  const t = ctx.target;
  const def = e.def;
  if (!t.alive) {
    e.awareness = 0;
    e.phase = 'idle';
    return setState(e, ctx, 'return');
  }
  const pos = e.body.pos;
  const sinceSeen = ctx.tick - e.lastSeenTick;
  const aimYaw = Math.atan2(-(t.feet.x - pos.x), -(t.feet.z - pos.z));
  const dist = distance(pos, t.feet);
  let canMove = true;

  switch (e.phase) {
    case 'idle':
      if (
        e.hasLos &&
        e.staggerTicks === 0 &&
        dist <= def.attackRange &&
        Math.abs(wrapAngle(aimYaw - e.yaw)) < 0.3
      ) {
        e.phase = 'windup';
        e.phaseTicks = def.windupTicks;
        ctx.emit({ type: 'enemyWindup', id: e.id });
      }
      break;
    case 'windup':
      canMove = false;
      if (!e.hasLos && sinceSeen > 24) {
        e.phase = 'cooldown';
        e.phaseTicks = 30;
      } else if (--e.phaseTicks <= 0) {
        e.phase = 'burst';
        e.shotsLeft = def.burstCount;
        e.phaseTicks = 0;
      }
      break;
    case 'burst':
      canMove = false;
      if (e.phaseTicks > 0) {
        e.phaseTicks--;
      } else {
        fireBolt(e, ctx);
        e.shotsLeft--;
        e.phaseTicks = def.burstIntervalTicks;
        if (e.shotsLeft <= 0) {
          e.phase = 'cooldown';
          e.phaseTicks = def.cooldownTicks[0] + Math.floor(ctx.rng() * (def.cooldownTicks[1] - def.cooldownTicks[0]));
          // Relocate after every burst so the fight keeps moving.
          e.repositionAt = Math.min(e.repositionAt, ctx.tick + 12);
        }
      }
      break;
    case 'cooldown':
      if (--e.phaseTicks <= 0) e.phase = 'idle';
      break;
  }

  if (e.hasLos || sinceSeen < 30) drive.face = aimYaw;

  if (sinceSeen > 50 && e.lastKnown) {
    // Lost sight: push to where the target was last seen, then search from there.
    if (!canMove) return;
    if (navigate(e, ctx, e.lastKnown, def.combatSpeed) !== MOVING || sinceSeen > 60 * 7) {
      e.phase = 'idle';
      setState(e, ctx, 'search');
    }
    return;
  }

  if (!e.spot || ctx.tick >= e.repositionAt) pickSpot(e, ctx);
  if (canMove && e.spot && !e.atSpot && navigate(e, ctx, e.spot, def.combatSpeed) !== MOVING) e.atSpot = true;
}

function applyDrive(e: Enemy, ctx: AiContext): void {
  const b = e.body;
  const moving = drive.speed > 0 && e.staggerTicks === 0;
  let tx = moving ? drive.x * drive.speed : 0;
  let tz = moving ? drive.z * drive.speed : 0;
  for (const o of ctx.enemies) {
    if (o === e || o.state === 'dead') continue;
    const dx = b.pos.x - o.body.pos.x;
    const dz = b.pos.z - o.body.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.95 && d > 1e-3 && Math.abs(b.pos.y - o.body.pos.y) < 1.5) {
      const push = (0.95 - d) * 3;
      tx += (dx / d) * push;
      tz += (dz / d) * push;
    }
  }
  const maxDv = 28 * TICK_DT;
  b.vel.x = approach(b.vel.x, tx, maxDv);
  b.vel.z = approach(b.vel.z, tz, maxDv);
  b.vel.y = Math.max(b.vel.y - GRAVITY * TICK_DT, -40);
  moveBody(ctx.world, b, shapeOf(e), TICK_DT, { stepHeight: 0.5, snapDown: 0.35 });
  e.speed = Math.hypot(b.vel.x, b.vel.z);

  let face = drive.face;
  if (Number.isNaN(face) && moving) face = Math.atan2(-drive.x, -drive.z);
  if (!Number.isNaN(face)) {
    const maxTurn = e.def.turnRate * TICK_DT;
    e.yaw = wrapAngle(e.yaw + clamp(wrapAngle(face - e.yaw), -maxTurn, maxTurn));
  }

  if (!moving) {
    e.stuckTicks = 0;
    return;
  }
  if (++e.stuckTicks < 30) return;
  e.stuckTicks = 0;
  const progressed = distanceXZ(b.pos, e.progressMark) >= 0.2;
  e.progressMark = copy(b.pos);
  if (progressed) {
    e.stuckStrikes = 0;
    return;
  }
  // No progress for half a second: replan, and after two seconds snap back onto the grid.
  e.stuckStrikes++;
  e.path = null;
  e.nextPathTick = ctx.tick;
  if (e.stuckStrikes >= 4) {
    e.stuckStrikes = 0;
    const node = ctx.nav.nearest(b.pos, 3.5);
    if (node) {
      b.pos.x = node.x;
      b.pos.y = node.y;
      b.pos.z = node.z;
      b.vel.x = b.vel.y = b.vel.z = 0;
      ctx.onNavRecover();
    }
  }
}

export function stepEnemy(e: Enemy, ctx: AiContext): void {
  if (e.state === 'dead') {
    e.deadTicks++;
    e.body.vel.x = 0;
    e.body.vel.z = 0;
    e.body.vel.y = Math.max(e.body.vel.y - GRAVITY * TICK_DT, -40);
    moveBody(ctx.world, e.body, shapeOf(e), TICK_DT, { stepHeight: 0, snapDown: 0 });
    return;
  }
  e.stateTicks++;
  if (e.staggerTicks > 0) e.staggerTicks--;
  perceive(e, ctx);
  drive.speed = 0;
  drive.face = NaN;
  switch (e.state) {
    case 'patrol':
      patrol(e, ctx);
      break;
    case 'investigate':
      seek(e, ctx, e.def.alertSpeed, 200);
      break;
    case 'search':
      seek(e, ctx, e.def.combatSpeed, 300);
      break;
    case 'return':
      goHome(e, ctx);
      break;
    case 'combat':
      combat(e, ctx);
      break;
  }
  applyDrive(e, ctx);
}

/** Applies damage from a known direction. Returns true when this hit destroyed the unit. */
export function damageEnemy(e: Enemy, amount: number, crit: boolean, from: Vec3, ctx: AiContext): boolean {
  if (e.state === 'dead') return false;
  e.hp -= amount;
  if (e.hp <= 0) {
    e.hp = 0;
    setState(e, ctx, 'dead');
    ctx.emit({ type: 'enemyDead', id: e.id });
    return true;
  }
  ctx.emit({ type: 'enemyHurt', id: e.id, crit });
  e.staggerTicks = crit ? 14 : 8;
  // A hit during the telegraph delays the burst; a critical hit cancels it.
  if (e.phase === 'windup') {
    if (crit) {
      e.phase = 'cooldown';
      e.phaseTicks = 24;
    } else {
      e.phaseTicks += 5;
    }
  }
  if (e.state !== 'combat') {
    e.lastKnown = copy(from);
    enterCombat(e, ctx);
  }
  return false;
}

/** Gunfire and other loud events. Walls halve how far the sound carries. */
export function hearNoise(e: Enemy, pos: Vec3, radius: number, ctx: AiContext): void {
  if (e.state === 'dead' || e.state === 'combat') return;
  const source = { x: pos.x, y: pos.y + 1.2, z: pos.z };
  const reach = clearLine(ctx.world, source, enemyEye(e)) ? radius : radius * 0.5;
  if (distance(e.body.pos, pos) > reach) return;
  e.lastKnown = copy(pos);
  e.awareness = Math.max(e.awareness, 0.5);
  if (e.state !== 'investigate') setState(e, ctx, 'investigate');
  else {
    e.lookTicks = 0;
    e.stateTicks = 0;
    e.path = null;
  }
}
