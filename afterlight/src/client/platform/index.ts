import { CrazyGamesPlatform } from './crazygames';
import type { PlatformAdapter } from './types';

/** Used when the build targets no platform. It reports itself as unavailable rather than faking success. */
export class NullPlatform implements PlatformAdapter {
  readonly id = 'none' as const;
  readonly status = 'unavailable' as const;
  readonly environment = 'none' as const;
  readonly unavailableReason = 'This build has no platform SDK (VITE_PLATFORM=none). Ads, accounts and cloud saves are off.';
  readonly muteAudio = false;
  readonly dataStore = null;
  readonly dataStoreReason = 'No platform SDK in this build.';

  async init(): Promise<void> {}
  loadingStart(): void {}
  loadingStop(): void {}
  gameplayStart(): void {}
  gameplayStop(): void {}
  onMuteAudioChange(): () => void {
    return () => {};
  }
}

export function createPlatform(): PlatformAdapter {
  return import.meta.env.VITE_PLATFORM === 'crazygames' ? new CrazyGamesPlatform() : new NullPlatform();
}
