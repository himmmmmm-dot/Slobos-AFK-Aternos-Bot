import type { Solid } from '../src/shared/collision';
import { vec3 } from '../src/shared/math';
import type { LevelDef } from '../src/game/level';
import { IDLE_INPUT, type Simulation, type TickInput } from '../src/game/sim';

export const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Solid => ({
  min: vec3(x0, y0, z0),
  max: vec3(x1, y1, z1),
});

export const FLOOR = box(-30, -1, -30, 30, 0, 30);

/** Flat test arena. The default objective is a far-away trigger, so the mission stays active. */
export function testLevel(over: Partial<LevelDef> = {}): LevelDef {
  return {
    id: 'test',
    name: 'Test',
    subtitle: '',
    solids: [FLOOR],
    bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
    killY: -20,
    spawn: { pos: vec3(0, 0, 10), yaw: 0 },
    enemies: [],
    triggers: [{ id: 'far', min: vec3(27, 0, 27), max: vec3(29, 3, 29) }],
    interactables: [],
    pickups: [],
    objectives: [{ id: 'go', kind: 'reach', trigger: 'far', text: 'Go' }],
    hints: [],
    radio: [],
    lights: [],
    accents: [],
    ambient: { fog: 0, fogDensity: 0, sky: 0, ground: 0, hemi: 1 },
    ...over,
  };
}

type InputFn = (tick: number) => Partial<TickInput>;

/** Steps the simulation, calling `each` after every tick; stops early when it returns true. */
export function run(
  sim: Simulation,
  ticks: number,
  input: Partial<TickInput> | InputFn = {},
  each?: (sim: Simulation) => boolean | void,
): void {
  for (let i = 0; i < ticks; i++) {
    const partial = typeof input === 'function' ? input(i) : input;
    sim.step({ ...IDLE_INPUT, yaw: sim.player.yaw, pitch: sim.player.pitch, ...partial });
    if (each && each(sim) === true) return;
  }
}

export function teleport(sim: Simulation, x: number, y: number, z: number): void {
  const b = sim.player.move.body;
  b.pos.x = x;
  b.pos.y = y;
  b.pos.z = z;
  b.vel.x = b.vel.y = b.vel.z = 0;
}
