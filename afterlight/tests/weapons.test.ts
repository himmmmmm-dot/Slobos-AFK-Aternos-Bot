import { describe, expect, it } from 'vitest';
import { FixedStep } from '../src/shared/loop';
import { dot, mulberry32, vec3 } from '../src/shared/math';
import {
  createWeaponState,
  damageAtRange,
  SERVICE_PISTOL,
  spreadDirection,
  stepWeapon,
  type WeaponDef,
  type WeaponEvent,
  type WeaponState,
} from '../src/shared/weapons';

const ready = (def: WeaponDef): WeaponState => {
  const st = createWeaponState(def);
  st.equipLeft = 0;
  return st;
};

const AUTO: WeaponDef = {
  ...SERVICE_PISTOL,
  id: 'test-auto',
  auto: true,
  fireIntervalTicks: 6,
  magSize: 5,
  reserveStart: 7,
  infiniteReserve: false,
  reloadTicks: 30,
};

type Log = { tick: number; type: WeaponEvent['type'] }[];

function drive(
  def: WeaponDef,
  st: WeaponState,
  ticks: number,
  input: (t: number) => { trigger: boolean; reload?: boolean },
  from = 0,
): Log {
  const log: Log = [];
  for (let t = from; t < from + ticks; t++) {
    for (const ev of stepWeapon(def, st, { reload: false, ...input(t) })) log.push({ tick: t, type: ev.type });
  }
  return log;
}

const ticksOf = (log: Log, type: WeaponEvent['type']): number[] => log.filter((e) => e.type === type).map((e) => e.tick);

describe('weapon timing and ammunition', () => {
  it('holds an exact cadence, then reloads on schedule (automatic)', () => {
    const st = ready(AUTO);
    const log = drive(AUTO, st, 62, () => ({ trigger: true }));
    expect(ticksOf(log, 'fire')).toEqual([0, 6, 12, 18, 24, 61]);
    expect(ticksOf(log, 'reloadStart')).toEqual([30]);
    expect(ticksOf(log, 'reloadEnd')).toEqual([60]);
    expect(st.reserve).toBe(2);
  });

  it('fires a semi-automatic weapon once per press', () => {
    const st = ready(SERVICE_PISTOL);
    const log = drive(SERVICE_PISTOL, st, 120, () => ({ trigger: true }));
    expect(ticksOf(log, 'fire')).toEqual([0]);
    expect(st.mag).toBe(SERVICE_PISTOL.magSize - 1);
  });

  it('never beats the fire interval however fast the trigger is pulled', () => {
    const st = ready(SERVICE_PISTOL);
    const fires = ticksOf(
      drive(SERVICE_PISTOL, st, 100, (t) => ({ trigger: t % 2 === 0 })),
      'fire',
    );
    expect(fires.length).toBeGreaterThan(5);
    for (let i = 1; i < fires.length; i++) {
      expect(fires[i] - fires[i - 1]).toBeGreaterThanOrEqual(SERVICE_PISTOL.fireIntervalTicks);
    }
  });

  it('buffers a slightly early press and drops one that is far too early', () => {
    const early = ready(SERVICE_PISTOL);
    expect(ticksOf(drive(SERVICE_PISTOL, early, 30, (t) => ({ trigger: t === 0 || t === 4 })), 'fire')).toEqual([0, 9]);
    const tooEarly = ready(SERVICE_PISTOL);
    expect(ticksOf(drive(SERVICE_PISTOL, tooEarly, 30, (t) => ({ trigger: t === 0 || t === 1 })), 'fire')).toEqual([0]);
  });

  it('reloads automatically when empty and cannot fire until the reload ends', () => {
    const st = ready(SERVICE_PISTOL);
    const log = drive(SERVICE_PISTOL, st, 400, (t) => ({ trigger: t % 2 === 0 }));
    const start = ticksOf(log, 'reloadStart')[0];
    const end = ticksOf(log, 'reloadEnd')[0];
    expect(end - start).toBe(SERVICE_PISTOL.reloadTicks);
    expect(ticksOf(log, 'fire').filter((t) => t > start && t <= end)).toEqual([]);
    expect(ticksOf(log, 'fire').filter((t) => t < start).length).toBe(SERVICE_PISTOL.magSize);
    expect(ticksOf(log, 'dry')).toEqual([]);
  });

  it('spends a finite reserve and dry-fires when nothing is left', () => {
    const st = ready(AUTO);
    const log = drive(AUTO, st, 400, (t) => ({ trigger: t % 40 !== 39 }));
    expect(ticksOf(log, 'fire').length).toBe(AUTO.magSize + AUTO.reserveStart);
    expect(st.mag).toBe(0);
    expect(st.reserve).toBe(0);
    expect(ticksOf(log, 'reloadStart').length).toBe(2);
    expect(ticksOf(log, 'dry').length).toBeGreaterThan(0);
  });

  it('ignores a manual reload with a full magazine and honours one otherwise', () => {
    const st = ready(SERVICE_PISTOL);
    expect(drive(SERVICE_PISTOL, st, 5, () => ({ trigger: false, reload: true }))).toEqual([]);
    drive(SERVICE_PISTOL, st, 1, () => ({ trigger: true }));
    const log = drive(SERVICE_PISTOL, st, SERVICE_PISTOL.reloadTicks + 2, (t) => ({ trigger: false, reload: t === 0 }));
    expect(ticksOf(log, 'reloadStart')).toEqual([0]);
    expect(st.mag).toBe(SERVICE_PISTOL.magSize);
  });

  it('waits for the equip time before the first shot', () => {
    const st = createWeaponState(SERVICE_PISTOL);
    const log = drive(SERVICE_PISTOL, st, 60, (t) => ({ trigger: t % 2 === 0 }));
    expect(ticksOf(log, 'fire')[0]).toBeGreaterThanOrEqual(SERVICE_PISTOL.equipTicks);
  });
});

