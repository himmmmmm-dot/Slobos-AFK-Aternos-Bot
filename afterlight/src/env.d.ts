/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "crazygames" or "none". Public: compiled into the client bundle. */
  readonly VITE_PLATFORM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
