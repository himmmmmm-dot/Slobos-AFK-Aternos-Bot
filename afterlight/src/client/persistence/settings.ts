import { ACTIONS, cloneBindings, DEFAULT_BINDINGS, isBindable, type Bindings } from '../bindings';
import type { SafeStore } from './storage';

export const SETTINGS_KEY = 'afterlight.settings';
export const SETTINGS_VERSION = 1;

export type Quality = 'low' | 'medium' | 'high';

export interface Settings {
  version: number;
  sensitivity: number;
  invertY: boolean;
  /** Horizontal field of view in degrees on a 16:9 view. */
  fov: number;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  dialogueVolume: number;
  muted: boolean;
  quality: Quality;
  brightness: number;
  viewBob: boolean;
  screenShake: boolean;
  hudScale: number;
  subtitles: boolean;
  bindings: Bindings;
}

export const LIMITS = {
  sensitivity: [0.2, 3],
  fov: [75, 110],
  brightness: [0.7, 1.4],
  hudScale: [0.8, 1.4],
} as const;

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    sensitivity: 1,
    invertY: false,
    fov: 95,
    masterVolume: 0.8,
    musicVolume: 0.6,
    sfxVolume: 0.9,
    dialogueVolume: 1,
    muted: false,
    quality: 'medium',
    brightness: 1,
    // Camera motion is opt-out, kept gentle, and never required to read the game.
    viewBob: true,
    screenShake: true,
    hudScale: 1,
    subtitles: true,
    bindings: cloneBindings(DEFAULT_BINDINGS),
  };
}

const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

function sanitizeBindings(raw: unknown): Bindings {
  const out = cloneBindings(DEFAULT_BINDINGS);
  if (!raw || typeof raw !== 'object') return out;
  const used = new Set<string>();
  for (const a of ACTIONS) {
    const list = (raw as Record<string, unknown>)[a];
    if (!Array.isArray(list)) continue;
    const codes = list.filter((c): c is string => typeof c === 'string' && isBindable(c) && !used.has(c)).slice(0, 2);
    if (codes.length === 0) continue;
    out[a] = codes;
    for (const c of codes) used.add(c);
  }
  // A saved key wins over a default that now collides with it.
  for (const a of ACTIONS) {
    const list = (raw as Record<string, unknown>)[a];
    if (Array.isArray(list) && out[a].some((c) => used.has(c))) continue;
    out[a] = out[a].filter((c) => !used.has(c));
    if (out[a].length === 0) out[a] = [...DEFAULT_BINDINGS[a]];
  }
  return out;
}

/** Builds a valid settings object from anything: missing, wrongly typed and out-of-range fields fall back. */
export function sanitizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  return {
    version: SETTINGS_VERSION,
    sensitivity: num(r.sensitivity, LIMITS.sensitivity[0], LIMITS.sensitivity[1], d.sensitivity),
    invertY: bool(r.invertY, d.invertY),
    fov: num(r.fov, LIMITS.fov[0], LIMITS.fov[1], d.fov),
    masterVolume: num(r.masterVolume, 0, 1, d.masterVolume),
    musicVolume: num(r.musicVolume, 0, 1, d.musicVolume),
    sfxVolume: num(r.sfxVolume, 0, 1, d.sfxVolume),
    dialogueVolume: num(r.dialogueVolume, 0, 1, d.dialogueVolume),
    muted: bool(r.muted, d.muted),
    quality: r.quality === 'low' || r.quality === 'medium' || r.quality === 'high' ? r.quality : d.quality,
    brightness: num(r.brightness, LIMITS.brightness[0], LIMITS.brightness[1], d.brightness),
    viewBob: bool(r.viewBob, d.viewBob),
    screenShake: bool(r.screenShake, d.screenShake),
    hudScale: num(r.hudScale, LIMITS.hudScale[0], LIMITS.hudScale[1], d.hudScale),
    subtitles: bool(r.subtitles, d.subtitles),
    bindings: sanitizeBindings(r.bindings),
  };
}

/**
 * Upgrades from older save versions, applied in order. Index n upgrades version n to n + 1.
 * Version 0 is the unversioned shape used by pre-release builds, which stored one `volume` field.
 */
const MIGRATIONS: ((old: Record<string, unknown>) => Record<string, unknown>)[] = [
  (old) => {
    const next = { ...old };
    if (typeof old.volume === 'number' && old.masterVolume === undefined) next.masterVolume = old.volume;
    delete next.volume;
    return next;
  },
];

export type LoadStatus =
  /** Nothing was saved yet. */
  | 'fresh'
  | 'loaded'
  | 'migrated'
  /** The save was unreadable and defaults were used instead. */
  | 'recovered'
  /** Written by a newer build; the fields this build understands were kept. */
  | 'newer';

export function loadSettings(store: SafeStore): { settings: Settings; status: LoadStatus } {
  const text = store.get(SETTINGS_KEY);
  if (text === null) return { settings: defaultSettings(), status: 'fresh' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { settings: defaultSettings(), status: 'recovered' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { settings: defaultSettings(), status: 'recovered' };
  }
  let data = parsed as Record<string, unknown>;
  const version = typeof data.version === 'number' && Number.isInteger(data.version) && data.version >= 0 ? data.version : 0;
  if (version > SETTINGS_VERSION) return { settings: sanitizeSettings(data), status: 'newer' };
  for (let v = version; v < SETTINGS_VERSION; v++) data = MIGRATIONS[v](data);
  return { settings: sanitizeSettings(data), status: version < SETTINGS_VERSION ? 'migrated' : 'loaded' };
}

export function saveSettings(store: SafeStore, settings: Settings): boolean {
  return store.set(SETTINGS_KEY, JSON.stringify({ ...settings, version: SETTINGS_VERSION }));
}
