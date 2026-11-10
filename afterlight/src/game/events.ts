import type { Vec3 } from '../shared/math';

export type AiState = 'patrol' | 'investigate' | 'combat' | 'search' | 'return' | 'dead';

export interface RadioLine {
  speaker: string;
  text: string;
}

export interface ShotHit {
  point: Vec3;
  normal: Vec3;
  /** False when the round left the level without touching anything. */
  surface: boolean;
  enemyId: number | null;
  crit: boolean;
  killed: boolean;
  distance: number;
}

/** Everything the presentation layer needs to react to; the simulation never depends on a listener. */
export type SimEvent =
  | { type: 'shot'; origin: Vec3; hits: ShotHit[] }
  | { type: 'dry' }
  | { type: 'reloadStart' }
  | { type: 'reloadEnd' }
  | { type: 'footstep'; sprint: boolean }
  | { type: 'jump' }
  | { type: 'land'; speed: number }
  | { type: 'playerHurt'; amount: number; from: Vec3 | null }
  | { type: 'playerDead' }
  | { type: 'enemyWindup'; id: number }
  | { type: 'enemyFire'; id: number; origin: Vec3 }
  | { type: 'enemyHurt'; id: number; crit: boolean }
  | { type: 'enemyDead'; id: number }
  | { type: 'enemyState'; id: number; state: AiState }
  | { type: 'boltImpact'; point: Vec3; normal: Vec3; hitPlayer: boolean }
  | { type: 'objective'; completed: string; next: string | null }
  | { type: 'missionComplete' }
  | { type: 'hint'; text: string }
  | { type: 'radio'; lines: RadioLine[] }
  | { type: 'pickup'; id: string }
  | { type: 'interactDone'; id: string };
