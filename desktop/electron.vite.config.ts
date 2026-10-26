import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import { loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Builds the Content-Security-Policy `connect-src` list so the renderer may only talk to the
 * configured backend host (HTTP + WebSocket, any port — the self-hosted LiveKit SFU runs on the
 * same machine, e.g. :7880) plus an optional separate LiveKit host.
 */
function connectSources(serverUrl: string | undefined, livekitUrl: string | undefined): string {
  const sources = new Set<string>()
  for (const raw of [serverUrl, livekitUrl]) {
    if (!raw) continue
    try {
      const url = new URL(raw)
      const secure = url.protocol === 'https:' || url.protocol === 'wss:'
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) continue
      sources.add(`${secure ? 'https' : 'http'}://${url.hostname}:*`)
      sources.add(`${secure ? 'wss' : 'ws'}://${url.hostname}:*`)
    } catch {
      // Ignore malformed values; the app reports configuration errors at runtime.
    }
  }
  return [...sources].join(' ')
}

function cspPlugin(serverUrl: string | undefined, livekitUrl: string | undefined): Plugin {
  return {
    name: 'd2-csp-connect-src',
    transformIndexHtml(html) {
      return html.replace('__D2_CONNECT_SRC__', connectSources(serverUrl, livekitUrl))
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'RENDERER_VITE_')

  return {
    main: {},
    preload: {},
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src')
        }
      },
      plugins: [react(), cspPlugin(env.RENDERER_VITE_SERVER_URL, env.RENDERER_VITE_LIVEKIT_URL)]
    }
  }
})
