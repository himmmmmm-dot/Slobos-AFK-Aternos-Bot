import type { KeyValueStore } from '../persistence/storage';
import type { PlatformAdapter, PlatformEnvironment, PlatformStatus } from './types';

/** HTML5 SDK v3, the integration channel documented at https://docs.crazygames.com/sdk/intro/ (checked 2026-11-10). */
export const CRAZYGAMES_SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';

interface CrazyGameSettings {
  muteAudio?: boolean;
  disableChat?: boolean;
}

/** The documented subset of window.CrazyGames.SDK that this game calls. Nothing here is invented. */
export interface CrazySdk {
  init(): Promise<void>;
  environment: string;
  game: {
    gameplayStart(): void;
    gameplayStop(): void;
    loadingStart(): void;
    loadingStop(): void;
    settings: CrazyGameSettings;
    addSettingsChangeListener(listener: (settings: CrazyGameSettings) => void): void;
    removeSettingsChangeListener(listener: (settings: CrazyGameSettings) => void): void;
  };
  data: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
}

/** Seam for tests: how the adapter reaches the SDK global and loads its script. */
export interface CrazyHost {
  sdk(): CrazySdk | undefined;
  loadScript(url: string): Promise<void>;
}

export function browserHost(): CrazyHost {
  return {
    sdk: () => (window as unknown as { CrazyGames?: { SDK?: CrazySdk } }).CrazyGames?.SDK,
    loadScript: (url) =>
      new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('the SDK script could not be loaded (blocked, offline or filtered)'));
        document.head.appendChild(s);
      }),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** SDK v3 errors are `{ code, message }` objects rather than Error instances. */
function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; message?: unknown };
    if (o.code || o.message) return [o.code, o.message].filter(Boolean).join(': ');
  }
  return String(e);
}

export class CrazyGamesPlatform implements PlatformAdapter {
  readonly id = 'crazygames' as const;
  status: PlatformStatus = 'idle';
  environment: PlatformEnvironment = 'none';
  unavailableReason: string | null = null;
  muteAudio = false;
  dataStore: KeyValueStore | null = null;
  dataStoreReason: string | null = null;

  private sdk: CrazySdk | null = null;
  private initPromise: Promise<void> | null = null;
  private loading = false;
  private gameplay = false;
  private muteListeners = new Set<(mute: boolean) => void>();

  constructor(
    private readonly host: CrazyHost = browserHost(),
    private readonly timeoutMs = 8000,
  ) {}

  init(): Promise<void> {
    return (this.initPromise ??= this.doInit());
  }

  private async doInit(): Promise<void> {
    this.status = 'initializing';
    try {
      if (!this.host.sdk()) await withTimeout(this.host.loadScript(CRAZYGAMES_SDK_URL), this.timeoutMs, 'loading the SDK script');
      const sdk = this.host.sdk();
      if (!sdk) throw new Error('the SDK script loaded but window.CrazyGames.SDK is missing');
      await withTimeout(sdk.init(), this.timeoutMs, 'SDK init');
      const env = sdk.environment;
      this.environment = env === 'crazygames' || env === 'local' ? env : 'disabled';
      // On any other domain the SDK is disabled and its methods throw, so treat it as absent.
      if (this.environment === 'disabled') throw new Error(`the SDK reports environment "${env}" on this domain`);
      this.muteAudio = sdk.game.settings?.muteAudio === true;
      sdk.game.addSettingsChangeListener(this.onSettings);
      this.sdk = sdk;
      this.status = 'ready';
      this.probeData(sdk);
    } catch (e) {
      this.sdk = null;
      this.status = 'unavailable';
      this.unavailableReason = `CrazyGames SDK unavailable: ${describe(e)}`;
    }
  }

  /** The data module throws `dataModuleDisabled` unless Progress Save is enabled for the submission. */
  private probeData(sdk: CrazySdk): void {
    try {
      sdk.data.getItem('afterlight.probe');
      this.dataStore = {
        kind: 'crazygames-data',
        getItem: (k) => sdk.data.getItem(k),
        setItem: (k, v) => sdk.data.setItem(k, v),
        removeItem: (k) => sdk.data.removeItem(k),
      };
    } catch (e) {
      this.dataStoreReason = `CrazyGames data module unavailable: ${describe(e)}`;
    }
  }

  private onSettings = (settings: CrazyGameSettings): void => {
    const mute = settings?.muteAudio === true;
    if (mute === this.muteAudio) return;
    this.muteAudio = mute;
    for (const l of this.muteListeners) l(mute);
  };

  private send(what: string, fn: (sdk: CrazySdk) => void): boolean {
    if (!this.sdk) return false;
    try {
      fn(this.sdk);
      return true;
    } catch (e) {
      console.warn(`[platform] ${what} failed: ${describe(e)}`);
      return false;
    }
  }

  // Each signal is sent once per real transition; repeats and unmatched stops are dropped.
  loadingStart(): void {
    if (!this.loading) this.loading = this.send('loadingStart', (s) => s.game.loadingStart());
  }

  loadingStop(): void {
    if (!this.loading) return;
    this.loading = false;
    this.send('loadingStop', (s) => s.game.loadingStop());
  }

  gameplayStart(): void {
    if (!this.gameplay) this.gameplay = this.send('gameplayStart', (s) => s.game.gameplayStart());
  }

  gameplayStop(): void {
    if (!this.gameplay) return;
    this.gameplay = false;
    this.send('gameplayStop', (s) => s.game.gameplayStop());
  }

  onMuteAudioChange(cb: (mute: boolean) => void): () => void {
    this.muteListeners.add(cb);
    return () => this.muteListeners.delete(cb);
  }
}
