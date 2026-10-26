/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Discord 2.0 backend, e.g. http://192.168.68.65:3001. Public, not a secret. */
  readonly RENDERER_VITE_SERVER_URL?: string
  /** Only if LiveKit runs on a different host than the backend; used for the CSP. Public. */
  readonly RENDERER_VITE_LIVEKIT_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
