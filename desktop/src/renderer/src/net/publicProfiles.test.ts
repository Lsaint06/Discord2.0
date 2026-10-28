import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkLivekitUrl, connectSources, parseEndpoints } from './endpoints'
import { classifyNetError, describeConnectionFailure } from './networkErrors'

const INTERNET = 'https://landhoev3.duckdns.org'
const HOME = 'http://192.168.68.65:3001'

/** The profiles compiled into release builds (desktop/.env.production). */
function releaseServers(): string {
  const file = readFileSync(join(__dirname, '../../../../.env.production'), 'utf8')
  const line = file.split(/\r?\n/).find((l) => l.startsWith('RENDERER_VITE_SERVERS='))
  if (!line) throw new Error('RENDERER_VITE_SERVERS missing from .env.production')
  return line.slice('RENDERER_VITE_SERVERS='.length)
}

describe('release server profiles', () => {
  const parsed = parseEndpoints(releaseServers())
  if (!parsed.ok) throw new Error(parsed.error)
  const [internet, home] = parsed.endpoints

  it('offers Internet first (the default for new installs) and Home Network second', () => {
    expect(parsed.endpoints).toHaveLength(2)
    expect(internet).toMatchObject({
      id: INTERNET,
      label: 'Discord 2.0 — Internet',
      insecure: false
    })
    expect(home).toMatchObject({ id: HOME, label: 'Discord 2.0 — Home Network', insecure: true })
  })

  it('uses wss:// for the internet profile and keeps ws:// on the LAN', () => {
    expect(internet!.gatewayUrl).toBe('wss://landhoev3.duckdns.org/gateway')
    expect(home!.gatewayUrl).toBe('ws://192.168.68.65:3001/gateway')
  })

  it('allows only those servers in the CSP (no plain http/ws to the internet host)', () => {
    const csp = connectSources(parsed.endpoints)
    expect(csp.split(' ').sort()).toEqual(
      [
        'https://landhoev3.duckdns.org:*',
        'wss://landhoev3.duckdns.org:*',
        'http://192.168.68.65:*',
        'ws://192.168.68.65:*'
      ].sort()
    )
  })

  it('accepts exactly the voice addresses the server hands out for each profile', () => {
    expect(checkLivekitUrl('wss://landhoev3.duckdns.org', internet!).ok).toBe(true)
    expect(checkLivekitUrl('ws://192.168.68.65:7880', home!).ok).toBe(true)
    // A downgrade or a foreign host is refused.
    expect(checkLivekitUrl('ws://landhoev3.duckdns.org', internet!).ok).toBe(false)
    expect(checkLivekitUrl('ws://192.168.68.65:7880', internet!).ok).toBe(false)
    expect(checkLivekitUrl('wss://evil.example', internet!).ok).toBe(false)
  })
})

describe('starting profile and existing sign-ins', () => {
  afterEach(() => vi.unstubAllGlobals())

  const stubStorage = (initial: Record<string, string> = {}): void => {
    const store = new Map(Object.entries(initial))
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    })
  }

  it('new installs start on Internet; a saved LAN sign-in reopens on Home Network', async () => {
    const { initialEndpoint } = await import('./config')
    const parsed = parseEndpoints(releaseServers())
    if (!parsed.ok) throw new Error(parsed.error)
    stubStorage()
    expect(initialEndpoint(parsed.endpoints, null).id).toBe(INTERNET)
    // A 1.0/1.1 user signed in on the LAN: the session (and its server) is kept, not switched.
    expect(initialEndpoint(parsed.endpoints, HOME).id).toBe(HOME)
    // A remembered choice is honoured when there's no saved session.
    stubStorage({ 'd2.endpoint': HOME })
    expect(initialEndpoint(parsed.endpoints, null).id).toBe(HOME)
    // A saved session for a server that's no longer built in falls back to the default.
    expect(initialEndpoint(parsed.endpoints, 'http://10.0.0.5:3001').id).toBe(HOME)
    stubStorage()
    expect(initialEndpoint(parsed.endpoints, 'http://10.0.0.5:3001').id).toBe(INTERNET)
  })
})

describe('connection failure messages', () => {
  const servers = [
    { id: INTERNET, label: 'Discord 2.0 — Internet', insecure: false },
    { id: HOME, label: 'Discord 2.0 — Home Network', insecure: true }
  ]

  it('classifies Chromium error codes', () => {
    expect(classifyNetError('ERR_CERT_DATE_INVALID')).toBe('certificate')
    expect(classifyNetError('ERR_CERT_AUTHORITY_INVALID')).toBe('certificate')
    expect(classifyNetError('ERR_SSL_PROTOCOL_ERROR')).toBe('certificate')
    expect(classifyNetError('ERR_NAME_NOT_RESOLVED')).toBe('dns')
    expect(classifyNetError('ERR_INTERNET_DISCONNECTED')).toBe('offline')
    expect(classifyNetError('ERR_CONNECTION_REFUSED')).toBe('refused')
    expect(classifyNetError('ERR_CONNECTION_TIMED_OUT')).toBe('timeout')
    expect(classifyNetError('ERR_ADDRESS_UNREACHABLE')).toBe('timeout')
    expect(classifyNetError(null)).toBe('unknown')
    expect(classifyNetError('ERR_SOMETHING_NEW')).toBe('unknown')
  })

  it('explains certificate failures without offering a way around them', () => {
    const text = describeConnectionFailure('ERR_CERT_DATE_INVALID', INTERNET, servers)
    expect(text).toMatch(/certificate could not be verified \(ERR_CERT_DATE_INVALID\)/)
    expect(text).toMatch(/date and time/)
    expect(text).not.toMatch(/ignore|continue anyway|proceed/i)
  })

  it('suggests the Internet option when the home-network option fails away from home', () => {
    const text = describeConnectionFailure('ERR_CONNECTION_TIMED_OUT', HOME, servers)
    expect(text).toMatch(/didn't respond/)
    expect(text).toMatch(/"Discord 2\.0 — Home Network" only works on your home network/)
    expect(text).toMatch(/choose "Discord 2\.0 — Internet" in Connection settings/)
    // Plain language: no addresses on the sign-in screen.
    expect(text).not.toMatch(/192\.168|https?:|duckdns/)
  })

  it('gives internet-specific advice for the Internet option', () => {
    expect(describeConnectionFailure('ERR_NAME_NOT_RESOLVED', INTERNET, servers)).toBe(
      "Can't find the Discord 2.0 server. Check your internet connection."
    )
    expect(describeConnectionFailure('ERR_INTERNET_DISCONNECTED', INTERNET, servers)).toMatch(
      /offline/
    )
    expect(describeConnectionFailure('ERR_CONNECTION_REFUSED', INTERNET, servers)).toMatch(
      /isn't accepting connections/
    )
    expect(describeConnectionFailure(null, INTERNET, servers)).toBe(
      "Can't reach the Discord 2.0 server."
    )
  })
})
