import { describe, expect, it, vi } from 'vitest';
import { AppStateMachine, type AppState } from '../src/client/appState';
import { DEFAULT_BINDINGS, isBindable, keyLabel, rebind } from '../src/client/bindings';
import { bindPlatformLifecycle } from '../src/client/lifecycle';
import { defaultSettings, loadSettings, saveSettings, SETTINGS_KEY, SETTINGS_VERSION } from '../src/client/persistence/settings';
import { MemoryStore, resolveStore, SafeStore, type KeyValueStore } from '../src/client/persistence/storage';
import { CrazyGamesPlatform, type CrazyHost, type CrazySdk } from '../src/client/platform/crazygames';
import { NullPlatform } from '../src/client/platform/index';

/** Records every SDK call so tests can assert the exact lifecycle the platform would observe. */
function fakeSdk(over: Partial<{ environment: string; initFails: unknown; dataDisabled: boolean; mute: boolean }> = {}) {
  const calls: string[] = [];
  const listeners: ((s: { muteAudio?: boolean }) => void)[] = [];
  const data = new Map<string, string>();
  const guard = (): void => {
    if (over.dataDisabled) throw { code: 'dataModuleDisabled', message: 'Data module is disabled' };
  };
  const sdk: CrazySdk = {
    init: async () => {
      calls.push('init');
      if (over.initFails) throw over.initFails;
    },
    environment: over.environment ?? 'crazygames',
    game: {
      gameplayStart: () => void calls.push('gameplayStart'),
      gameplayStop: () => void calls.push('gameplayStop'),
      loadingStart: () => void calls.push('loadingStart'),
      loadingStop: () => void calls.push('loadingStop'),
      settings: { muteAudio: over.mute ?? false },
      addSettingsChangeListener: (l) => void listeners.push(l),
      removeSettingsChangeListener: () => {},
    },
    data: {
      getItem: (k) => {
        guard();
        return data.get(k) ?? null;
      },
      setItem: (k, v) => {
        guard();
        data.set(k, v);
      },
      removeItem: (k) => {
        guard();
        data.delete(k);
      },
    },
  };
  return { sdk, calls, listeners, data };
}

function hostFor(sdk: CrazySdk | undefined, load: () => Promise<void> = async () => {}): CrazyHost & { loads: number } {
  let present = false;
  const host = {
    loads: 0,
    sdk: () => (present ? sdk : undefined),
    loadScript: async () => {
      host.loads++;
      await load();
      present = true;
    },
  };
  return host;
}