describe('spread, recoil bloom and damage', () => {
  it('keeps the first shot accurate, grows bloom to a cap and recovers', () => {
    const st = ready(SERVICE_PISTOL);
    const blooms: number[] = [];
    for (let t = 0; t < 90; t++) {
      for (const ev of stepWeapon(SERVICE_PISTOL, st, { trigger: t % 2 === 0, reload: false })) {
        if (ev.type === 'fire') blooms.push(ev.bloom);
      }
    }
    expect(blooms[0]).toBe(0);
    expect(blooms[3]).toBeGreaterThan(blooms[1]);
    expect(Math.max(...blooms)).toBeLessThanOrEqual(SERVICE_PISTOL.spreadMax - SERVICE_PISTOL.spreadBase + 1e-9);
    for (let t = 0; t < 120; t++) stepWeapon(SERVICE_PISTOL, st, { trigger: false, reload: false });
    expect(st.bloom).toBe(0);
  });

  it('keeps every round inside the cone and is reproducible from a seed', () => {
    const fwd = vec3(0, 0, -1);
    const right = vec3(1, 0, 0);
    const up = vec3(0, 1, 0);
    const spread = 0.04;
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const d = spreadDirection(fwd, right, up, spread, a);
      expect(Math.acos(Math.min(1, dot(d, fwd)))).toBeLessThanOrEqual(spread + 1e-9);
      expect(spreadDirection(fwd, right, up, spread, b)).toEqual(d);
    }
  });

  it('falls off with range between fixed bounds', () => {
    const def = SERVICE_PISTOL;
    expect(damageAtRange(def, 0)).toBe(def.damage);
    expect(damageAtRange(def, def.falloffStart)).toBe(def.damage);
    expect(damageAtRange(def, 500)).toBeCloseTo(def.damage * def.falloffMin);
    const mid = damageAtRange(def, (def.falloffStart + def.falloffEnd) / 2);
    expect(mid).toBeLessThan(def.damage);
    expect(mid).toBeGreaterThan(def.damage * def.falloffMin);
  });
});

describe('fixed timestep', () => {
  it('runs the same number of ticks per second at any refresh rate', () => {
    for (const hz of [30, 60, 75, 120, 144, 165, 240]) {
      const loop = new FixedStep();
      let ticks = 0;
      for (let f = 0; f < hz * 10; f++) ticks += loop.advance(1 / hz);
      expect(Math.abs(ticks - 600)).toBeLessThanOrEqual(1);
    }
  });

  it('caps catch-up after a long stall instead of spiralling', () => {
    const loop = new FixedStep();
    expect(loop.advance(3)).toBe(loop.maxTicks);
    expect(loop.advance(1 / 60)).toBe(1);
  });

  it('gives the same weapon cadence at 30 Hz and 144 Hz rendering', () => {
    const shotsAt = (hz: number): number => {
      const loop = new FixedStep();
      const st = ready(AUTO);
      st.reserve = 1000;
      let shots = 0;
      for (let f = 0; f < hz * 5; f++) {
        const n = loop.advance(1 / hz);
        for (let i = 0; i < n; i++) {
          for (const ev of stepWeapon(AUTO, st, { trigger: true, reload: false })) if (ev.type === 'fire') shots++;
        }
      }
      return shots;
    };
    expect(Math.abs(shotsAt(30) - shotsAt(144))).toBeLessThanOrEqual(1);
  });
});
