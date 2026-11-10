import { TICK_RATE } from './constants';
import { normalize, type Rng, type Vec3 } from './math';

export interface WeaponDef {
  id: string;
  name: string;
  role: string;
  /** Automatic weapons fire while the trigger is held; others need a fresh press. */
  auto: boolean;
  fireIntervalTicks: number;
  magSize: number;
  reserveStart: number;
  infiniteReserve: boolean;
  reloadTicks: number;
  equipTicks: number;
  pellets: number;
  /** Damage per pellet before range falloff. */
  damage: number;
  critMultiplier: number;
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  maxRange: number;
  /** Spread values are cone half-angles in radians. */
  spreadBase: number;
  spreadPerShot: number;
  spreadMax: number;
  spreadRecoveryPerSec: number;
  spreadMoveBonus: number;
  spreadAirBonus: number;
  spreadCrouchFactor: number;
  recoilPitch: number;
  recoilYaw: number;
  /** How far the report carries to enemy hearing, metres. */
  noiseRadius: number;
}

export interface WeaponState {
  mag: number;
  reserve: number;
  cooldown: number;
  reloadLeft: number;
  equipLeft: number;
  bloom: number;
  triggerWasDown: boolean;
  buffer: number;
  shots: number;
}

export type WeaponEvent =
  /** `bloom` is the value before this shot, so the first round is fully accurate. */
  | { type: 'fire'; shot: number; bloom: number }
  | { type: 'dry' }
  | { type: 'reloadStart' }
  | { type: 'reloadEnd' };

export interface WeaponInput {
  trigger: boolean;
  reload: boolean;
}

/** A semi-auto press this many ticks before the weapon is ready still fires. */
export const FIRE_BUFFER_TICKS = 8;

export const SERVICE_PISTOL: WeaponDef = {
  id: 'pistol',
  name: 'VP-9 Service Pistol',
  role: 'Reliable sidearm. Accurate, quick to reload, and it never runs dry.',
  auto: false,
  fireIntervalTicks: 9,
  magSize: 12,
  reserveStart: 0,
  infiniteReserve: true,
  reloadTicks: 84,
  equipTicks: 24,
  pellets: 1,
  damage: 26,
  critMultiplier: 2,
  falloffStart: 18,
  falloffEnd: 42,
  falloffMin: 0.6,
  maxRange: 120,
  spreadBase: 0.0035,
  spreadPerShot: 0.011,
  spreadMax: 0.045,
  // Slower than one shot's bloom per fire interval, so spamming opens the cone and pacing keeps it tight.
  spreadRecoveryPerSec: 0.045,
  spreadMoveBonus: 0.006,
  spreadAirBonus: 0.03,
  spreadCrouchFactor: 0.7,
  recoilPitch: 0.021,
  recoilYaw: 0.006,
  noiseRadius: 28,
};

export function createWeaponState(def: WeaponDef): WeaponState {
  return {
    mag: def.magSize,
    reserve: def.reserveStart,
    cooldown: 0,
    reloadLeft: 0,
    equipLeft: def.equipTicks,
    bloom: 0,
    triggerWasDown: false,
    buffer: 0,
    shots: 0,
  };
}

const NONE: readonly WeaponEvent[] = [];

function canReload(def: WeaponDef, st: WeaponState): boolean {
  return st.mag < def.magSize && (def.infiniteReserve || st.reserve > 0);
}

function startReload(def: WeaponDef, st: WeaponState): readonly WeaponEvent[] {
  st.reloadLeft = def.reloadTicks;
  st.buffer = 0;
  return [{ type: 'reloadStart' }];
}

/** Advances the weapon by one fixed tick. All timing is in ticks, never frame time. */
export function stepWeapon(def: WeaponDef, st: WeaponState, input: WeaponInput): readonly WeaponEvent[] {
  if (st.cooldown > 0) st.cooldown--;
  if (st.bloom > 0) st.bloom = Math.max(0, st.bloom - def.spreadRecoveryPerSec / TICK_RATE);
  const pressed = input.trigger && !st.triggerWasDown;
  st.triggerWasDown = input.trigger;

  if (st.equipLeft > 0) {
    st.equipLeft--;
    return NONE;
  }
  if (st.reloadLeft > 0) {
    st.reloadLeft--;
    if (st.reloadLeft > 0) return NONE;
    const want = def.magSize - st.mag;
    const got = def.infiniteReserve ? want : Math.min(want, st.reserve);
    st.mag += got;
    if (!def.infiniteReserve) st.reserve -= got;
    return [{ type: 'reloadEnd' }];
  }

  if (pressed) st.buffer = FIRE_BUFFER_TICKS;
  else if (st.buffer > 0) st.buffer--;

  if (input.reload && canReload(def, st)) return startReload(def, st);

  if (st.mag === 0) {
    // An empty weapon reloads by itself once the last shot has cycled; it only clicks when it cannot.
    if (canReload(def, st)) return st.cooldown === 0 ? startReload(def, st) : NONE;
    return pressed ? [{ type: 'dry' }] : NONE;
  }

  const wants = def.auto ? input.trigger : st.buffer > 0;
  if (wants && st.cooldown === 0) {
    const bloom = st.bloom;
    st.mag--;
    st.cooldown = def.fireIntervalTicks;
    st.bloom = Math.min(def.spreadMax - def.spreadBase, bloom + def.spreadPerShot);
    st.buffer = 0;
    st.shots++;
    return [{ type: 'fire', shot: st.shots, bloom }];
  }
  return NONE;
}

export interface SpreadContext {
  /** Horizontal speed as a fraction of walk speed, 0..1+. */
  moving: number;
  airborne: boolean;
  crouched: boolean;
}

export function currentSpread(def: WeaponDef, bloom: number, ctx: SpreadContext): number {
  let s = def.spreadBase + bloom + def.spreadMoveBonus * Math.min(1.5, ctx.moving);
  if (ctx.airborne) s += def.spreadAirBonus;
  if (ctx.crouched) s *= def.spreadCrouchFactor;
  return s;
}

export function damageAtRange(def: WeaponDef, dist: number): number {
  if (dist <= def.falloffStart) return def.damage;
  if (dist >= def.falloffEnd) return def.damage * def.falloffMin;
  const t = (dist - def.falloffStart) / (def.falloffEnd - def.falloffStart);
  return def.damage * (1 - t * (1 - def.falloffMin));
}

/** A direction inside the spread cone around forward, uniform over the disc. */
export function spreadDirection(forward: Vec3, right: Vec3, up: Vec3, spread: number, rng: Rng): Vec3 {
  const r = Math.tan(spread) * Math.sqrt(rng());
  const a = rng() * Math.PI * 2;
  const cx = Math.cos(a) * r;
  const cy = Math.sin(a) * r;
  return normalize({
    x: forward.x + right.x * cx + up.x * cy,
    y: forward.y + right.y * cx + up.y * cy,
    z: forward.z + right.z * cx + up.z * cy,
  });
}
