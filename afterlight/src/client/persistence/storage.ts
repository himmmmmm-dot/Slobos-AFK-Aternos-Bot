export interface KeyValueStore {
  readonly kind: string;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStore implements KeyValueStore {
  readonly kind = 'memory';
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** localStorage when it works. Embedded frames and private modes can throw on any access. */
export function browserStore(): KeyValueStore | null {
  try {
    const ls = window.localStorage;
    const probe = 'afterlight.probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return {
      kind: 'localStorage',
      getItem: (k) => ls.getItem(k),
      setItem: (k, v) => ls.setItem(k, v),
      removeItem: (k) => ls.removeItem(k),
    };
  } catch {
    return null;
  }
}

/**
 * Wraps one backing store so callers never see an exception. When the store is missing or starts
 * failing, values are kept in memory for the session and `persistent` turns false so the UI can say so.
 */
export class SafeStore {
  private readonly memory = new MemoryStore();
  private failed = false;
  lastError: string | null = null;

  constructor(private readonly primary: KeyValueStore | null) {}

  get persistent(): boolean {
    return this.primary !== null && !this.failed;
  }

  get kind(): string {
    return this.persistent ? this.primary!.kind : 'memory';
  }

  get(key: string): string | null {
    if (this.primary && !this.failed) {
      try {
        return this.primary.getItem(key);
      } catch (e) {
        this.fail(e);
      }
    }
    return this.memory.getItem(key);
  }

  /** Returns true only when the value reached persistent storage. */
  set(key: string, value: string): boolean {
    this.memory.setItem(key, value);
    if (!this.primary || this.failed) return false;
    try {
      this.primary.setItem(key, value);
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  remove(key: string): void {
    this.memory.removeItem(key);
    if (!this.primary || this.failed) return;
    try {
      this.primary.removeItem(key);
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    this.failed = true;
    const o = e as { code?: string; message?: string } | null;
    this.lastError = (o && (o.message || o.code)) || String(e);
  }
}

/**
 * Chooses where saves live. On a platform with its own save storage that store is used alone, so
 * one account's data is never mirrored into browser storage that another account could read.
 */
export function resolveStore(platformStore: KeyValueStore | null, local: KeyValueStore | null): SafeStore {
  return new SafeStore(platformStore ?? local);
}
