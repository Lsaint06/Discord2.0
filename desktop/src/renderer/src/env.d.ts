/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Discord 2.0 backend, e.g. http://192.168.1.50:3001. Public, not a secret. */
  readonly RENDERER_VITE_SERVER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
