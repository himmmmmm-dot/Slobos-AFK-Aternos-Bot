import type { KeyValueStore } from '../persistence/storage';

export type PlatformEnvironment = 'crazygames' | 'local' | 'disabled' | 'none';
export type PlatformStatus = 'idle' | 'initializing' | 'ready' | 'unavailable';

/**
 * Everything the game is allowed to know about the host platform. No other module touches a
 * platform SDK. Calls are safe in every status: when the platform is unavailable they do nothing
 * and report that honestly through `status` and `unavailableReason`.
 */
export interface PlatformAdapter {
  readonly id: 'crazygames' | 'none';
  readonly status: PlatformStatus;
  readonly environment: PlatformEnvironment;
  readonly unavailableReason: string | null;
  /** Resolves when initialisation has finished either way. Never rejects; repeat calls share one attempt. */
  init(): Promise<void>;
  loadingStart(): void;
  loadingStop(): void;
  gameplayStart(): void;
  gameplayStop(): void;
  /** The platform asks for game audio to be off. Takes priority over the in-game volume settings. */
  readonly muteAudio: boolean;
  onMuteAudioChange(cb: (mute: boolean) => void): () => void;
  /** Platform save storage, when the platform provides it and it is enabled for this game. */
  readonly dataStore: KeyValueStore | null;
  readonly dataStoreReason: string | null;
}
