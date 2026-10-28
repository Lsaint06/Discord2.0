import { describe, expect, it } from 'vitest'
import {
  checkLivekitUrl,
  checkServerUrl,
  connectSources,
  isPrivateHost,
  parseEndpoints
} from './endpoints'

describe('server addresses', () => {
  it('requires https for internet hosts and allows http only on private networks', () => {
    expect(checkServerUrl('https://myhome.duckdns.org').ok).toBe(true)
    expect(checkServerUrl('http://192.168.68.65:3001').ok).toBe(true)
    expect(checkServerUrl('http://localhost:3001').ok).toBe(true)
    expect(checkServerUrl('http://jetson.local:3001').ok).toBe(true)
    expect(checkServerUrl('http://100.101.1.2:3001').ok).toBe(true)
    for (const bad of [
      'http://myhome.duckdns.org',
      'http://50.35.80.10:3001',
      'ftp://192.168.68.65',
      'https://user:pw@myhome.duckdns.org',
      'https://myhome.duckdns.org/api',
      'https://myhome.duckdns.org/?x=1',
      'not a url'
    ]) {
      expect(checkServerUrl(bad).ok, bad).toBe(false)
    }
  })

  it('classifies hosts like the server does', () => {
    for (const h of [
      '10.0.0.1',
      '172.16.5.5',
      '192.168.1.1',
      '127.0.0.1',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'localhost',
      'nas.home.arpa',
      'jetson'
    ]) {
      expect(isPrivateHost(h), h).toBe(true)
    }
    for (const h of ['172.32.0.1', '100.128.0.1', '8.8.8.8', 'example.com', '2001:db8::1']) {
      expect(isPrivateHost(h), h).toBe(false)
    }
  })
})

describe('server profiles', () => {
  it('parses labelled servers, first one is the default, wss for https', () => {
    const r = parseEndpoints(
      'Friends|https://myhome.duckdns.org, Home network|http://192.168.68.65:3001'
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.endpoints.map((e) => [e.label, e.httpUrl, e.gatewayUrl, e.insecure])).toEqual([
      ['Friends', 'https://myhome.duckdns.org', 'wss://myhome.duckdns.org/gateway', false],
      ['Home network', 'http://192.168.68.65:3001', 'ws://192.168.68.65:3001/gateway', true]
    ])
  })

  it('falls back to the older single-server setting', () => {
    const r = parseEndpoints(undefined, 'http://localhost:3001')
    expect(r.ok && r.endpoints[0]?.httpUrl).toBe('http://localhost:3001')
  })

  it('rejects unsafe or malformed lists', () => {
    expect(parseEndpoints(undefined, undefined).ok).toBe(false)
    expect(parseEndpoints('Public|http://myhome.duckdns.org').ok).toBe(false)
    expect(parseEndpoints('no-bar-here').ok).toBe(false)
    expect(parseEndpoints('|https://a.example').ok).toBe(false)
    expect(parseEndpoints('A|https://a.example,B|https://a.example').ok).toBe(false)
    expect(
      parseEndpoints(Array.from({ length: 6 }, (_, i) => `S${i}|https://s${i}.example`).join(','))
        .ok
    ).toBe(false)
  })

  it('builds the CSP connect-src from the approved servers only', () => {
    const r = parseEndpoints('A|https://myhome.duckdns.org,B|http://192.168.68.65:3001')
    if (!r.ok) throw new Error(r.error)
    expect(connectSources(r.endpoints).split(' ').sort()).toEqual(
      [
        'http://192.168.68.65:*',
        'https://myhome.duckdns.org:*',
        'ws://192.168.68.65:*',
        'wss://myhome.duckdns.org:*'
      ].sort()
    )
  })
})

describe('voice server addresses from the server', () => {
  const publicEndpoint = { httpUrl: 'https://myhome.duckdns.org' }
  const lanEndpoint = { httpUrl: 'http://192.168.68.65:3001' }

  it('accepts the matching, encrypted voice server', () => {
    expect(checkLivekitUrl('wss://myhome.duckdns.org', publicEndpoint).ok).toBe(true)
    expect(checkLivekitUrl('ws://192.168.68.65:7880', lanEndpoint).ok).toBe(true)
    expect(checkLivekitUrl('wss://192.168.68.65', lanEndpoint).ok).toBe(true)
  })

  it('refuses other hosts, downgrades and non-WebSocket URLs', () => {
    expect(checkLivekitUrl('wss://evil.example', publicEndpoint).ok).toBe(false)
    expect(checkLivekitUrl('ws://myhome.duckdns.org', publicEndpoint).ok).toBe(false)
    expect(checkLivekitUrl('https://myhome.duckdns.org', publicEndpoint).ok).toBe(false)
    expect(checkLivekitUrl('garbage', publicEndpoint).ok).toBe(false)
    // A LAN profile doesn't accept the public name unless it's configured separately.
    expect(checkLivekitUrl('wss://myhome.duckdns.org', lanEndpoint).ok).toBe(false)
    expect(checkLivekitUrl('wss://voice.example', publicEndpoint, 'wss://voice.example').ok).toBe(
      true
    )
  })
})
