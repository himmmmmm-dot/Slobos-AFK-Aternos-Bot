import { TICK_DT, TICK_RATE } from '../shared/constants';
import { rayAabb, raycast, type CollisionWorld } from '../shared/collision';
import {
  clamp,
  copy,
  cross,
  dot,
  length,
  mulberry32,
  normalize,
  scale,
  sub,
  vec3,
  yawPitchToDir,
  type Rng,
  type Vec3,
} from '../shared/math';
import { createPlayerMove, PLAYER, playerShape, stepPlayerMove, type PlayerMove } from '../shared/movement';
import {
  createWeaponState,
  currentSpread,
  damageAtRange,
  SERVICE_PISTOL,
  spreadDirection,
  stepWeapon,
  type WeaponDef,
  type WeaponState,
} from '../shared/weapons';
import { createEnemy, damageEnemy, ENEMY_DEFS, hearNoise, stepEnemy, type AiContext, type Enemy } from './ai/enemy';
import type { RadioLine, ShotHit, SimEvent } from './events';
import type { LevelDef, ObjectiveDef } from './level';
import { NavGrid } from './nav';

export interface TickInput {
  /** Strafe, right positive. */
  moveX: number;
  /** Forward positive. */
  moveZ: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  fire: boolean;
  reload: boolean;
  interact: boolean;
}

export const IDLE_INPUT: Readonly<TickInput> = {
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  sprint: false,
  crouch: false,
  fire: false,
  reload: false,
  interact: false,
};

export interface PlayerState {
  move: PlayerMove;
  prevPos: Vec3;
  prevEye: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  lastDamageTick: number;
  weaponDef: WeaponDef;
  weapon: WeaponState;
  yaw: number;
  pitch: number;
  /** View kick from firing. Added to the aim, then decays back so the sights return on their own. */
  recoilPitch: number;
  recoilYaw: number;
  interactTarget: string | null;
  interactProgress: number;
}

export interface Bolt {
  id: number;
  pos: Vec3;
  prev: Vec3;
  dir: Vec3;
  origin: Vec3;
  speed: number;
  damage: number;
  ttl: number;
}

export interface MissionState {
  status: 'active' | 'complete' | 'failed';
  index: number;
  /** Progress of the current objective, e.g. hostiles destroyed out of the total. */
  done: number;
  total: number;
  endedTick: number;
}

export interface SimStats {
  shots: number;
  hits: number;
  crits: number;
  kills: number;
  damageTaken: number;
  navRecoveries: number;
}

const MAX_PITCH = 1.54;
const RECOIL_DECAY = Math.exp(-9 * TICK_DT);
const REGEN_DELAY = 5 * TICK_RATE;
/** Health only regenerates to this floor; the rest comes from pickups. */
const REGEN_CAP = 50;
const REGEN_PER_TICK = 10 / TICK_RATE;
const PICKUP_RADIUS = 1.1;

/**
 * The whole single-player game state, advanced in fixed ticks. It has no DOM, renderer or
 * audio dependency, so it runs identically in the browser, in tests and on a server.
 */
export class Simulation {
  readonly world: CollisionWorld;
  readonly nav: NavGrid;
  readonly rng: Rng;
  readonly player: PlayerState;
  readonly enemies: Enemy[] = [];
  readonly bolts: Bolt[] = [];
  readonly mission: MissionState;
  readonly stats: SimStats = { shots: 0, hits: 0, crits: 0, kills: 0, damageTaken: 0, navRecoveries: 0 };
  readonly pickupsTaken = new Set<string>();
  tick = 0;
  /** Presentation events since the last drain. */
  events: SimEvent[] = [];

  private readonly ai: AiContext;
  private readonly hintsShown = new Set<string>();
  private readonly boxMin = vec3();
  private readonly boxMax = vec3();
  private nextBoltId = 1;

