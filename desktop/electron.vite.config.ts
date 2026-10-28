import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import { loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { connectSources, parseEndpoints } from './src/renderer/src/net/endpoints'

/**
 * Builds the Content-Security-Policy `connect-src` list so the renderer may only talk to the
 * approved servers (HTTP + WebSocket, any port: the self-hosted LiveKit SFU runs on the same
 * machine) plus an optional separate LiveKit host. An invalid server list fails the build, so a
 * public server can never be shipped with plain http://.
 */
function cspPlugin(env: Record<string, string>): Plugin {
  const configured = Boolean(env.RENDERER_VITE_SERVERS || env.RENDERER_VITE_SERVER_URL)
  const parsed = parseEndpoints(env.RENDERER_VITE_SERVERS, env.RENDERER_VITE_SERVER_URL)
  if (configured && !parsed.ok) throw new Error(`Invalid server configuration: ${parsed.error}`)
  const sources = parsed.ok ? connectSources(parsed.endpoints, env.RENDERER_VITE_LIVEKIT_URL) : ''
  return {
    name: 'd2-csp-connect-src',
    transformIndexHtml(html) {
      return html.replace('__D2_CONNECT_SRC__', sources)
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'RENDERER_VITE_')
  // The main process only downloads attachments from these exact origins (never elsewhere
  // with the session token, even if asked by a compromised renderer).
  const parsed = parseEndpoints(env.RENDERER_VITE_SERVERS, env.RENDERER_VITE_SERVER_URL)
  const serverOrigins = parsed.ok ? parsed.endpoints.map((e) => new URL(e.httpUrl).origin) : []

  return {
    main: {
      define: { __D2_SERVER_ORIGINS__: JSON.stringify(serverOrigins) }
    },
    preload: {},
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src')
        }
      },
      plugins: [react(), cspPlugin(env)]
    }
  }
})
