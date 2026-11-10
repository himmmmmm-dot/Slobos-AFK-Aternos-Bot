export const ACTIONS = [
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'sprint',
  'crouch',
  'fire',
  'reload',
  'interact',
  'pause',
] as const;

export type Action = (typeof ACTIONS)[number];
export type Bindings = Record<Action, string[]>;

export const ACTION_LABELS: Record<Action, string> = {
  forward: 'Move forward',
  back: 'Move back',
  left: 'Strafe left',
  right: 'Strafe right',
  jump: 'Jump',
  sprint: 'Sprint',
  crouch: 'Crouch',
  fire: 'Fire',
  reload: 'Reload',
  interact: 'Interact',
  pause: 'Pause and release mouse',
};

/**
 * Bindings are physical key positions (KeyboardEvent.code), so the WASD cluster lands under the
 * same fingers on AZERTY and other layouts without the player rebinding anything.
 */
export const DEFAULT_BINDINGS: Bindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft'],
  crouch: ['KeyC'],
  fire: ['Mouse0'],
  reload: ['KeyR'],
  interact: ['KeyE'],
  pause: ['KeyP'],
};

/**
 * Keys the browser or the host page owns: Escape leaves pointer lock and fullscreen, Ctrl+W closes
 * the tab, Alt and Meta open browser or OS menus, and function keys reload or toggle fullscreen.
 */
export function isBindable(code: string): boolean {
  if (!code || code === 'Escape' || code === 'Unidentified') return false;
  if (/^(Control|Alt|Meta|OS)/.test(code)) return false;
  if (/^F\d{1,2}$/.test(code)) return false;
  return true;
}

export function cloneBindings(b: Bindings): Bindings {
  const out = {} as Bindings;
  for (const a of ACTIONS) out[a] = [...b[a]];
  return out;
}

/** Assigns a key to an action as its primary binding. An action that loses its only key takes the freed one. */
export function rebind(b: Bindings, action: Action, code: string): Bindings {
  const out = cloneBindings(b);
  if (!isBindable(code)) return out;
  const freed = out[action][0];
  for (const a of ACTIONS) out[a] = out[a].filter((c) => c !== code);
  out[action] = [code, ...out[action].slice(1)].slice(0, 2);
  const taken = (c: string): boolean => ACTIONS.some((o) => out[o].includes(c));
  for (const a of ACTIONS) {
    if (out[a].length > 0) continue;
    const pick = [freed, ...DEFAULT_BINDINGS[a]].find((c) => c && !taken(c));
    if (pick) out[a] = [pick];
  }
  return out;
}

const NAMES: Record<string, string> = {
  Space: 'Space',
  ShiftLeft: 'Shift',
  ShiftRight: 'Right Shift',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  CapsLock: 'Caps',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Mouse0: 'Left mouse',
  Mouse1: 'Middle mouse',
  Mouse2: 'Right mouse',
  Mouse3: 'Mouse 4',
  Mouse4: 'Mouse 5',
};

/** Human label for a key code. `layout` maps codes to the characters printed on the player's keyboard. */
export function keyLabel(code: string, layout?: Map<string, string> | null): string {
  if (NAMES[code]) return NAMES[code];
  const printed = layout?.get(code);
  if (printed) return printed.toUpperCase();
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}