  constructor(
    readonly level: LevelDef,
    nav?: NavGrid,
    seed = 0x5eed,
  ) {
    this.world = { solids: level.solids };
    this.nav = nav ?? Simulation.buildNav(level);
    this.rng = mulberry32(seed);
    const move = createPlayerMove(level.spawn.pos);
    this.player = {
      move,
      prevPos: copy(level.spawn.pos),
      prevEye: move.eye,
      hp: 100,
      maxHp: 100,
      alive: true,
      lastDamageTick: -REGEN_DELAY,
      weaponDef: SERVICE_PISTOL,
      weapon: createWeaponState(SERVICE_PISTOL),
      yaw: level.spawn.yaw,
      pitch: 0,
      recoilPitch: 0,
      recoilYaw: 0,
      interactTarget: null,
      interactProgress: 0,
    };
    level.enemies.forEach((def, i) => {
      const first = def.patrol.find((p) => Math.hypot(p.x - def.pos.x, p.z - def.pos.z) > 0.5);
      const yaw = def.yaw ?? (first ? Math.atan2(-(first.x - def.pos.x), -(first.z - def.pos.z)) : 0);
      this.enemies.push(createEnemy(i, ENEMY_DEFS[def.kind], def.pos, def.patrol, yaw));
    });
    this.mission = { status: 'active', index: 0, done: 0, total: this.enemies.length, endedTick: 0 };
    const feet = move.body.pos;
    this.ai = {
      tick: 0,
      world: this.world,
      nav: this.nav,
      rng: this.rng,
      target: { feet, eye: copy(feet), chest: copy(feet), alive: true, crouched: false },
      enemies: this.enemies,
      emit: (ev) => this.events.push(ev),
      spawnBolt: (owner, origin, dir) => this.spawnBolt(origin, dir, owner.def.boltSpeed, owner.def.boltDamage),
      onNavRecover: () => {
        this.stats.navRecoveries++;
      },
    };
    this.updateTarget();
    this.radio('start');
  }

  static buildNav(level: LevelDef): NavGrid {
    const seeds: Vec3[] = [level.spawn.pos];
    for (const e of level.enemies) seeds.push(e.pos, ...e.patrol);
    return NavGrid.build({ solids: level.solids }, level.bounds, seeds);
  }

  playerEye(): Vec3 {
    const p = this.player.move.body.pos;
    return { x: p.x, y: p.y + this.player.move.eye, z: p.z };
  }

  currentObjective(): ObjectiveDef | null {
    return this.level.objectives[this.mission.index] ?? null;
  }

  /** World position the current objective points at, when it has one. */
  objectiveMarker(): Vec3 | null {
    const obj = this.currentObjective();
    if (!obj) return null;
    if (obj.kind === 'reach') {
      const t = this.level.triggers.find((tr) => tr.id === obj.trigger);
      // Chest height, so the HUD marker floats in the doorway instead of lying on the floor.
      return t ? { x: (t.min.x + t.max.x) / 2, y: t.min.y + 1.2, z: (t.min.z + t.max.z) / 2 } : null;
    }
    if (obj.kind === 'interact') return this.level.interactables.find((i) => i.id === obj.target)?.pos ?? null;
    return null;
  }

  step(input: TickInput): void {
    this.tick++;
    const p = this.player;
    const feet = p.move.body.pos;
    p.prevPos.x = feet.x;
    p.prevPos.y = feet.y;
    p.prevPos.z = feet.z;
    p.prevEye = p.move.eye;
    for (const e of this.enemies) {
      e.prevPos.x = e.body.pos.x;
      e.prevPos.y = e.body.pos.y;
      e.prevPos.z = e.body.pos.z;
      e.prevYaw = e.yaw;
    }
    if (this.mission.status === 'active' && p.alive) this.stepPlayer(input);
    this.updateTarget();
    for (const e of this.enemies) stepEnemy(e, this.ai);
    this.stepBolts();
    if (this.mission.status === 'active') this.updateMission();
  }

  /** Damages the player from an optional source position. Safe to call at any time. */
  hurtPlayer(amount: number, from: Vec3 | null): void {
    const p = this.player;
    if (!p.alive || this.mission.status !== 'active') return;
    p.hp -= amount;
    p.lastDamageTick = this.tick;
    this.stats.damageTaken += amount;
    this.events.push({ type: 'playerHurt', amount, from });
    if (p.hp <= 0) {
      p.hp = 0;
      p.alive = false;
      this.mission.status = 'failed';
      this.mission.endedTick = this.tick;
      this.events.push({ type: 'playerDead' });
    }
  }

  spawnBolt(origin: Vec3, dir: Vec3, speed: number, damage: number): void {
    this.bolts.push({
      id: this.nextBoltId++,
      pos: copy(origin),
      prev: copy(origin),
      dir: copy(dir),
      origin: copy(origin),
      speed,
      damage,
      ttl: 4 * TICK_RATE,
    });
  }

  /** Lets tests and tools damage a unit through the same path the player's weapon uses. */
  damageEnemyById(id: number, amount: number, crit = false): boolean {
    const e = this.enemies[id];
    const killed = damageEnemy(e, amount, crit, this.player.move.body.pos, this.ai);
    if (killed) this.stats.kills++;
    return killed;
  }

  private updateTarget(): void {
    const p = this.player;
    const feet = p.move.body.pos;
    const t = this.ai.target;
    t.eye.x = t.chest.x = feet.x;
    t.eye.z = t.chest.z = feet.z;
    t.eye.y = feet.y + p.move.eye;
    t.chest.y = feet.y + p.move.eye * 0.72;
    t.crouched = p.move.crouched;
    // Units stand down once the mission is over.
    t.alive = p.alive && this.mission.status === 'active';
    this.ai.tick = this.tick;
  }

