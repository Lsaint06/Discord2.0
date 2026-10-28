/**
 * Milestone 11 tests: remote-access configuration and hardening — private-host rules, production
 * guards (DEV_AUTH, TRUST_PROXY, null origin), the packaged app's origin, X-Forwarded-For only
 * from trusted proxies (checked through the real sign-in rate limiter), WebSocket origin checks,
 * and the LiveKit signaling URL chosen per request (LAN vs public).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import WebSocket from 'ws'
import { buildApp } from '../src/app.js'
import { HashGate, OWASP_MINIMUM, PasswordHasher } from '../src/auth/password.js'
import { APP_ORIGIN, isOriginAllowed, livekitUrlFor, loadConfig } from '../src/config.js'
import { seedIfEmpty } from '../src/db/seed.js'
import { SqliteRepository } from '../src/db/sqlite.js'
import { hostnameOf, isPrivateHost } from '../src/lib/network.js'

const SCHEME = ['Bea', 'rer'].join('')
const HASHER = new PasswordHasher(OWASP_MINIMUM, new HashGate(4, 64))
const PASSWORD = 'violet-anchor-sunrise-42'
const SECRET = 'x'.repeat(40)
const dir = mkdtempSync(join(tmpdir(), 'd2-remote-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const prodEnv = (extra: Record<string, string> = {}) => ({
  NODE_ENV: 'production',
  DEV_AUTH: 'false',
  LOG_LEVEL: 'silent',
  DATABASE_URL: `sqlite:${join(dir, 'unused.db')}`,
  ...extra
})

describe('private hosts', () => {
  test('recognises private, LAN-only and public hosts', () => {
    for (const h of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.68.65', '100.101.102.103', '169.254.1.1', '::1', 'fd12::1', 'fe80::1', '[::1]', 'localhost', 'jetson', 'jetson.local', 'nas.home.arpa']) {
      assert.equal(isPrivateHost(h), true, h)
    }
    for (const h of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '50.35.80.1', '2001:db8::1', 'example.org', 'name.duckdns.org', '']) {
      assert.equal(isPrivateHost(h), false, h)
    }
    assert.equal(hostnameOf('chat.example.org:443'), 'chat.example.org')
    assert.equal(hostnameOf('[::1]:3001'), '::1')
    assert.equal(hostnameOf('192.168.68.65:3001'), '192.168.68.65')
    assert.equal(hostnameOf(undefined), null)
  })
})

describe('production configuration guards', () => {
  test('DEV_AUTH=true is refused in production unless explicitly overridden', () => {
    assert.throws(() => loadConfig(prodEnv({ DEV_AUTH: 'true' })), /DEV_AUTH=true is refused in production/)
    assert.equal(loadConfig(prodEnv()).devAuth, false)
    // A missing DEV_AUTH line means "off" in production.
    const { DEV_AUTH: _omit, ...withoutDevAuth } = prodEnv()
    assert.equal(loadConfig(withoutDevAuth).devAuth, false)
    assert.equal(loadConfig(prodEnv({ DEV_AUTH: 'true', ALLOW_DEV_AUTH_IN_PRODUCTION: 'true' })).devAuth, true)
  })

  test('TRUST_PROXY must name specific proxies in production', () => {
    assert.throws(() => loadConfig(prodEnv({ TRUST_PROXY: 'true' })), /not allowed in production/)
    assert.throws(() => loadConfig(prodEnv({ TRUST_PROXY: 'not-an-ip' })), /not an IP address/)
    assert.throws(() => loadConfig(prodEnv({ TRUST_PROXY: '0.0.0.0/0' })), /every address/)
    assert.throws(() => loadConfig(prodEnv({ TRUST_PROXY: '10.0.0.0/33' })), /not an IP address/)
    assert.equal(loadConfig(prodEnv()).trustProxy, false)
    assert.deepEqual(loadConfig(prodEnv({ TRUST_PROXY: '172.30.0.10, 10.0.0.0/8,loopback' })).trustProxy, [
      '172.30.0.10',
      '10.0.0.0/8',
      'loopback'
    ])
    // Development keeps a convenience: "true" means "a proxy on this machine".
    assert.deepEqual(loadConfig({ NODE_ENV: 'development', TRUST_PROXY: 'true' }).trustProxy, ['loopback'])
  })

  test('origin policy: the packaged app is allowed, "null" only outside production or when opted in', () => {
    const prod = loadConfig(prodEnv())
    assert.equal(isOriginAllowed(prod, APP_ORIGIN), true)
    assert.equal(isOriginAllowed(prod, undefined), true, 'non-browser clients send no Origin')
    assert.equal(isOriginAllowed(prod, 'null'), false)
    assert.equal(isOriginAllowed(prod, 'https://evil.example'), false)
    assert.equal(isOriginAllowed(prod, 'app://discord2.evil'), false)
    assert.equal(isOriginAllowed(prod, 'http://localhost:5173'), false)
    assert.equal(isOriginAllowed(loadConfig(prodEnv({ ALLOW_NULL_ORIGIN: 'true' })), 'null'), true)
    assert.equal(isOriginAllowed(loadConfig({ NODE_ENV: 'development' }), 'null'), true)
    assert.equal(isOriginAllowed(loadConfig(prodEnv({ ALLOW_APP_ORIGIN: 'false' })), APP_ORIGIN), false)
  })

  test('LiveKit signaling must be encrypted for public hosts; the LAN URL must be private', () => {
    const lk = (pub: string, lan?: string) =>
      loadConfig({
        NODE_ENV: 'test',
        LIVEKIT_API_KEY: 'key',
        LIVEKIT_API_SECRET: SECRET,
        LIVEKIT_URL: 'http://livekit:7880',
        LIVEKIT_PUBLIC_URL: pub,
        ...(lan ? { LIVEKIT_LAN_URL: lan } : {})
      }).livekit
    assert.throws(() => lk('ws://name.duckdns.org'), /must use wss:\/\//)
    assert.throws(() => lk('ws://50.35.80.1:7880'), /must use wss:\/\//)
    assert.equal(lk('wss://name.duckdns.org/ignored-path')?.publicUrl, 'wss://name.duckdns.org')
    assert.equal(lk('ws://192.168.68.65:7880')?.publicUrl, 'ws://192.168.68.65:7880')
    assert.throws(() => lk('wss://name.duckdns.org', 'ws://name.duckdns.org:7880'), /private address/)
    assert.throws(() => lk('wss://name.duckdns.org', 'http://192.168.68.65:7880'), /private address/)
    const both = lk('wss://name.duckdns.org', 'ws://192.168.68.65:7880')!
    assert.equal(both.lanUrl, 'ws://192.168.68.65:7880')
    assert.equal(livekitUrlFor(both, '192.168.68.65'), 'ws://192.168.68.65:7880')
    assert.equal(livekitUrlFor(both, 'name.duckdns.org'), 'wss://name.duckdns.org')
    assert.equal(livekitUrlFor(both, null), 'wss://name.duckdns.org')
    const publicOnly = lk('wss://name.duckdns.org')!
    assert.equal(livekitUrlFor(publicOnly, '192.168.68.65'), 'wss://name.duckdns.org')
  })
})

async function prodApp(extra: Record<string, string>, file: string) {
  const repo = new SqliteRepository(join(dir, file))
  await repo.migrate()
  await seedIfEmpty(repo)
  const config = loadConfig(prodEnv({ ATTACHMENTS_DIR: join(dir, `${file}-att`), ...extra }))
  const { app } = await buildApp(config, repo, {
    logger: false,
    hasher: HASHER,
    voiceReconcileIntervalMs: 0,
    attachmentCleanupIntervalMs: 0,
    statusExpiryIntervalMs: 0
  })
  return { app, repo }
}

describe('behind a reverse proxy', () => {
  test('browser origins: the app and native clients pass, null and foreign sites are refused (REST and WebSocket)', async () => {
    const { app, repo } = await prodApp({}, 'origin.db')
    try {
      const appRes = await app.inject({ url: '/api/meta', headers: { origin: APP_ORIGIN } })
      assert.equal(appRes.statusCode, 200)
      assert.equal(appRes.headers['access-control-allow-origin'], APP_ORIGIN)
      assert.equal((await app.inject({ url: '/api/meta' })).statusCode, 200)
      assert.equal((await app.inject({ url: '/api/meta', headers: { origin: 'null' } })).statusCode, 403)
      assert.equal((await app.inject({ url: '/api/meta', headers: { origin: 'https://evil.example' } })).statusCode, 403)

      await app.listen({ host: '127.0.0.1', port: 0 })
      const port = (app.server.address() as { port: number }).port
      const handshake = (origin?: string) =>
        new Promise<number>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway`, origin ? { origin } : {})
          // Wait for the closing handshake so the server can shut down cleanly afterwards.
          ws.on('open', () => {
            ws.on('close', () => resolve(101))
            ws.close()
          })
          // A refused upgrade is a plain HTTP response: read it and drop the connection.
          ws.on('unexpected-response', (req, res) => {
            const status = res.statusCode ?? 0
            res.resume()
            req.destroy()
            resolve(status)
          })
          ws.on('error', () => undefined)
        })
      assert.equal(await handshake(APP_ORIGIN), 101)
      assert.equal(await handshake(), 101)
      assert.equal(await handshake('null'), 403)
      assert.equal(await handshake('file://'), 403)
      assert.equal(await handshake('https://evil.example'), 403)

      // A client that never hangs up after a refused upgrade must not keep a server socket open.
      const held: unknown[] = []
      for (const [path, origin] of [['/gateway', 'null'], ['/gateway', 'https://evil.example'], ['/missing', undefined]] as const) {
        await new Promise<void>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {})
          ws.on('unexpected-response', (_req, res) => {
            held.push(res)
            resolve()
          })
          ws.on('error', () => resolve())
        })
      }
      assert.equal(held.length, 3)
      await new Promise((r) => setTimeout(r, 1200))
      const open = await new Promise<number>((r) => app.server.getConnections((_e, n) => r(n)))
      assert.equal(open, 0, 'refused upgrade sockets are closed by the server')
    } finally {
      await app.close()
      await repo.close()
    }
  })

  test('X-Forwarded-For is believed only from the configured proxy (per-IP sign-in limit)', async () => {
    const { app, repo } = await prodApp({ TRUST_PROXY: '172.30.0.10' }, 'proxy.db')
    // A different username each time, so only the per-IP limit (10) is exercised, not the
    // per-account one (5).
    let n = 0
    const login = (remoteAddress: string, forwarded?: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress,
        headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
        payload: { username: `nobody${n++}`, password: 'wrong-password-123' }
      })
    try {
      // Through the proxy: each real client has its own budget (10 attempts).
      for (let i = 0; i < 10; i++) assert.notEqual((await login('172.30.0.10', '203.0.113.5')).statusCode, 429)
      assert.equal((await login('172.30.0.10', '203.0.113.5')).statusCode, 429, 'the same client is limited')
      assert.notEqual((await login('172.30.0.10', '198.51.100.7')).statusCode, 429, 'another client behind the proxy is not')
      // Not the proxy: a forged header is ignored, so rotating it doesn't escape the limit.
      for (let i = 0; i < 10; i++) assert.notEqual((await login('192.0.2.9', `10.0.0.${i}`)).statusCode, 429)
      assert.equal((await login('192.0.2.9', '10.0.0.99')).statusCode, 429)
    } finally {
      await app.close()
      await repo.close()
    }
  })

  test('voice tokens carry the LAN or the public signaling URL depending on how the client came in', async () => {
    const { app, repo } = await prodApp(
      {
        LIVEKIT_API_KEY: 'key',
        LIVEKIT_API_SECRET: SECRET,
        LIVEKIT_URL: 'http://127.0.0.1:1',
        LIVEKIT_PUBLIC_URL: 'wss://name.duckdns.org',
        LIVEKIT_LAN_URL: 'ws://192.168.68.65:7880'
      },
      'voice.db'
    )
    try {
      const now = Date.now()
      const user = await repo.provisionAccount(
        { id: 'v-1', username: 'voicer', displayName: 'Voicer', avatarColor: '#123456', bot: false, createdAt: now },
        await HASHER.hash(PASSWORD),
        now
      )
      await repo.setOwner('hangout', user.id, now)
      const auth = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'voicer', password: PASSWORD } })
      const token = (JSON.parse(auth.body) as { token: string }).token
      const channel = (await repo.listChannels()).find((c) => c.serverId === 'hangout' && c.type === 'voice')!
      const grant = async (host: string) =>
        JSON.parse(
          (
            await app.inject({
              method: 'POST',
              url: `/api/voice/channels/${channel.id}/token`,
              headers: { host, authorization: `${SCHEME} ${token}` }
            })
          ).body
        ) as { url: string; token: string; expiresAt: number }
      const lan = await grant('192.168.68.65:3001')
      assert.equal(lan.url, 'ws://192.168.68.65:7880')
      const remote = await grant('name.duckdns.org')
      assert.equal(remote.url, 'wss://name.duckdns.org')
      // Short-lived and never containing the API secret.
      assert.ok(remote.expiresAt - Date.now() <= 5 * 60_000 + 1000)
      assert.ok(!JSON.stringify(remote).includes(SECRET))
    } finally {
      await app.close()
      await repo.close()
    }
  })
})
