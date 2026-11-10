import { clearLine } from '../shared/collision';
import { clamp, copy, dirToYawPitch, distance, distanceXZ, mulberry32, sub, wrapAngle, type Vec3 } from '../shared/math';
import type { Enemy } from './ai/enemy';
import { IDLE_INPUT, type Simulation, type TickInput } from './sim';

export interface BotProfile {
  /** Largest aim correction per tick, radians. */
  turnRate: number;
  /** Ticks between first seeing a target and the first shot at it. */
  reactionTicks: number;
  /** Where on the target it aims, as a fraction of the target's height. Above 0.8 is the critical zone. */
  aimHeight: number;
  /** Random aim wander in radians, re-rolled a few times a second. */
  jitter: number;
  /** Whether it sidesteps while shooting. */
  strafe: boolean;
}

/** Near-perfect play: proves a mission can be completed. */
export const BOT_EXPERT: BotProfile = { turnRate: 0.16, reactionTicks: 0, aimHeight: 0.9, jitter: 0, strafe: true };
/** A new player: slow to react, aims centre-mass, wanders off target and stands still to shoot. */
export const BOT_CASUAL: BotProfile = { turnRate: 0.04, reactionTicks: 45, aimHeight: 0.6, jitter: 0.022, strafe: false };

/**
 * Scripted player used by automated tests and by the capture tooling to prove a mission can be
 * finished. It reads the simulation directly and is never presented as a human player.
 */
export class BotController {
  yaw: number;
  pitch = 0;
  private path: Vec3[] | null = null;
  private pathIndex = 0;
  private repathAt = 0;
  private trigger = false;
  private stuck = 0;
  private crouchTicks = 0;
  private lastPos: Vec3;
  private targetId = -1;
  private engaged = 0;
  private wanderYaw = 0;
  private wanderPitch = 0;
  // Its own generator, so driving a run with the bot never changes the simulation's random stream.
  private readonly rng = mulberry32(0xb07);

  constructor(
    private readonly sim: Simulation,
    private readonly profile: BotProfile = BOT_EXPERT,
  ) {
    this.yaw = sim.player.yaw;
    this.lastPos = copy(sim.player.move.body.pos);
  }

  next(): TickInput {
    const sim = this.sim;
    const p = sim.player;
    const input: TickInput = { ...IDLE_INPUT };
    if (p.alive && sim.mission.status === 'active') {
      const target = this.pickTarget();
      if (target) this.fight(target, input);
      else this.travel(input);
    }
    input.yaw = this.yaw;
    input.pitch = this.pitch;
    return input;
  }

  private aimPoint(e: Enemy): Vec3 {
    return { x: e.body.pos.x, y: e.body.pos.y + e.def.height * this.profile.aimHeight, z: e.body.pos.z };
  }

  private pickTarget(): Enemy | null {
    const eye = this.sim.playerEye();
    let best: Enemy | null = null;
    let bestD = 45;
    for (const e of this.sim.enemies) {
      if (e.state === 'dead') continue;
      const aim = this.aimPoint(e);
      const d = distance(eye, aim);
      if (d < bestD && clearLine(this.sim.world, eye, aim)) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private turnToward(yaw: number, pitch: number, maxStep: number): void {
    this.yaw = wrapAngle(this.yaw + clamp(wrapAngle(yaw - this.yaw), -maxStep, maxStep));
    this.pitch += clamp(pitch - this.pitch, -maxStep, maxStep);
  }

  private fight(target: Enemy, input: TickInput): void {
    const p = this.sim.player;
    if (target.id !== this.targetId) {
      this.targetId = target.id;
      this.engaged = 0;
    }
    this.engaged++;
    if (this.profile.jitter > 0 && this.engaged % 18 === 1) {
      this.wanderYaw = (this.rng() - 0.5) * 2 * this.profile.jitter;
      this.wanderPitch = (this.rng() - 0.5) * 2 * this.profile.jitter;
    }
    const want = dirToYawPitch(sub(this.aimPoint(target), this.sim.playerEye()));
    want.yaw += this.wanderYaw;
    want.pitch += this.wanderPitch;
    // Aim is held below the recoil kick so the round still lands on the target.
    this.turnToward(want.yaw - p.recoilYaw, want.pitch - p.recoilPitch, this.profile.turnRate);
    const err =
      Math.abs(wrapAngle(want.yaw - this.yaw - p.recoilYaw)) + Math.abs(want.pitch - this.pitch - p.recoilPitch);
    const ready = p.weapon.cooldown === 0 && p.weapon.reloadLeft === 0 && p.weapon.equipLeft === 0;
    this.trigger = err < 0.012 && ready && !this.trigger && this.engaged > this.profile.reactionTicks;
    input.fire = this.trigger;
    input.moveX = this.profile.strafe ? (Math.sin(this.sim.tick * 0.07) > 0 ? 1 : -1) : 0;
    this.path = null;
    this.stuck = 0;
  }

  private goal(): Vec3 | null {
    const sim = this.sim;
    const obj = sim.currentObjective();
    if (!obj) return null;
    if (obj.kind !== 'eliminate') return sim.objectiveMarker();
    const feet = sim.player.move.body.pos;
    let best: Vec3 | null = null;
    let bestD = Infinity;
    for (const e of sim.enemies) {
      if (e.state === 'dead') continue;
      const d = distance(feet, e.body.pos);
      if (d < bestD) {
        bestD = d;
        best = e.body.pos;
      }
    }
    return best;
  }

  private travel(input: TickInput): void {
    const sim = this.sim;
    const feet = sim.player.move.body.pos;
    const goal = this.goal();
    this.trigger = false;
    if (!goal) return;

    const obj = sim.currentObjective();
    if (obj && obj.kind === 'interact' && distance(sim.playerEye(), goal) < 2) {
      const want = dirToYawPitch(sub(goal, sim.playerEye()));
      this.turnToward(want.yaw, want.pitch, 0.2);
      input.interact = true;
      return;
    }

    if (!this.path || sim.tick >= this.repathAt) {
      this.path = sim.nav.findPath(feet, goal);
      this.pathIndex = 0;
      this.repathAt = sim.tick + 30;
    }
    let wp = goal;
    if (this.path && this.path.length > 0) {
      while (this.pathIndex < this.path.length - 1 && distanceXZ(feet, this.path[this.pathIndex]) < 0.4) this.pathIndex++;
      wp = this.path[this.pathIndex];
    }
    const wantYaw = Math.atan2(-(wp.x - feet.x), -(wp.z - feet.z));
    this.turnToward(wantYaw, 0, 0.2);
    const yawErr = Math.abs(wrapAngle(wantYaw - this.yaw));
    if (distanceXZ(feet, wp) > 0.2 && yawErr < 0.7) {
      input.moveZ = 1;
      input.sprint = yawErr < 0.2 && distanceXZ(feet, goal) > 6;
    }

    // Obstacles the navigation grid does not cover (vaults, crawl spaces): try a jump, then a crouch.
    const moved = distanceXZ(feet, this.lastPos);
    this.lastPos = copy(feet);
    this.stuck = input.moveZ > 0 && moved < 0.01 ? this.stuck + 1 : 0;
    if (this.crouchTicks > 0) {
      this.crouchTicks--;
      input.crouch = true;
    } else if (this.stuck > 40) {
      this.crouchTicks = 100;
      this.stuck = 0;
    } else if (this.stuck > 6 && this.stuck % 12 === 7) {
      input.jump = true;
    }
  }
}