  private stepPlayer(input: TickInput): void {
    const p = this.player;
    p.yaw = input.yaw;
    p.pitch = clamp(input.pitch, -MAX_PITCH, MAX_PITCH);
    const mv = stepPlayerMove(this.world, p.move, input);
    if (mv.jumped) this.events.push({ type: 'jump' });
    if (mv.landed && mv.landSpeed > 3) this.events.push({ type: 'land', speed: mv.landSpeed });
    if (mv.footstep) this.events.push({ type: 'footstep', sprint: p.move.sprinting });
    if (p.move.body.pos.y < this.level.killY) {
      this.hurtPlayer(p.maxHp * 10, null);
      return;
    }

    p.recoilPitch *= RECOIL_DECAY;
    p.recoilYaw *= RECOIL_DECAY;
    for (const ev of stepWeapon(p.weaponDef, p.weapon, { trigger: input.fire, reload: input.reload })) {
      if (ev.type === 'fire') this.fire(ev.bloom);
      else this.events.push(ev);
    }

    this.updateInteract(input);
    this.updatePickups();
    this.updateHints();
    if (p.hp < REGEN_CAP && this.tick - p.lastDamageTick > REGEN_DELAY) {
      p.hp = Math.min(REGEN_CAP, p.hp + REGEN_PER_TICK);
    }
  }

  private fire(bloom: number): void {
    const p = this.player;
    const def = p.weaponDef;
    const body = p.move.body;
    const fwd = yawPitchToDir(p.yaw + p.recoilYaw, clamp(p.pitch + p.recoilPitch, -MAX_PITCH, MAX_PITCH));
    const right = normalize(cross(fwd, vec3(0, 1, 0)));
    const up = cross(right, fwd);
    const eye = this.playerEye();
    const spread = currentSpread(def, bloom, {
      moving: Math.hypot(body.vel.x, body.vel.z) / PLAYER.walkSpeed,
      airborne: !body.onGround,
      crouched: p.move.crouched,
    });
    const hits: ShotHit[] = [];
    for (let i = 0; i < def.pellets; i++) {
      const dir = spreadDirection(fwd, right, up, spread, this.rng);
      const wall = raycast(this.world, eye, dir, def.maxRange);
      let reach = wall ? wall.t : def.maxRange;
      let target: Enemy | null = null;
      for (const e of this.enemies) {
        if (e.state === 'dead') continue;
        const r = e.def.radius + 0.04;
        const ep = e.body.pos;
        this.boxMin.x = ep.x - r;
        this.boxMin.y = ep.y;
        this.boxMin.z = ep.z - r;
        this.boxMax.x = ep.x + r;
        this.boxMax.y = ep.y + e.def.height;
        this.boxMax.z = ep.z + r;
        const t = rayAabb(eye, dir, this.boxMin, this.boxMax, reach);
        if (t >= 0 && t < reach) {
          reach = t;
          target = e;
        }
      }
      const point = { x: eye.x + dir.x * reach, y: eye.y + dir.y * reach, z: eye.z + dir.z * reach };
      if (target) {
        const crit = point.y >= target.body.pos.y + target.def.height * target.def.critFrom;
        const dmg = damageAtRange(def, reach) * (crit ? def.critMultiplier : 1);
        const killed = damageEnemy(target, dmg, crit, body.pos, this.ai);
        this.stats.hits++;
        if (crit) this.stats.crits++;
        if (killed) this.stats.kills++;
        hits.push({ point, normal: scale(dir, -1), surface: true, enemyId: target.id, crit, killed, distance: reach });
      } else {
        hits.push({
          point,
          normal: wall ? wall.normal : scale(dir, -1),
          surface: wall !== null,
          enemyId: null,
          crit: false,
          killed: false,
          distance: reach,
        });
      }
    }
    p.recoilPitch += def.recoilPitch;
    p.recoilYaw += (this.rng() - 0.5) * 2 * def.recoilYaw;
    this.stats.shots++;
    this.events.push({ type: 'shot', origin: eye, hits });
    for (const e of this.enemies) hearNoise(e, body.pos, def.noiseRadius, this.ai);
  }

