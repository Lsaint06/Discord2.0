import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkLivekitUrl, connectSources, parseEndpoints } from './endpoints'

/** The profile compiled into staging test builds (desktop/.env.staging, `--mode staging`). */
function stagingServers(): string {
  const file = readFileSync(join(__dirname, '../../../../.env.staging'), 'utf8')
  const line = file.split(/\r?\n/).find((l) => l.startsWith('RENDERER_VITE_SERVERS='))
  if (!line) throw new Error('RENDERER_VITE_SERVERS missing from .env.staging')
  return line.slice('RENDERER_VITE_SERVERS='.length)
}

describe('staging server profile (two PCs on the home LAN)', () => {
  const parsed = parseEndpoints(stagingServers())
  if (!parsed.ok) throw new Error(parsed.error)
  const [staging] = parsed.endpoints

  it('has exactly the staging backend on the Jetson LAN address, port 3901', () => {
    expect(parsed.endpoints).toHaveLength(1)
    expect(staging).toMatchObject({ id: 'http://192.168.68.65:3901', insecure: true })
    expect(staging!.gatewayUrl).toBe('ws://192.168.68.65:3901/gateway')
  })

  it('CSP allows the staging backend and its LiveKit (7980) on the LAN host only', () => {
    expect(connectSources(parsed.endpoints).split(' ').sort()).toEqual([
      'http://192.168.68.65:*',
      'ws://192.168.68.65:*'
    ])
  })

  it('accepts the voice address the staging server hands out, and nothing public', () => {
    expect(checkLivekitUrl('ws://192.168.68.65:7980', staging!).ok).toBe(true)
    expect(checkLivekitUrl('wss://landhoev3.duckdns.org', staging!).ok).toBe(false)
    expect(checkLivekitUrl('ws://192.168.1.50:7980', staging!).ok).toBe(false)
  })
})
