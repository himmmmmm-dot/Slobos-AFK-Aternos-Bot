import type { Solid } from '../shared/collision';
import type { Vec3 } from '../shared/math';
import type { RadioLine } from './events';

export type ObjectiveDef = { id: string; text: string } & (
  | { kind: 'reach'; trigger: string }
  | { kind: 'eliminate' }
  | { kind: 'interact'; target: string }
);

export interface LevelLight {
  pos: Vec3;
  color: number;
  intensity: number;
  distance: number;
}

export interface LevelDef {
  id: string;
  name: string;
  subtitle: string;
  solids: Solid[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Falling below this height is fatal, so a geometry gap can never soft-lock a run. */
  killY: number;
  spawn: { pos: Vec3; yaw: number };
  enemies: { kind: 'security'; pos: Vec3; yaw?: number; patrol: Vec3[] }[];
  triggers: { id: string; min: Vec3; max: Vec3 }[];
  interactables: { id: string; pos: Vec3; radius: number; holdTicks: number; prompt: string }[];
  pickups: { id: string; kind: 'health'; pos: Vec3; amount: number }[];
  objectives: ObjectiveDef[];
  /** Onboarding prompts shown the first time a trigger is entered. {action} is replaced by its bound key. */
  hints: { trigger: string; text: string }[];
  /** Radio lines keyed by hook: "start", "objective:<id>:done", "complete". */
  radio: { on: string; lines: RadioLine[] }[];

  // Presentation only below this line.
  lights: LevelLight[];
  spot?: { pos: Vec3; target: Vec3; color: number; intensity: number; angle: number };
  accents: { min: Vec3; max: Vec3; color: number; intensity: number }[];
  ambient: { fog: number; fogDensity: number; sky: number; ground: number; hemi: number };
}
