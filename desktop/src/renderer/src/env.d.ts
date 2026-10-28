/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "Label|URL, Label|URL": approved servers (see net/endpoints.ts). */
  readonly RENDERER_VITE_SERVERS?: string
  /** Older single-server setting, still accepted. */
  readonly RENDERER_VITE_SERVER_URL?: string
  /** Only if LiveKit runs on a different host than the backend; used for the CSP. Public. */
  readonly RENDERER_VITE_LIVEKIT_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
