import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import { loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Builds the Content-Security-Policy `connect-src` list from RENDERER_VITE_SERVER_URL so the
 * renderer may talk to exactly one configured backend (HTTP + WebSocket) and nothing else.
 */
function connectSources(serverUrl: string | undefined): string {
  if (!serverUrl) return ''
  try {
    const url = new URL(serverUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    const ws = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`
    return `${url.origin} ${ws}`
  } catch {
    return ''
  }
}

function cspPlugin(serverUrl: string | undefined): Plugin {
  return {
    name: 'd2-csp-connect-src',
    transformIndexHtml(html) {
      return html.replace('__D2_CONNECT_SRC__', connectSources(serverUrl))
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
      plugins: [react(), cspPlugin(env.RENDERER_VITE_SERVER_URL)]
    }
  }
})
