import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { AccessToken, TokenVerifier } from 'livekit-server-sdk'
import { AccessService } from '../src/access.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { seedIfEmpty, SYSTEM_BOT_ID } from '../src/db/seed.js'
import { SqliteRepository } from '../src/db/sqlite.js'
import type { ApiVoiceState, ApiVoiceToken, GatewayServerFrame } from '../src/protocol.js'
import {
  authorizeVoiceJoin,
  channelIdFromRoom,
  publishSourcesFor,
  roomNameForChannel,
  voiceGrant,
  VOICE_TOKEN_TTL_SECONDS
} from '../src/voice/access.js'
import { Permissions } from '../src/protocol.js'
import { TrackSource } from 'livekit-server-sdk'
import { VoiceStateStore } from '../src/voice/voiceStates.js'

const API_KEY = 'test-key'
const API_SECRET = 'test-secret-that-is-at-least-32-characters-long'
const LIVEKIT_ENV = {
  LIVEKIT_API_KEY: API_KEY,
  LIVEKIT_API_SECRET: API_SECRET,
  // Unreachable on purpose: reconciliation is disabled in these tests.
  LIVEKIT_URL: 'http://127.0.0.1:9',
  LIVEKIT_PUBLIC_URL: 'ws://192.168.68.65:7880'
}

interface Running {
  app: FastifyInstance
  repo: SqliteRepository
  base: string
}

async function start(env: Record<string, string>): Promise<Running> {
  const repo = new SqliteRepository(':memory:')
  await repo.migrate()
  await seedIfEmpty(repo)
  const config = loadConfig({ NODE_ENV: 'test', DEV_AUTH: 'true', LOG_LEVEL: 'silent', ...env })
  const { app } = await buildApp(config, repo, { logger: false, voiceReconcileIntervalMs: 0 })
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

function requestVoiceToken(base: string, token: string | null, channelId: string) {
  return fetch(`${base}/api/voice/channels/${channelId}/token`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  })
}

async function signedWebhook(body: string, secret = API_SECRET): Promise<string> {
  const at = new AccessToken(API_KEY, secret)
  at.sha256 = createHash('sha256').update(body).digest('base64')
  return at.toJwt()
}