  private stepBolts(): void {
    const p = this.player;
    const feet = p.move.body.pos;
    const shape = playerShape(p.move);
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.prev.x = b.pos.x;
      b.prev.y = b.pos.y;
      b.prev.z = b.pos.z;
      const stepLen = b.speed * TICK_DT;
      // Bolts are swept against the world every tick, so they can never pass through geometry.
      const wall = raycast(this.world, b.pos, b.dir, stepLen);
      let reach = wall ? wall.t : stepLen;
      let hitPlayer = false;
      if (p.alive) {
        this.boxMin.x = feet.x - shape.radius;
        this.boxMin.y = feet.y;
        this.boxMin.z = feet.z - shape.radius;
        this.boxMax.x = feet.x + shape.radius;
        this.boxMax.y = feet.y + shape.height;
        this.boxMax.z = feet.z + shape.radius;
        const t = rayAabb(b.pos, b.dir, this.boxMin, this.boxMax, reach);
        if (t >= 0) {
          reach = t;
          hitPlayer = true;
        }
      }
      if (hitPlayer || wall) {
        const point = { x: b.pos.x + b.dir.x * reach, y: b.pos.y + b.dir.y * reach, z: b.pos.z + b.dir.z * reach };
        const normal = hitPlayer || !wall ? scale(b.dir, -1) : wall.normal;
        this.events.push({ type: 'boltImpact', point, normal, hitPlayer });
        if (hitPlayer) this.hurtPlayer(b.damage, b.origin);
        this.removeBolt(i);
        continue;
      }
      b.pos.x += b.dir.x * stepLen;
      b.pos.y += b.dir.y * stepLen;
      b.pos.z += b.dir.z * stepLen;
      if (--b.ttl <= 0) this.removeBolt(i);
    }
  }

  private removeBolt(i: number): void {
    const last = this.bolts.pop()!;
    if (i < this.bolts.length) this.bolts[i] = last;
  }

  private updateInteract(input: TickInput): void {
    const p = this.player;
    const obj = this.currentObjective();
    p.interactTarget = null;
    if (!obj || obj.kind !== 'interact') {
      p.interactProgress = 0;
      return;
    }
    const it = this.level.interactables.find((i) => i.id === obj.target);
    if (!it) return;
    const to = sub(it.pos, this.playerEye());
    const d = length(to);
    const facing = d < 1e-3 || dot(yawPitchToDir(p.yaw, p.pitch), to) / d > 0.45;
    if (d > it.radius || !facing) {
      p.interactProgress = 0;
      return;
    }
    p.interactTarget = it.id;
    if (!input.interact) {
      p.interactProgress = 0;
      return;
    }
    if (++p.interactProgress >= it.holdTicks) {
      p.interactProgress = 0;
      p.interactTarget = null;
      this.events.push({ type: 'interactDone', id: it.id });
      this.completeObjective();
    }
  }

  private updatePickups(): void {
    const p = this.player;
    if (p.hp >= p.maxHp) return;
    const feet = p.move.body.pos;
    for (const pk of this.level.pickups) {
      if (this.pickupsTaken.has(pk.id)) continue;
      if (Math.hypot(pk.pos.x - feet.x, pk.pos.z - feet.z) > PICKUP_RADIUS || Math.abs(pk.pos.y - feet.y) > 1.5) continue;
      this.pickupsTaken.add(pk.id);
      p.hp = Math.min(p.maxHp, p.hp + pk.amount);
      this.events.push({ type: 'pickup', id: pk.id });
    }
  }

  private inTrigger(id: string): boolean {
    const t = this.level.triggers.find((tr) => tr.id === id);
    if (!t) return false;
    const f = this.player.move.body.pos;
    return (
      f.x >= t.min.x && f.x <= t.max.x && f.z >= t.min.z && f.z <= t.max.z && f.y >= t.min.y - 0.1 && f.y <= t.max.y
    );
  }

  private updateHints(): void {
    for (const h of this.level.hints) {
      if (this.hintsShown.has(h.trigger) || !this.inTrigger(h.trigger)) continue;
      this.hintsShown.add(h.trigger);
      this.events.push({ type: 'hint', text: h.text });
    }
  }

  private updateMission(): void {
    const m = this.mission;
    const obj = this.currentObjective();
    if (!obj) return;
    if (obj.kind === 'reach') {
      if (this.inTrigger(obj.trigger)) this.completeObjective();
    } else if (obj.kind === 'eliminate') {
      m.total = this.enemies.length;
      m.done = 0;
      for (const e of this.enemies) if (e.state === 'dead') m.done++;
      if (m.done >= m.total) this.completeObjective();
    }
  }

  private completeObjective(): void {
    const m = this.mission;
    const obj = this.level.objectives[m.index];
    m.index++;
    const next = this.level.objectives[m.index] ?? null;
    this.events.push({ type: 'objective', completed: obj.id, next: next ? next.id : null });
    this.radio(`objective:${obj.id}:done`);
    if (!next) {
      m.status = 'complete';
      m.endedTick = this.tick;
      this.events.push({ type: 'missionComplete' });
      this.radio('complete');
    }
  }

  private radio(hook: string): void {
    for (const r of this.level.radio) {
      if (r.on === hook) this.events.push({ type: 'radio', lines: r.lines.map((l: RadioLine) => ({ ...l })) });
    }
  }
}