describe('CrazyGames platform adapter', () => {
  it('loads the SDK script, initialises once and reports the environment', async () => {
    const f = fakeSdk();
    const host = hostFor(f.sdk);
    const p = new CrazyGamesPlatform(host);
    expect(p.status).toBe('idle');
    await Promise.all([p.init(), p.init()]);
    await p.init();
    expect(host.loads).toBe(1);
    expect(f.calls).toEqual(['init']);
    expect(p).toMatchObject({ status: 'ready', environment: 'crazygames', unavailableReason: null });
    expect(p.dataStore?.kind).toBe('crazygames-data');
  });

  it('sends each lifecycle signal once per real transition', async () => {
    const f = fakeSdk();
    const p = new CrazyGamesPlatform(hostFor(f.sdk));
    await p.init();
    f.calls.length = 0;
    p.loadingStop();
    p.gameplayStop();
    p.loadingStart();
    p.loadingStart();
    p.loadingStop();
    p.loadingStop();
    p.gameplayStart();
    p.gameplayStart();
    p.gameplayStop();
    p.gameplayStop();
    p.gameplayStart();
    expect(f.calls).toEqual(['loadingStart', 'loadingStop', 'gameplayStart', 'gameplayStop', 'gameplayStart']);
  });

  it('drops signals sent before initialisation instead of replaying them later', async () => {
    const f = fakeSdk();
    const p = new CrazyGamesPlatform(hostFor(f.sdk));
    p.gameplayStart();
    await p.init();
    p.gameplayStop();
    expect(f.calls).toEqual(['init']);
    p.gameplayStart();
    expect(f.calls).toEqual(['init', 'gameplayStart']);
  });

  it.each([
    ['a blocked script', hostFor(undefined, async () => Promise.reject(new Error('blocked'))), /blocked/],
    ['a script that defines nothing', { sdk: () => undefined, loadScript: async () => {} } as CrazyHost, /missing/],
    ['a rejected init', hostFor(fakeSdk({ initFails: { code: 'initFailed', message: 'boom' } }).sdk), /initFailed: boom/],
    ['a disabled domain', hostFor(fakeSdk({ environment: 'disabled' }).sdk), /disabled/],
  ])('stays usable and says why after %s', async (_name, host, reason) => {
    const p = new CrazyGamesPlatform(host as CrazyHost);
    await expect(p.init()).resolves.toBeUndefined();
    expect(p.status).toBe('unavailable');
    expect(p.unavailableReason).toMatch(reason);
    expect(p.dataStore).toBeNull();
    expect(() => {
      p.loadingStart();
      p.gameplayStart();
      p.gameplayStop();
      p.loadingStop();
    }).not.toThrow();
  });

  it('gives up on a script or an init that never finishes', async () => {
    vi.useFakeTimers();
    try {
      const hung = new CrazyGamesPlatform(hostFor(undefined, () => new Promise(() => {})), 500);
      const done = hung.init();
      await vi.advanceTimersByTimeAsync(600);
      await done;
      expect(hung.status).toBe('unavailable');
      expect(hung.unavailableReason).toMatch(/did not finish within 500 ms/);

      const f = fakeSdk();
      f.sdk.init = () => new Promise(() => {});
      const slow = new CrazyGamesPlatform(hostFor(f.sdk), 500);
      const done2 = slow.init();
      await vi.advanceTimersByTimeAsync(600);
      await done2;
      expect(slow.status).toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats the local test environment as ready and does not fail when one call throws', async () => {
    const f = fakeSdk({ environment: 'local' });
    f.sdk.game.gameplayStart = () => {
      throw { code: 'other', message: 'nope' };
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new CrazyGamesPlatform(hostFor(f.sdk));
    await p.init();
    expect(p).toMatchObject({ status: 'ready', environment: 'local' });
    expect(() => p.gameplayStart()).not.toThrow();
    // The failed start was never registered, so no stop is sent for it.
    p.gameplayStop();
    expect(f.calls).toEqual(['init']);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('follows the platform mute setting and its changes', async () => {
    const f = fakeSdk({ mute: true });
    const p = new CrazyGamesPlatform(hostFor(f.sdk));
    await p.init();
    expect(p.muteAudio).toBe(true);
    const seen: boolean[] = [];
    const off = p.onMuteAudioChange((m) => seen.push(m));
    f.listeners[0]({ muteAudio: true });
    f.listeners[0]({ muteAudio: false });
    f.listeners[0]({});
    off();
    f.listeners[0]({ muteAudio: true });
    expect(seen).toEqual([false]);
    expect(p.muteAudio).toBe(true);
  });

  it('reports a disabled data module instead of pretending to save', async () => {
    const f = fakeSdk({ dataDisabled: true });
    const p = new CrazyGamesPlatform(hostFor(f.sdk));
    await p.init();
    expect(p.status).toBe('ready');
    expect(p.dataStore).toBeNull();
    expect(p.dataStoreReason).toMatch(/dataModuleDisabled/);
  });

  it('the null platform is explicit about being unavailable', async () => {
    const p = new NullPlatform();
    await p.init();
    expect(p).toMatchObject({ status: 'unavailable', environment: 'none', dataStore: null });
    expect(p.unavailableReason).toMatch(/no platform SDK/);
  });
});

describe('application state and lifecycle signals', () => {
  it('only allows defined transitions', () => {
    const sm = new AppStateMachine();
    const seen: string[] = [];
    sm.onChange((to, from) => seen.push(`${from}>${to}`));
    expect(sm.go('playing')).toBe(false);
    expect(sm.go('loading')).toBe(true);
    expect(sm.go('loading')).toBe(false);
    expect(sm.go('menu')).toBe(true);
    expect(sm.go('paused')).toBe(false);
    expect(sm.go('playing')).toBe(true);
    expect(sm.go('menu')).toBe(false);
    expect(sm.go('paused')).toBe(true);
    expect(sm.go('menu')).toBe(true);
    expect(seen).toEqual(['boot>loading', 'loading>menu', 'menu>playing', 'playing>paused', 'paused>menu']);
    expect(sm.go('error')).toBe(true);
    expect(sm.go('menu')).toBe(false);
  });

  it('maps a whole session onto loading and gameplay signals with no duplicates', async () => {
    const f = fakeSdk();
    const p = new CrazyGamesPlatform(hostFor(f.sdk));
    await p.init();
    f.calls.length = 0;
    const sm = new AppStateMachine();
    bindPlatformLifecycle(sm, p);
    const path: AppState[] = ['loading', 'menu', 'playing', 'paused', 'playing', 'failed', 'playing', 'results', 'menu', 'playing', 'paused', 'menu'];
    for (const s of path) expect(sm.go(s)).toBe(true);
    expect(f.calls).toEqual([
      'loadingStart',
      'loadingStop',
      'gameplayStart', // mission starts
      'gameplayStop', // pause
      'gameplayStart', // resume
      'gameplayStop', // player died
      'gameplayStart', // retry
      'gameplayStop', // results
      'gameplayStart', // replay from menu
      'gameplayStop', // pause, then quit: no second stop
    ]);
  });

  it('stops gameplay when an error interrupts play', async () => {
    const f = fakeSdk();
    const p = new CrazyGamesPlatform(hostFor(f.sdk));
    await p.init();
    const sm = new AppStateMachine('menu');
    bindPlatformLifecycle(sm, p);
    sm.go('playing');
    sm.go('error');
    expect(f.calls.slice(1)).toEqual(['gameplayStart', 'gameplayStop']);
  });
});

describe('storage', () => {
  const throwing = (): KeyValueStore => ({
    kind: 'broken',
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new DOMException('quota', 'QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  });

  it('persists through a working store', () => {
    const backing = new MemoryStore();
    const store = new SafeStore(backing);
    expect(store.set('k', 'v')).toBe(true);
    expect(store.persistent).toBe(true);
    expect(new SafeStore(backing).get('k')).toBe('v');
    store.remove('k');
    expect(backing.getItem('k')).toBeNull();
  });

  it('keeps working in memory, and says so, when storage is missing or throws', () => {
    for (const store of [new SafeStore(null), new SafeStore(throwing())]) {
      expect(store.set('k', 'v')).toBe(false);
      expect(store.persistent).toBe(false);
      expect(store.kind).toBe('memory');
      expect(store.get('k')).toBe('v');
      expect(() => store.remove('k')).not.toThrow();
      expect(store.get('k')).toBeNull();
    }
    const failed = new SafeStore(throwing());
    failed.set('k', 'v');
    expect(failed.lastError).toMatch(/quota/);
  });

  it('uses platform storage alone when it exists, so accounts never share browser storage', () => {
    const platform = new MemoryStore();
    const local = new MemoryStore();
    const store = resolveStore(platform, local);
    store.set('k', 'account-a');
    expect(platform.getItem('k')).toBe('account-a');
    expect(local.getItem('k')).toBeNull();
    expect(resolveStore(null, local).kind).toBe('memory');
    resolveStore(null, local).set('k', 'guest');
    expect(local.getItem('k')).toBe('guest');
  });
});

describe('settings persistence', () => {
  it('starts from defaults and round-trips a change', () => {
    const store = new SafeStore(new MemoryStore());
    const first = loadSettings(store);
    expect(first.status).toBe('fresh');
    expect(first.settings).toEqual(defaultSettings());
    const changed = { ...first.settings, sensitivity: 1.7, invertY: true, muted: true, quality: 'low' as const, fov: 104 };
    expect(saveSettings(store, changed)).toBe(true);
    const again = loadSettings(store);
    expect(again.status).toBe('loaded');
    expect(again.settings).toEqual(changed);
  });

  it.each([['{not json'], ['null'], ['[1,2]'], ['"text"'], ['']])('recovers from the corrupt save %j', (text) => {
    const store = new SafeStore(new MemoryStore());
    store.set(SETTINGS_KEY, text);
    const res = loadSettings(store);
    expect(res.status).toBe('recovered');
    expect(res.settings).toEqual(defaultSettings());
    expect(saveSettings(store, res.settings)).toBe(true);
    expect(loadSettings(store).status).toBe('loaded');
  });

  it('clamps out-of-range values and replaces wrongly typed ones', () => {
    const store = new SafeStore(new MemoryStore());
    store.set(
      SETTINGS_KEY,
      JSON.stringify({ version: SETTINGS_VERSION, sensitivity: 99, fov: -5, masterVolume: 'loud', quality: 'ultra', muted: 'yes', brightness: null, hudScale: NaN }),
    );
    const s = loadSettings(store).settings;
    expect(s).toMatchObject({ sensitivity: 3, fov: 75, masterVolume: 0.8, quality: 'medium', muted: false, brightness: 1, hudScale: 1 });
  });

  it('migrates an unversioned save and keeps what it can from a newer one', () => {
    const store = new SafeStore(new MemoryStore());
    store.set(SETTINGS_KEY, JSON.stringify({ volume: 0.25, invertY: true }));
    const old = loadSettings(store);
    expect(old.status).toBe('migrated');
    expect(old.settings).toMatchObject({ version: SETTINGS_VERSION, masterVolume: 0.25, invertY: true });

    store.set(SETTINGS_KEY, JSON.stringify({ version: SETTINGS_VERSION + 4, sensitivity: 2, futureField: { a: 1 }, quality: 'cinematic' }));
    const newer = loadSettings(store);
    expect(newer.status).toBe('newer');
    expect(newer.settings).toMatchObject({ sensitivity: 2, quality: 'medium' });
  });

  it('repairs bindings: drops reserved and duplicate keys and never leaves an action unbound', () => {
    const store = new SafeStore(new MemoryStore());
    store.set(
      SETTINGS_KEY,
      JSON.stringify({ version: 1, bindings: { forward: ['KeyZ'], jump: ['Escape'], crouch: ['ControlLeft'], reload: ['KeyZ'], fire: 'Mouse0', sprint: ['KeyW'] } }),
    );
    const b = loadSettings(store).settings.bindings;
    expect(b.forward).toEqual(['KeyZ']);
    expect(b.jump).toEqual(DEFAULT_BINDINGS.jump);
    expect(b.crouch).toEqual(DEFAULT_BINDINGS.crouch);
    expect(b.reload).toEqual(DEFAULT_BINDINGS.reload);
    expect(b.fire).toEqual(DEFAULT_BINDINGS.fire);
    expect(b.sprint).toEqual(['KeyW']);
    const all = Object.values(b).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(Object.values(b).every((codes) => codes.length > 0)).toBe(true);
  });

  it('reports when a save could not be written', () => {
    const store = new SafeStore(null);
    expect(saveSettings(store, defaultSettings())).toBe(false);
    expect(loadSettings(store).status).toBe('loaded');
  });
});

describe('key bindings', () => {
  it('refuses keys the browser or host page owns', () => {
    for (const code of ['Escape', 'ControlLeft', 'AltRight', 'MetaLeft', 'F5', 'F11', '']) expect(isBindable(code)).toBe(false);
    for (const code of ['KeyQ', 'Space', 'Mouse1', 'ShiftRight', 'Tab']) expect(isBindable(code)).toBe(true);
  });

  it('moves a key between actions without leaving either unbound', () => {
    const b = rebind(DEFAULT_BINDINGS, 'crouch', 'KeyR');
    expect(b.crouch[0]).toBe('KeyR');
    expect(b.reload).not.toContain('KeyR');
    expect(b.reload.length).toBeGreaterThan(0);
    expect(rebind(DEFAULT_BINDINGS, 'jump', 'Escape')).toEqual(DEFAULT_BINDINGS);
    expect(DEFAULT_BINDINGS.crouch).toEqual(['KeyC']);
  });

  it('labels keys for the player keyboard layout', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('KeyW', new Map([['KeyW', 'z']]))).toBe('Z');
    expect(keyLabel('Mouse0')).toBe('Left mouse');
    expect(keyLabel('ShiftLeft')).toBe('Shift');
  });
});