async function postWebhook(base: string, event: object, secret = API_SECRET) {
  const body = JSON.stringify(event)
  return fetch(`${base}/api/livekit/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/webhook+json',
      Authorization: await signedWebhook(body, secret)
    },
    body
  })
}

function collectFrames(base: string, token: string) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/gateway')
  const frames: GatewayServerFrame[] = []
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as GatewayServerFrame
    frames.push(frame)
    if (frame.op === 'hello') ws.send(JSON.stringify({ op: 'identify', d: { token } }))
  })
  const waitFor = async (pred: (f: GatewayServerFrame) => boolean, ms = 3000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const hit = frames.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error('timed out waiting for gateway frame')
  }
  return { ws, waitFor, frames }
}

describe('voice: config', () => {
  test('voice is disabled when no LIVEKIT_* variables are set', () => {
    assert.equal(loadConfig({}).livekit, null)
  })

  test('rejects partial voice configuration', () => {
    assert.throws(() => loadConfig({ LIVEKIT_API_KEY: 'k' }), /incomplete/)
  })

  test('rejects short API secrets', () => {
    assert.throws(() => loadConfig({ ...LIVEKIT_ENV, LIVEKIT_API_SECRET: 'short' }), /32 characters/)
  })

  test('requires a ws(s) public URL', () => {
    assert.throws(
      () => loadConfig({ ...LIVEKIT_ENV, LIVEKIT_PUBLIC_URL: 'http://192.168.68.65:7880' }),
      /ws\(s\)/
    )
  })
})

describe('voice: rooms and state store', () => {
  test('maps channels to rooms and back', () => {
    assert.equal(roomNameForChannel('hangout-lounge'), 'voice_hangout-lounge')
    assert.equal(channelIdFromRoom('voice_hangout-lounge'), 'hangout-lounge')
    assert.equal(channelIdFromRoom('something-else'), undefined)
  })

  test('tracks joins, moves, stale leaves and reconciliation diffs', () => {
    const store = new VoiceStateStore()
    assert.deepEqual(store.join('u1', 'a'), [{ userId: 'u1', channelId: 'a' }])
    assert.deepEqual(store.join('u1', 'a'), [])
    assert.deepEqual(store.join('u1', 'b'), [{ userId: 'u1', channelId: 'b' }])
    // A late "left a" after moving to b must not remove the user from b.
    assert.deepEqual(store.leave('u1', 'a'), [])
    assert.equal(store.channelOf('u1'), 'b')

    store.join('u2', 'a')
    const changes = store.replaceAll(new Map([['u2', 'c'], ['u3', 'a']]))
    assert.deepEqual(
      changes.sort((x, y) => x.userId.localeCompare(y.userId)),
      [
        { userId: 'u1', channelId: null },
        { userId: 'u2', channelId: 'c' },
        { userId: 'u3', channelId: 'a' }
      ]
    )
  })

  test('bots may not join voice', async () => {
    const repo = new SqliteRepository(':memory:')
    await repo.migrate()
    await seedIfEmpty(repo)
    const bot = (await repo.getUser(SYSTEM_BOT_ID))!
    // Bots are never server members; non-members get "not found" (no probing of channel ids).
    await assert.rejects(authorizeVoiceJoin(new AccessService(repo), bot, 'hangout-lounge'), { statusCode: 404 })
    await repo.close()
  })

  test('tracks screen-share state only for members of the channel', () => {
    const store = new VoiceStateStore()
    // Not in the channel yet: ignored.
    assert.deepEqual(store.setStreaming('u1', 'a', true), [])
    store.join('u1', 'a')
    assert.deepEqual(store.setStreaming('u1', 'a', true), [
      { userId: 'u1', channelId: 'a', streaming: true }
    ])
    assert.deepEqual(store.setStreaming('u1', 'a', true), [])
    // Wrong channel: ignored.
    assert.deepEqual(store.setStreaming('u1', 'b', false), [])
    assert.deepEqual(store.snapshot(), [{ userId: 'u1', channelId: 'a', streaming: true }])

    // Moving channels ends the share; leaving clears it.
    store.join('u1', 'b')
    assert.equal(store.isStreaming('u1'), false)
    store.setStreaming('u1', 'b', true)
    store.leave('u1', 'b')
    assert.equal(store.isStreaming('u1'), false)
    assert.deepEqual(store.snapshot(), [])
  })

  test('reconciles streaming state from authoritative snapshots', () => {
    const store = new VoiceStateStore()
    store.join('u1', 'a')
    const changes = store.replaceAll(new Map([['u1', { channelId: 'a', streaming: true }]]))
    assert.deepEqual(changes, [{ userId: 'u1', channelId: 'a', streaming: true }])
    const stopped = store.replaceAll(new Map([['u1', 'a']]))
    assert.deepEqual(stopped, [{ userId: 'u1', channelId: 'a', streaming: false }])
  })
})

describe('voice: camera grant (Milestone 14.5)', () => {
  test('Stream ("Video") grants camera and screen share; Speak alone grants only the microphone', () => {
    const base = Permissions.connect
    assert.deepEqual(publishSourcesFor(base | Permissions.speak), [TrackSource.MICROPHONE])
    assert.deepEqual(publishSourcesFor(base | Permissions.stream), [
      TrackSource.CAMERA,
      TrackSource.SCREEN_SHARE,
      TrackSource.SCREEN_SHARE_AUDIO
    ])
    assert.deepEqual(publishSourcesFor(base | Permissions.speak | Permissions.stream), [
      TrackSource.MICROPHONE,
      TrackSource.CAMERA,
      TrackSource.SCREEN_SHARE,
      TrackSource.SCREEN_SHARE_AUDIO
    ])
  })

  test('without Speak or Stream nothing may be published (listen-only), but cameras can be watched', () => {
    const grant = voiceGrant('voice_x', Permissions.connect)
    assert.equal(grant.canPublish, false)
    assert.deepEqual(grant.canPublishSources, [])
    assert.equal(grant.canSubscribe, true)
    assert.equal(grant.canPublishData, false)
  })

  test('meta advertises camera support', async () => {
    const server = await start(LIVEKIT_ENV)
    try {
      const meta = (await (await fetch(`${server.base}/api/meta`)).json()) as { camera?: boolean }
      assert.equal(meta.camera, true)
    } finally {
      await server.app.close()
      await server.repo.close()
    }
  })
})

describe('voice: token endpoint', () => {
  let server: Running

  before(async () => {
    server = await start(LIVEKIT_ENV)
  })
  after(async () => {
    await server.app.close()
    await server.repo.close()
  })

  test('requires authentication', async () => {
    assert.equal((await requestVoiceToken(server.base, null, 'hangout-lounge')).status, 401)
  })

  test('rejects unknown and text channels', async () => {
    const { token } = await login(server.base, 'alice')
    assert.equal((await requestVoiceToken(server.base, token, 'does-not-exist')).status, 404)
    assert.equal((await requestVoiceToken(server.base, token, 'hangout-general')).status, 400)
  })

  test('issues a short-lived token scoped to one room and the session identity', async () => {
    const { token, userId } = await login(server.base, 'alice')
    const res = await requestVoiceToken(server.base, token, 'hangout-lounge')
    assert.equal(res.status, 200)
    const grant = (await res.json()) as ApiVoiceToken & { apiSecret?: unknown }

    assert.equal(grant.url, 'ws://192.168.68.65:7880')
    assert.equal(grant.room, 'voice_hangout-lounge')
    assert.equal(grant.identity, userId)
    assert.equal(JSON.stringify(grant).includes(API_SECRET), false, 'secret must never be returned')

    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(grant.token)
    assert.equal(claims.sub, userId)
    assert.equal(claims.video?.room, 'voice_hangout-lounge')
    assert.equal(claims.video?.roomJoin, true)
    assert.equal(claims.video?.roomAdmin, undefined)
    assert.equal(claims.video?.roomCreate, undefined)
    assert.equal(claims.video?.roomList, undefined)
    assert.equal(claims.video?.canPublishData, false)
    // Microphone, camera and screen share (video and system audio).
    assert.deepEqual(claims.video?.canPublishSources, [
      'microphone',
      'camera',
      'screen_share',
      'screen_share_audio'
    ])
    const lifetime = (claims.exp as number) - (claims.nbf as number)
    assert.ok(lifetime <= VOICE_TOKEN_TTL_SECONDS, `token lives ${lifetime}s`)

    await assert.rejects(
      new TokenVerifier(API_KEY, 'a-different-secret-that-is-32-chars-long!!').verify(grant.token)
    )
  })

  test('ignores any client-supplied identity', async () => {
    const { token, userId } = await login(server.base, 'mallory')
    const res = await fetch(`${server.base}/api/voice/channels/hangout-lounge/token?identity=alice`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'someone-else' })
    })
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as ApiVoiceToken).identity, userId)
  })

  test('rate limits token requests', async () => {
    const { token } = await login(server.base, 'tokenspam')
    const statuses: number[] = []
    for (let i = 0; i < 14; i++) {
      statuses.push((await requestVoiceToken(server.base, token, 'hangout-lounge')).status)
    }
    assert.ok(statuses.includes(429), statuses.join(','))
  })
})

describe('voice: presence via LiveKit webhooks', () => {
  let server: Running

  before(async () => {
    server = await start(LIVEKIT_ENV)
  })
  after(async () => {
    await server.app.close()
    await server.repo.close()
  })

  test('broadcasts joins and leaves from signed webhooks', async () => {
    const alice = await login(server.base, 'alice')
    const bob = await login(server.base, 'bob')
    const gw = collectFrames(server.base, bob.token)
    const ready = await gw.waitFor((f) => f.op === 'ready')
    assert.ok(ready.op === 'ready' && Array.isArray(ready.d.voiceStates))

    const joined = await postWebhook(server.base, {
      event: 'participant_joined',
      id: 'evt-1',
      createdAt: Math.floor(Date.now() / 1000),
      room: { name: 'voice_hangout-lounge' },
      participant: { identity: alice.userId }
    })
    assert.equal(joined.status, 200)
    await gw.waitFor(
      (f) =>
        f.op === 'voice_state_update' &&
        f.d.userId === alice.userId &&
        f.d.channelId === 'hangout-lounge'
    )

    const states = (await (
      await fetch(`${server.base}/api/voice/states`, {
        headers: { Authorization: `Bearer ${bob.token}` }
      })
    ).json()) as ApiVoiceState[]
    assert.deepEqual(states, [{ userId: alice.userId, channelId: 'hangout-lounge' }])

    await postWebhook(server.base, {
      event: 'participant_left',
      id: 'evt-2',
      createdAt: Math.floor(Date.now() / 1000),
      room: { name: 'voice_hangout-lounge' },
      participant: { identity: alice.userId }
    })
    await gw.waitFor(
      (f) => f.op === 'voice_state_update' && f.d.userId === alice.userId && f.d.channelId === null
    )
    gw.ws.close()
  })

  test('broadcasts screen-share start/stop from track webhooks', async () => {
    const alice = await login(server.base, 'streamer')
    const bob = await login(server.base, 'viewer')
    const gw = collectFrames(server.base, bob.token)
    await gw.waitFor((f) => f.op === 'ready')
    const base = { room: { name: 'voice_hangout-lounge' }, participant: { identity: alice.userId } }

    await postWebhook(server.base, { ...base, event: 'participant_joined', id: 's-1' })
    // Microphone and camera publications don't make anyone "live" (only a screen share does).
    await postWebhook(server.base, {
      ...base,
      event: 'track_published',
      id: 's-2',
      track: { sid: 'TR_mic', source: 'MICROPHONE', type: 'AUDIO' }
    })
    await postWebhook(server.base, {
      ...base,
      event: 'track_published',
      id: 's-2b',
      track: { sid: 'TR_cam', source: 'CAMERA', type: 'VIDEO' }
    })
    const published = await postWebhook(server.base, {
      ...base,
      event: 'track_published',
      id: 's-3',
      track: { sid: 'TR_screen', source: 'SCREEN_SHARE', type: 'VIDEO' }
    })
    assert.equal(published.status, 200)
    await gw.waitFor(
      (f) =>
        f.op === 'voice_state_update' && f.d.userId === alice.userId && f.d.streaming === true
    )
    const streamingFrames = () =>
      gw.frames.filter((f) => f.op === 'voice_state_update' && f.d.streaming !== undefined)
    assert.equal(streamingFrames().length, 1, 'mic or camera publish must not toggle streaming')

    const states = (await (
      await fetch(`${server.base}/api/voice/states`, {
        headers: { Authorization: `Bearer ${bob.token}` }
      })
    ).json()) as ApiVoiceState[]
    assert.deepEqual(
      states.find((s) => s.userId === alice.userId),
      { userId: alice.userId, channelId: 'hangout-lounge', streaming: true }
    )

    await postWebhook(server.base, {
      ...base,
      event: 'track_unpublished',
      id: 's-4',
      track: { sid: 'TR_screen', source: 'SCREEN_SHARE', type: 'VIDEO' }
    })
    await gw.waitFor(
      (f) =>
        f.op === 'voice_state_update' && f.d.userId === alice.userId && f.d.streaming === false
    )
    await postWebhook(server.base, { ...base, event: 'participant_left', id: 's-5' })
    gw.ws.close()
  })

  test('rejects webhooks with a bad signature or unknown identities', async () => {
    const forged = await postWebhook(
      server.base,
      {
        event: 'participant_joined',
        id: 'evt-3',
        room: { name: 'voice_hangout-lounge' },
        participant: { identity: 'whoever' }
      },
      'attacker-secret-that-is-also-32-characters'
    )
    assert.equal(forged.status, 401)

    const unknown = await postWebhook(server.base, {
      event: 'participant_joined',
      id: 'evt-4',
      room: { name: 'voice_hangout-lounge' },
      participant: { identity: 'not-a-real-user' }
    })
    assert.equal(unknown.status, 200)

    const { token } = await login(server.base, 'carol')
    const states = (await (
      await fetch(`${server.base}/api/voice/states`, {
        headers: { Authorization: `Bearer ${token}` }
      })
    ).json()) as ApiVoiceState[]
    assert.equal(states.length, 0)
  })
})

describe('voice: disabled', () => {
  test('returns 503 when LiveKit is not configured', async () => {
    const server = await start({})
    const { token } = await login(server.base, 'alice')
    assert.equal((await requestVoiceToken(server.base, token, 'hangout-lounge')).status, 503)
    const meta = (await (await fetch(`${server.base}/api/meta`)).json()) as { voice: boolean }
    assert.equal(meta.voice, false)
    await server.app.close()
    await server.repo.close()
  })
})
