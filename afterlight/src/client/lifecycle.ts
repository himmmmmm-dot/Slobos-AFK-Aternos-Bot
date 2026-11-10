import { isGameplay, type AppStateMachine } from './appState';
import type { PlatformAdapter } from './platform/types';

/**
 * Derives platform lifecycle signals from application state, so there is exactly one place
 * that decides when loading and gameplay start and stop.
 */
export function bindPlatformLifecycle(sm: AppStateMachine, platform: PlatformAdapter): () => void {
  return sm.onChange((to, from) => {
    if (to === 'loading') platform.loadingStart();
    else if (from === 'loading') platform.loadingStop();
    if (isGameplay(to)) platform.gameplayStart();
    else if (isGameplay(from)) platform.gameplayStop();
  });
}
