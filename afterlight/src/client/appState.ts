export type AppState = 'boot' | 'loading' | 'menu' | 'playing' | 'paused' | 'results' | 'failed' | 'error';

/** Every legal transition. Multiplayer states (lobby, match, match results) join this table in Milestone 4. */
const ALLOWED: Record<AppState, readonly AppState[]> = {
  boot: ['loading', 'error'],
  loading: ['menu', 'error'],
  menu: ['playing', 'error'],
  playing: ['paused', 'results', 'failed', 'error'],
  paused: ['playing', 'menu', 'error'],
  results: ['playing', 'menu', 'error'],
  failed: ['playing', 'menu', 'error'],
  error: [],
};

export type StateListener = (to: AppState, from: AppState) => void;

export class AppStateMachine {
  private listeners = new Set<StateListener>();

  constructor(public state: AppState = 'boot') {}

  can(to: AppState): boolean {
    return ALLOWED[this.state].includes(to);
  }

  /** Moves to a new state. Returns false, without side effects, when the move is not allowed. */
  go(to: AppState): boolean {
    if (!this.can(to)) return false;
    const from = this.state;
    this.state = to;
    for (const l of this.listeners) l(to, from);
    return true;
  }

  onChange(l: StateListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

/** Only this state counts as active gameplay for the platform; menus, pause and results do not. */
export const isGameplay = (s: AppState): boolean => s === 'playing';
