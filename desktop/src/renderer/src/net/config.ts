export type ServerConfig =
  { ok: true; httpUrl: string; gatewayUrl: string } | { ok: false; error: string }

/**
 * The backend URL is injected at build time from RENDERER_VITE_SERVER_URL
 * (see desktop/.env.example). Nothing secret may ever be placed in renderer env vars:
 * they are embedded in the shipped JavaScript.
 */
export function resolveServerConfig(raw = import.meta.env.RENDERER_VITE_SERVER_URL): ServerConfig {
  if (!raw) {
    return {
      ok: false,
      error:
        'No server configured. Set RENDERER_VITE_SERVER_URL (for example in desktop/.env.development.local) and restart the app.'
    }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: `RENDERER_VITE_SERVER_URL is not a valid URL: ${raw}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'RENDERER_VITE_SERVER_URL must start with http:// or https://' }
  }
  const httpUrl = url.origin
  const gatewayUrl = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/gateway`
  return { ok: true, httpUrl, gatewayUrl }
}

export const serverConfig = resolveServerConfig()
