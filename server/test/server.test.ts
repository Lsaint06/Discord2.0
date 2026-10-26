import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { seedIfEmpty } from '../src/db/seed.js'
import { SqliteRepository } from '../src/db/sqlite.js'
import type { ApiMessage, GatewayServerFrame } from '../src/protocol.js'

const dir = mkdtempSync(join(tmpdir(), 'd2-test-'))
const dbFile = join(dir, 'test.db')
const config = loadConfig({ NODE_ENV: 'test', DEV_AUTH: 'true', LOG_LEVEL: 'silent' })

async function start(): Promise<{ app: FastifyInstance; repo: SqliteRepository; base: string }> {
  const repo = new SqliteRepository(dbFile)
  await repo.migrate()
  await seedIfEmpty(repo)
  const { app } = await buildApp(config, repo, { logger: false })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return { app, repo, base: `http://127.0.0.1:${address.port}` }
}

async function login(base: string, username: string): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${base}/api/dev/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { token: string; user: { id: string } }
  return { token: body.token, userId: body.user.id }
}

function api(base: string, token: string, path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers }
  })
}

function connectGateway(base: string, token: string) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/gateway')
  const frames: GatewayServerFrame[] = []
  const waiters: { pred: (f: GatewayServerFrame) => boolean; resolve: (f: GatewayServerFrame) => void }[] = []
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as GatewayServerFrame
    frames.push(frame)
    if (frame.op === 'hello') ws.send(JSON.stringify({ op: 'identify', d: { token } }))
    for (const w of [...waiters]) {
      if (w.pred(frame)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(frame)
      }
    }
  })
  const waitFor = (pred: (f: GatewayServerFrame) => boolean, ms = 3000) =>
    new Promise<GatewayServerFrame>((resolve, reject) => {
      const existing = frames.find(pred)
      if (existing) return resolve(existing)
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), ms)
      waiters.push({ pred, resolve: (f) => (clearTimeout(timer), resolve(f)) })
    })
  return { ws, waitFor }
}

describe('Discord 2.0 server', () => {
  let server: Awaited<ReturnType<typeof start>>

  before(async () => {
    server = await start()
  })

  after(async () => {
    await server.app.close()
    await server.repo.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('rejects unauthenticated API access', async () => {
    const res = await fetch(`${server.base}/api/servers`)
    assert.equal(res.status, 401)
  })

  test('lists seeded servers and channels', async () => {
    const { token } = await login(server.base, 'alice')
    const res = await api(server.base, token, '/api/servers')
    const servers = (await res.json()) as { id: string; channels: { id: string }[] }[]
    assert.ok(servers.some((s) => s.id === 'hangout'))
    assert.ok(servers[0]!.channels.length > 0)
  })

  test('delivers a message from client A to client B in real time', async () => {
    const a = await login(server.base, 'alice')
    const b = await login(server.base, 'bob')
    const gwA = connectGateway(server.base, a.token)
    const gwB = connectGateway(server.base, b.token)
    await gwA.waitFor((f) => f.op === 'ready')
    await gwB.waitFor((f) => f.op === 'ready')

    const res = await api(server.base, a.token, '/api/channels/hangout-general/messages', {
      method: 'POST',
      body: JSON.stringify({ content: 'hello from A', nonce: 'n1' })
    })
    assert.equal(res.status, 201)

    const frame = await gwB.waitFor(
      (f) => f.op === 'message_create' && f.d.content === 'hello from A'
    )
    assert.equal(frame.op === 'message_create' && frame.d.authorId, a.userId)
    gwA.ws.close()
    gwB.ws.close()
  })

  test('validates messages', async () => {
    const { token } = await login(server.base, 'carol')
    const post = (content: unknown) =>
      api(server.base, token, '/api/channels/hangout-music/messages', {
        method: 'POST',
        body: JSON.stringify({ content })
      })
    assert.equal((await post('   ')).status, 400)
    assert.equal((await post('x'.repeat(2001))).status, 400)
    assert.equal((await post(42)).status, 400)
    const voice = await api(server.base, token, '/api/channels/hangout-lounge/messages', {
      method: 'POST',
      body: JSON.stringify({ content: 'hi' })
    })
    assert.equal(voice.status, 400)
  })

  test('rate limits message bursts', async () => {
    const { token } = await login(server.base, 'dave')
    const statuses: number[] = []
    for (let i = 0; i < 8; i++) {
      const res = await api(server.base, token, '/api/channels/hangout-memes/messages', {
        method: 'POST',
        body: JSON.stringify({ content: `spam ${i}` })
      })
      statuses.push(res.status)
    }
    assert.ok(statuses.includes(429), `expected a 429, got ${statuses.join(',')}`)
  })

  test('rejects unknown browser origins', async () => {
    const res = await fetch(`${server.base}/api/meta`, { headers: { Origin: 'https://evil.example' } })
    assert.equal(res.status, 403)
  })

  test('persists messages across a backend restart', async () => {
    const { token } = await login(server.base, 'erin')
    await api(server.base, token, '/api/channels/hangout-announcements/messages', {
      method: 'POST',
      body: JSON.stringify({ content: 'survives restarts' })
    })

    await server.app.close()
    await server.repo.close()
    server = await start()

    // The session token is persisted too, so the same client can keep going.
    const res = await api(server.base, token, '/api/channels/hangout-announcements/messages')
    const messages = (await res.json()) as ApiMessage[]
    assert.ok(messages.some((m) => m.content === 'survives restarts'))
  })
})
