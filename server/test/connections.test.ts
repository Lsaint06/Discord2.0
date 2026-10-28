/**
 * Milestone 10 tests: friends, friend requests, blocking, one-to-one DMs and group conversations
 * (membership, history boundaries, private reactions/replies/attachments/search, realtime
 * scoping, unread state, multiple sessions) and the additive v5 migration.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { HashGate, OWASP_MINIMUM, PasswordHasher } from '../src/auth/password.js'
import { loadConfig } from '../src/config.js'
import type { AppContext } from '../src/context.js'
import { DIRECT_SERVER_ID, sqliteMigrations } from '../src/db/migrations.js'
import { seedIfEmpty } from '../src/db/seed.js'
import { SqliteRepository } from '../src/db/sqlite.js'
import { TokenBucketLimiter } from '../src/lib/rateLimit.js'
import {
  Permissions,
  type ApiAttachment,
  type ApiAuthResult,
  type ApiConversation,
  type ApiConversationEvent,
  type ApiMe,
  type ApiMessage,
  type ApiProfile,
  type ApiReadState,
  type ApiRelationship,
  type ApiSearchResult,
  type ApiServer,
  type ApiUser,
  type GatewayServerFrame
} from '../src/protocol.js'

const SCHEME = ['Bea', 'rer'].join('')
const HASHER = new PasswordHasher(OWASP_MINIMUM, new HashGate(4, 64))
const PASSWORD = 'violet-anchor-sunrise-42'

const dir = mkdtempSync(join(tmpdir(), 'd2-connections-'))
const dbFile = join(dir, 'connections.db')
const attachmentsDir = join(dir, 'attachments')

interface Server {
  app: FastifyInstance
  ctx: AppContext
  repo: SqliteRepository
  base: string
}

let s: Server

async function start(file = dbFile): Promise<Server> {
  const repo = new SqliteRepository(file)
  await repo.migrate()
  await seedIfEmpty(repo)
  const config = loadConfig({
    NODE_ENV: 'test',
    DEV_AUTH: 'false',
    LOG_LEVEL: 'silent',
    ATTACHMENTS_DIR: attachmentsDir,
    UPLOAD_MIN_FREE_DISK_MB: '1'
  })
  const { app, ctx } = await buildApp(config, repo, {
    logger: false,
    hasher: HASHER,
    voiceReconcileIntervalMs: 0,
    attachmentCleanupIntervalMs: 0,
    statusExpiryIntervalMs: 0
  })
  for (const name of Object.keys(ctx.limiters) as (keyof AppContext['limiters'])[]) {
    ctx.limiters[name].dispose()
    ctx.limiters[name] = new TokenBucketLimiter(10_000, 1_000)
  }
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return { app, ctx, repo, base: `http://127.0.0.1:${address.port}` }
}

async function stop(server: Server): Promise<void> {
  await server.app.close()
  await server.repo.close()
}

function req(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (init.token) headers.Authorization = `${SCHEME} ${init.token}`
  if (init.json !== undefined) headers['Content-Type'] = 'application/json'
  return fetch(`${s.base}${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body
  })
}

async function json<T>(res: Response, status: number): Promise<T> {
  const text = await res.text()
  assert.equal(res.status, status, `${res.status} ${text}`)
  return (text ? JSON.parse(text) : undefined) as T
}

const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code

let adminToken = ''

async function login(username: string): Promise<ApiAuthResult> {
  return json<ApiAuthResult>(
    await req('/api/auth/login', { method: 'POST', json: { username, password: PASSWORD } }),
    200
  )
}

async function register(username: string, serverId: string | null = 'hangout'): Promise<ApiAuthResult> {
  const invite = await json<{ code: string }>(
    await req('/api/admin/registration-invites', {
      method: 'POST',
      token: adminToken,
      json: { password: PASSWORD, serverId }
    }),
    201
  )
  return json<ApiAuthResult>(
    await req('/api/auth/register', {
      method: 'POST',
      json: { code: invite.code, username, displayName: username, password: PASSWORD }
    }),
    201
  )
}

function gateway(token: string) {
  const ws = new WebSocket(s.base.replace('http', 'ws') + '/gateway')
  const frames: GatewayServerFrame[] = []
  const waiters: { pred: (f: GatewayServerFrame) => boolean; resolve: (f: GatewayServerFrame) => void }[] = []
  const closed = new Promise<number>((resolve) => ws.addEventListener('close', (ev) => resolve(ev.code)))
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
  let cursor = 0
  const waitFor = (pred: (f: GatewayServerFrame) => boolean, ms = 3000) =>
    new Promise<GatewayServerFrame>((resolve, reject) => {
      const index = frames.findIndex((f, i) => i >= cursor && pred(f))
      if (index >= 0) {
        cursor = index + 1
        return resolve(frames[index]!)
      }
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), ms)
      waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(timer)
          cursor = frames.lastIndexOf(f) + 1
          resolve(f)
        }
      })
    })
  const close = async () => {
    ws.close()
    await closed
  }
  return { ws, frames, waitFor, close, closed }
}

type Gw = ReturnType<typeof gateway>

async function ready(gw: Gw): Promise<Extract<GatewayServerFrame, { op: 'ready' }>> {
  return (await gw.waitFor((f) => f.op === 'ready')) as Extract<GatewayServerFrame, { op: 'ready' }>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- API helpers ----

const friendRequest = (token: string, username: string) =>
  req('/api/relationships/requests', { method: 'POST', token, json: { username } })

async function befriend(a: ApiAuthResult, b: ApiAuthResult): Promise<void> {
  const first = await friendRequest(a.token, b.user.username)
  assert.ok([200, 201].includes(first.status), `request ${first.status}`)
  await json(await req(`/api/relationships/${a.user.id}/accept`, { method: 'POST', token: b.token }), 200)
}

const relationships = async (token: string) =>
  json<ApiRelationship[]>(await req('/api/relationships', { token }), 200)

const openDm = (token: string, userId: string) =>
  req('/api/conversations/dm', { method: 'POST', token, json: { userId } })

const createGroup = (token: string, userIds: string[], name?: string | null) =>
  req('/api/conversations/group', { method: 'POST', token, json: { userIds, ...(name !== undefined ? { name } : {}) } })

const conversations = async (token: string) =>
  json<ApiConversation[]>(await req('/api/conversations', { token }), 200)

async function send(token: string, channelId: string, body: Record<string, unknown>): Promise<Response> {
  return req(`/api/channels/${channelId}/messages`, { method: 'POST', token, json: body })
}

async function sendOk(token: string, channelId: string, content: string, extra: Record<string, unknown> = {}) {
  return json<ApiMessage>(await send(token, channelId, { content, ...extra }), 201)
}

const history = async (token: string, channelId: string, query = '') =>
  json<ApiMessage[]>(await req(`/api/channels/${channelId}/messages${query}`, { token }), 200)

async function uploadText(token: string, channelId: string, text: string): Promise<ApiAttachment> {
  const form = new FormData()
  form.append('file', new Blob([text]), 'note.txt')
  const files = await json<ApiAttachment[]>(
    await req(`/api/channels/${channelId}/attachments`, { method: 'POST', token, body: form }),
    201
  )
  return files[0]!
}

let alice: ApiAuthResult
let bob: ApiAuthResult
/** Shares no server with anyone. */
let carol: ApiAuthResult
let dave: ApiAuthResult
let erin: ApiAuthResult

before(async () => {
  s = await start()
  const now = Date.now()
  const admin = await s.repo.provisionAccount(
    { id: 'admin-1', username: 'root', displayName: 'Root', avatarColor: '#111111', bot: false, createdAt: now },
    await HASHER.hash(PASSWORD),
    now
  )
  for (const server of await s.repo.listServers()) await s.repo.setOwner(server.id, admin.id, now)
  adminToken = (await login('root')).token
  alice = await register('alice')
  bob = await register('bob')
  carol = await register('carol', null)
  dave = await register('dave')
  erin = await register('erin', null)
})

after(async () => {
  await stop(s)
  rmSync(dir, { recursive: true, force: true })
})

// ======================================================================
describe('conversation container stays hidden', () => {
  test('the server advertises the feature', async () => {
    const meta = (await (await fetch(`${s.base}/api/meta`)).json()) as { apiVersion: number; connections: boolean }
    assert.equal(meta.apiVersion, 4)
    assert.equal(meta.connections, true)
  })

  test('the reserved container is not a server anywhere', async () => {
    const servers = await json<ApiServer[]>(await req('/api/servers', { token: alice.token }), 200)
    assert.ok(!servers.some((x) => x.id === DIRECT_SERVER_ID))
    assert.equal(await s.repo.getServer(DIRECT_SERVER_ID), undefined)
    assert.ok(!(await s.repo.listServers()).some((x) => x.id === DIRECT_SERVER_ID))
    assert.ok(!(await s.repo.listChannels()).some((c) => c.serverId === DIRECT_SERVER_ID))
    assert.equal((await s.repo.integrityReport()).serversWithoutOwner.length, 0)
    // Registration invites can't target it.
    const res = await req('/api/admin/registration-invites', {
      method: 'POST',
      token: adminToken,
      json: { password: PASSWORD, serverId: DIRECT_SERVER_ID }
    })
    assert.ok(res.status >= 400)
  })
})

// ======================================================================
describe('friends', () => {
  test('request, live updates, accept, then remove', async () => {
    const aliceGw = gateway(alice.token)
    const carolGw = gateway(carol.token)
    await ready(aliceGw)
    await ready(carolGw)

    // Carol shares no server with Alice — requests go by exact username.
    const sent = await json<{ type: string }>(await friendRequest(carol.token, 'ALICE'), 201)
    assert.equal(sent.type, 'outgoing')
    await aliceGw.waitFor((f) => f.op === 'relationship_update' && f.d.userId === carol.user.id && f.d.type === 'incoming')
    await carolGw.waitFor((f) => f.op === 'relationship_update' && f.d.userId === alice.user.id && f.d.type === 'outgoing')
    // Alice can now see Carol (pending request), and vice versa.
    await aliceGw.waitFor((f) => f.op === 'user_update' && f.d.id === carol.user.id)
    assert.deepEqual(
      (await relationships(alice.token)).map((r) => [r.userId, r.type]),
      [[carol.user.id, 'incoming']]
    )
    // Repeating is idempotent.
    assert.equal((await friendRequest(carol.token, 'alice')).status, 200)

    await json(await req(`/api/relationships/${carol.user.id}/accept`, { method: 'POST', token: alice.token }), 200)
    await carolGw.waitFor((f) => f.op === 'relationship_update' && f.d.userId === alice.user.id && f.d.type === 'friend')
    assert.equal((await relationships(carol.token)).find((r) => r.userId === alice.user.id)?.type, 'friend')
    assert.equal(await errorCode(await friendRequest(carol.token, 'alice')), 'already_friends')

    // Friends see each other's presence even without a shared server.
    const users = await json<ApiUser[]>(await req('/api/users', { token: carol.token }), 200)
    assert.equal(users.find((u) => u.id === alice.user.id)?.status, 'online')

    // Remove the friendship.
    assert.equal((await req(`/api/relationships/${alice.user.id}`, { method: 'DELETE', token: carol.token })).status, 204)
    await aliceGw.waitFor((f) => f.op === 'relationship_update' && f.d.userId === carol.user.id && f.d.type === null)
    assert.equal((await relationships(alice.token)).length, 0)
    await aliceGw.close()
    await carolGw.close()
  })

  test('decline and cancel', async () => {
    await json(await friendRequest(erin.token, 'dave'), 201)
    assert.equal((await req(`/api/relationships/${erin.user.id}`, { method: 'DELETE', token: dave.token })).status, 204)
    assert.equal((await relationships(erin.token)).length, 0)
    await json(await friendRequest(erin.token, 'dave'), 201)
    assert.equal((await req(`/api/relationships/${dave.user.id}`, { method: 'DELETE', token: erin.token })).status, 204)
    assert.equal((await relationships(dave.token)).length, 0)
    // Accepting something that doesn't exist.
    assert.equal((await req(`/api/relationships/${erin.user.id}/accept`, { method: 'POST', token: dave.token })).status, 404)
  })

  test('invalid targets get one generic answer; yourself is refused', async () => {
    assert.equal(await errorCode(await friendRequest(alice.token, 'alice')), 'self_request')
    const codes = await Promise.all(
      ['nobody-here', 'orbit', 'x', 'bad name!'].map(async (u) => errorCode(await friendRequest(alice.token, u)))
    )
    assert.deepEqual(new Set(codes), new Set(['friend_request_failed']))
  })

  test('simultaneous requests become exactly one friendship', async () => {
    const [a, b] = await Promise.all([friendRequest(dave.token, 'erin'), friendRequest(erin.token, 'dave')])
    const results = [a.status, b.status].sort()
    assert.deepEqual(results, [200, 201])
    assert.equal(await s.repo.areFriends(dave.user.id, erin.user.id), true)
    const raw = (s.repo as unknown as { db: DatabaseSync }).db
    assert.equal(Number(raw.prepare('SELECT COUNT(*) AS n FROM friendships').get()?.n), 1)
    assert.equal(Number(raw.prepare('SELECT COUNT(*) AS n FROM friend_requests').get()?.n), 0)
    await req(`/api/relationships/${erin.user.id}`, { method: 'DELETE', token: dave.token })
  })
})

// ======================================================================
describe('blocking', () => {
  test('blocking ends the friendship, hides presence and is never revealed', async () => {
    await befriend(alice, carol)
    const carolGw = gateway(carol.token)
    await ready(carolGw)

    assert.equal((await req(`/api/relationships/${carol.user.id}/block`, { method: 'PUT', token: alice.token })).status, 204)
    // Carol just sees "no relationship", and Alice appears offline to her.
    await carolGw.waitFor((f) => f.op === 'relationship_update' && f.d.userId === alice.user.id && f.d.type === null)
    assert.equal((await relationships(carol.token)).length, 0)
    assert.equal((await relationships(alice.token)).find((r) => r.userId === carol.user.id)?.type, 'blocked')
    assert.equal(await s.repo.areFriends(alice.user.id, carol.user.id), false)

    // Carol's request gets the same answer as a nonexistent username.
    assert.equal(await errorCode(await friendRequest(carol.token, 'alice')), 'friend_request_failed')
    // Alice gets a clear message (she knows she blocked).
    assert.equal(await errorCode(await friendRequest(alice.token, 'carol')), 'you_blocked')

    // Presence is masked for both, and Alice's later status changes don't reach Carol.
    const aliceGw = gateway(alice.token)
    await ready(aliceGw)
    await sleep(100)
    assert.ok(!carolGw.frames.some((f) => f.op === 'user_update' && f.d.id === alice.user.id && f.d.status !== 'offline'))
    const profile = await json<ApiProfile>(await req(`/api/users/${carol.user.id}/profile`, { token: alice.token }), 200)
    assert.equal(profile.user.status, 'offline')
    assert.equal(profile.relationship, 'blocked')

    // Unblock: visible again only through remaining relationships (none here), no friendship restored.
    assert.equal((await req(`/api/relationships/${carol.user.id}/block`, { method: 'DELETE', token: alice.token })).status, 204)
    assert.equal((await relationships(alice.token)).length, 0)
    assert.equal((await req(`/api/relationships/${carol.user.id}/block`, { method: 'DELETE', token: alice.token })).status, 404)
    await aliceGw.close()
    await carolGw.close()
  })

  test('you cannot block yourself or people you cannot see', async () => {
    assert.equal(await errorCode(await req(`/api/relationships/${alice.user.id}/block`, { method: 'PUT', token: alice.token })), 'self_block')
    assert.equal((await req(`/api/relationships/${erin.user.id}/block`, { method: 'PUT', token: alice.token })).status, 404)
  })
})

// ======================================================================
describe('direct messages', () => {
  test('eligibility: friends, or a shared server with DMs allowed — never across a block', async () => {
    // No shared server, not friends: Erin isn't even visible to Alice.
    assert.equal((await openDm(alice.token, erin.user.id)).status, 404)
    // Shared server (hangout) and Bob allows server DMs (the default).
    const me = await json<ApiMe>(await req('/api/users/me', { token: bob.token }), 200)
    assert.equal(me.allowServerDms, true)
    const dm = await json<ApiConversation>(await openDm(alice.token, bob.user.id), 201)
    assert.equal(dm.kind, 'dm')
    assert.equal(dm.permissions & Permissions.sendMessages, Permissions.sendMessages)
    assert.equal(dm.permissions & Permissions.manageMessages, 0)

    // Dave turns server DMs off: Alice can't start one with him.
    await json<ApiMe>(await req('/api/users/me/privacy', { method: 'PATCH', token: dave.token, json: { allowServerDms: false } }), 200)
    assert.equal(await errorCode(await openDm(alice.token, dave.user.id)), 'dm_not_allowed')
    // ...but friends always can.
    await befriend(alice, dave)
    const withDave = await json<ApiConversation>(await openDm(alice.token, dave.user.id), 201)
    await sendOk(alice.token, withDave.id, 'hi dave')
    // Unfriending makes the existing DM read-only (re-checked on every send), history stays.
    await req(`/api/relationships/${dave.user.id}`, { method: 'DELETE', token: alice.token })
    assert.equal(await errorCode(await send(alice.token, withDave.id, { content: 'still there?' })), 'missing_permission')
    assert.equal((await history(alice.token, withDave.id)).length, 1)
    const reopened = await json<ApiConversation>(await openDm(alice.token, dave.user.id), 200)
    assert.equal(reopened.id, withDave.id)
    assert.equal(reopened.permissions, Permissions.viewChannel)
    await req('/api/users/me/privacy', { method: 'PATCH', token: dave.token, json: { allowServerDms: true } })
    assert.equal((await send(alice.token, withDave.id, { content: 'back' })).status, 201)

    // Self and bots.
    assert.equal(await errorCode(await openDm(alice.token, alice.user.id)), 'self_dm')
  })

  test('one canonical DM per pair, even when both open it at once', async () => {
    const [x, y] = await Promise.all([openDm(dave.token, bob.user.id), openDm(bob.token, dave.user.id)])
    const [a, b] = [(await x.json()) as ApiConversation, (await y.json()) as ApiConversation]
    assert.equal(a.id, b.id)
    const raw = (s.repo as unknown as { db: DatabaseSync }).db
    const n = raw.prepare("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'dm' AND dm_key = ?").get(
      [bob.user.id, dave.user.id].sort().join(':')
    )?.n
    assert.equal(Number(n), 1)
  })

  test('the recipient sees a new DM when the first message arrives; closing hides it until the next', async () => {
    await befriend(carol, erin)
    const erinGw = gateway(erin.token)
    await ready(erinGw)
    const dm = await json<ApiConversation>(await openDm(carol.token, erin.user.id), 201)
    assert.ok(!(await conversations(erin.token)).some((c) => c.id === dm.id), 'empty DM not shown to recipient')

    const msg = await sendOk(carol.token, dm.id, 'hey erin')
    const update = await erinGw.waitFor((f) => f.op === 'conversation_update' && f.d.id === dm.id)
    const created = await erinGw.waitFor((f) => f.op === 'message_create' && f.d.id === msg.id)
    assert.ok(erinGw.frames.indexOf(update) < erinGw.frames.indexOf(created), 'conversation arrives before its message')
    assert.ok((await conversations(erin.token)).some((c) => c.id === dm.id))

    // Unread: Erin has one unread message in the DM.
    const states = await json<ApiReadState[]>(await req('/api/read-states', { token: erin.token }), 200)
    assert.equal(states.find((r) => r.channelId === dm.id)?.unreadCount, 1)

    // Close it on one device: all of Erin's devices drop it; the next message brings it back.
    const second = gateway(erin.token)
    await ready(second)
    assert.equal((await req(`/api/conversations/${dm.id}/close`, { method: 'POST', token: erin.token })).status, 204)
    await second.waitFor((f) => f.op === 'conversation_remove' && f.d.channelId === dm.id && f.d.reason === 'closed')
    assert.ok(!(await conversations(erin.token)).some((c) => c.id === dm.id))
    await sendOk(carol.token, dm.id, 'you there?')
    await second.waitFor((f) => f.op === 'conversation_update' && f.d.id === dm.id)
    assert.ok((await conversations(erin.token)).some((c) => c.id === dm.id))

    // A DM can't be left.
    assert.equal(await errorCode(await req(`/api/conversations/${dm.id}/leave`, { method: 'POST', token: erin.token })), 'not_a_group')
    await erinGw.close()
    await second.close()
  })

  test('outsiders get nothing: messages, pins, attachments, read states, search, realtime', async () => {
    const dm = await json<ApiConversation>(await openDm(alice.token, bob.user.id), 200)
    const file = await uploadText(alice.token, dm.id, 'secret notes')
    const daveGw = gateway(dave.token)
    await ready(daveGw)
    const msg = await sendOk(alice.token, dm.id, 'private plans', { attachmentIds: [file.id] })

    assert.equal((await req(`/api/channels/${dm.id}/messages`, { token: dave.token })).status, 404)
    assert.equal((await req(`/api/channels/${dm.id}/pins`, { token: dave.token })).status, 404)
    assert.equal((await send(dave.token, dm.id, { content: 'let me in' })).status, 404)
    assert.equal((await req(`/api/attachments/${file.id}`, { token: dave.token })).status, 404)
    assert.equal((await req(`/api/attachments/${file.id}`, { token: bob.token })).status, 200)
    assert.equal((await req(`/api/channels/${dm.id}/messages/${msg.id}/reactions/${encodeURIComponent('👍')}`, { method: 'PUT', token: dave.token })).status, 404)
    assert.equal((await req(`/api/conversations/${dm.id}/events`, { token: dave.token })).status, 404)
    assert.equal((await req(`/api/search?q=private&channelId=${dm.id}`, { token: dave.token })).status, 404)
    const states = await json<ApiReadState[]>(await req('/api/read-states', { token: dave.token }), 200)
    assert.ok(!states.some((r) => r.channelId === dm.id))
    // Global search covers server channels only; inside the DM it finds the message.
    const global = await json<ApiSearchResult>(await req('/api/search?q=private', { token: alice.token }), 200)
    assert.ok(!global.messages.some((m) => m.id === msg.id))
    const inside = await json<ApiSearchResult>(await req(`/api/search?q=private&channelId=${dm.id}`, { token: bob.token }), 200)
    assert.ok(inside.messages.some((m) => m.id === msg.id))
    // Server-channel management routes don't accept a conversation.
    assert.equal((await req(`/api/channels/${dm.id}`, { method: 'PATCH', token: alice.token, json: { name: 'x' } })).status, 404)
    // Voice refuses conversations (they are text).
    assert.notEqual((await req(`/api/voice/channels/${dm.id}/token`, { method: 'POST', token: alice.token })).status, 200)

    await sleep(100)
    assert.ok(!daveGw.frames.some((f) => f.op === 'message_create' && f.d.channelId === dm.id))
    await daveGw.close()
  })

  test('blocking makes an existing DM read-only for both, without revealing the block', async () => {
    const dm = await json<ApiConversation>(await openDm(alice.token, bob.user.id), 200)
    await req(`/api/relationships/${alice.user.id}/block`, { method: 'PUT', token: bob.token })
    // Alice gets the generic "can't send" (same as any other refusal).
    assert.equal(await errorCode(await send(alice.token, dm.id, { content: 'hello?' })), 'missing_permission')
    assert.equal(await errorCode(await send(bob.token, dm.id, { content: 'hello?' })), 'missing_permission')
    assert.ok((await history(alice.token, dm.id)).length > 0, 'history stays readable')
    const view = (await conversations(alice.token)).find((c) => c.id === dm.id)
    assert.equal(view?.permissions, Permissions.viewChannel)
    await req(`/api/relationships/${alice.user.id}/block`, { method: 'DELETE', token: bob.token })
    assert.equal((await send(alice.token, dm.id, { content: 'hello again' })).status, 201)
  })

  test('every session of a user receives DM messages and read positions', async () => {
    const dm = await json<ApiConversation>(await openDm(alice.token, bob.user.id), 200)
    const second = await login('bob')
    const one = gateway(bob.token)
    const two = gateway(second.token)
    await ready(one)
    await ready(two)
    const msg = await sendOk(alice.token, dm.id, 'to both devices')
    await one.waitFor((f) => f.op === 'message_create' && f.d.id === msg.id)
    await two.waitFor((f) => f.op === 'message_create' && f.d.id === msg.id)
    await json(await req(`/api/channels/${dm.id}/read`, { method: 'PUT', token: bob.token, json: { messageId: msg.id } }), 200)
    await two.waitFor((f) => f.op === 'read_state_update' && f.d.channelId === dm.id && f.d.lastReadId === msg.id)
    // Revoking the second session closes its socket; the first keeps receiving.
    await req('/api/auth/logout', { method: 'POST', token: second.token })
    await two.closed
    const next = await sendOk(alice.token, dm.id, 'after logout')
    await one.waitFor((f) => f.op === 'message_create' && f.d.id === next.id)
    await one.close()
  })
})

// ======================================================================
describe('group conversations', () => {
  let group: ApiConversation
  let early: ApiMessage
  let earlyFile: ApiAttachment

  test('created with friends only; everyone sees it at once', async () => {
    await befriend(alice, bob)
    await befriend(alice, carol)
    // Dave isn't Alice's friend.
    assert.equal(await errorCode(await createGroup(alice.token, [bob.user.id, dave.user.id])), 'not_friends')
    // Too small: needs 3 people in total.
    assert.equal((await createGroup(alice.token, [bob.user.id])).status, 400)
    assert.equal(await errorCode(await createGroup(alice.token, [alice.user.id, bob.user.id])), 'self_in_group')

    const bobGw = gateway(bob.token)
    await ready(bobGw)
    group = await json<ApiConversation>(await createGroup(alice.token, [bob.user.id, carol.user.id], '  Weekend  plans '), 201)
    assert.equal(group.kind, 'group')
    assert.equal(group.name, 'Weekend plans')
    assert.equal(group.ownerId, alice.user.id)
    assert.deepEqual([...group.memberIds].sort(), [alice.user.id, bob.user.id, carol.user.id].sort())
    await bobGw.waitFor((f) => f.op === 'conversation_update' && f.d.id === group.id)
    await bobGw.close()

    earlyFile = await uploadText(bob.token, group.id, 'early attachment')
    early = await sendOk(bob.token, group.id, 'before dave joined', { attachmentIds: [earlyFile.id] })
    await json(await req(`/api/channels/${group.id}/pins/${early.id}`, { method: 'PUT', token: carol.token }), 200)
  })

  test('a member added later sees only messages from when they joined', async () => {
    // Carol adds her friend Dave? She isn't his friend — refused. Alice adds Dave after befriending.
    assert.equal(await errorCode(await req(`/api/conversations/${group.id}/members`, { method: 'POST', token: carol.token, json: { userId: dave.user.id } })), 'not_friends')
    await befriend(alice, dave)
    const daveGw = gateway(dave.token)
    await ready(daveGw)
    const updated = await json<ApiConversation>(await req(`/api/conversations/${group.id}/members`, { method: 'POST', token: alice.token, json: { userId: dave.user.id } }), 200)
    assert.equal(updated.memberIds.length, 4)
    await daveGw.waitFor((f) => f.op === 'conversation_update' && f.d.id === group.id)
    assert.equal(await errorCode(await req(`/api/conversations/${group.id}/members`, { method: 'POST', token: alice.token, json: { userId: dave.user.id } })), 'already_member')

    // History, around-cursor, pins, search, attachments: nothing from before.
    assert.equal((await history(dave.token, group.id)).length, 0)
    assert.equal((await history(dave.token, group.id, `?around=${early.id}`)).length, 0)
    assert.equal((await json<ApiMessage[]>(await req(`/api/channels/${group.id}/pins`, { token: dave.token }), 200)).length, 0)
    const found = await json<ApiSearchResult>(await req(`/api/search?q=before&channelId=${group.id}`, { token: dave.token }), 200)
    assert.equal(found.messages.length, 0)
    assert.equal((await req(`/api/attachments/${earlyFile.id}`, { token: dave.token })).status, 404)
    assert.equal((await req(`/api/attachments/${earlyFile.id}`, { token: carol.token })).status, 200)
    // Can't react to, pin, reply to or mark-read old messages.
    assert.equal((await req(`/api/channels/${group.id}/messages/${early.id}/reactions/${encodeURIComponent('🎉')}`, { method: 'PUT', token: dave.token })).status, 404)
    assert.equal((await req(`/api/channels/${group.id}/pins/${early.id}`, { method: 'DELETE', token: dave.token })).status, 404)
    assert.equal(await errorCode(await send(dave.token, group.id, { content: 'replying', replyToId: early.id })), 'invalid_reply')
    assert.equal((await req(`/api/channels/${group.id}/read`, { method: 'PUT', token: dave.token, json: { messageId: early.id } })).status, 404)
    // No unread backlog either.
    const states = await json<ApiReadState[]>(await req('/api/read-states', { token: dave.token }), 200)
    assert.equal(states.find((r) => r.channelId === group.id)?.unreadCount, 0)

    // Realtime: a reaction on the old message reaches existing members but not Dave.
    const carolGw = gateway(carol.token)
    await ready(carolGw)
    await json(await req(`/api/channels/${group.id}/messages/${early.id}/reactions/${encodeURIComponent('🔥')}`, { method: 'PUT', token: bob.token }), 200)
    await carolGw.waitFor((f) => f.op === 'reaction_update' && f.d.messageId === early.id)
    // A reply to the old message: Dave receives it, but without the parent's content.
    const reply = await sendOk(bob.token, group.id, 'replying to the early one', { replyToId: early.id })
    const daveSees = (await daveGw.waitFor((f) => f.op === 'message_create' && f.d.id === reply.id)) as Extract<GatewayServerFrame, { op: 'message_create' }>
    assert.deepEqual(daveSees.d.replyTo, { id: early.id, deleted: true })
    const carolSees = (await carolGw.waitFor((f) => f.op === 'message_create' && f.d.id === reply.id)) as Extract<GatewayServerFrame, { op: 'message_create' }>
    assert.equal(carolSees.d.replyTo?.deleted, false)
    assert.ok(!daveGw.frames.some((f) => f.op === 'reaction_update' && f.d.messageId === early.id))
    // In history too.
    const daveHistory = await history(dave.token, group.id)
    assert.deepEqual(daveHistory.map((m) => m.id), [reply.id])
    assert.deepEqual(daveHistory[0]!.replyTo, { id: early.id, deleted: true })
    // Editing someone else's message is still refused; nobody can delete others' messages.
    assert.equal(await errorCode(await req(`/api/channels/${group.id}/messages/${reply.id}`, { method: 'PATCH', token: dave.token, json: { content: 'x' } })), 'not_author')
    assert.equal(await errorCode(await req(`/api/channels/${group.id}/messages/${reply.id}`, { method: 'DELETE', token: alice.token })), 'not_author')

    // Membership history since Dave joined.
    const events = await json<ApiConversationEvent[]>(await req(`/api/conversations/${group.id}/events`, { token: dave.token }), 200)
    assert.ok(events.some((e) => e.action === 'member_added' && e.targetUserId === dave.user.id && e.actorId === alice.user.id))
    assert.ok(!events.some((e) => e.action === 'created'), 'events before joining are hidden')
    await daveGw.close()
    await carolGw.close()
  })

  test('renaming, owner-only removal, leaving and ownership transfer', async () => {
    const renamed = await json<ApiConversation>(await req(`/api/conversations/${group.id}`, { method: 'PATCH', token: bob.token, json: { name: 'Road trip' } }), 200)
    assert.equal(renamed.name, 'Road trip')
    // Only the owner removes people.
    assert.equal(await errorCode(await req(`/api/conversations/${group.id}/members/${dave.user.id}`, { method: 'DELETE', token: bob.token })), 'not_owner')

    const daveGw = gateway(dave.token)
    await ready(daveGw)
    assert.equal((await req(`/api/conversations/${group.id}/members/${dave.user.id}`, { method: 'DELETE', token: alice.token })).status, 204)
    await daveGw.waitFor((f) => f.op === 'conversation_remove' && f.d.channelId === group.id && f.d.reason === 'removed')
    assert.equal((await history(dave.token, group.id).catch(() => null)), null)
    assert.equal((await req(`/api/channels/${group.id}/messages`, { token: dave.token })).status, 404)
    const after = await sendOk(alice.token, group.id, 'dave is gone')
    await sleep(100)
    assert.ok(!daveGw.frames.some((f) => f.op === 'message_create' && f.d.id === after.id))

    // Re-added: a new boundary — he still can't see what was said while he was away.
    await req(`/api/conversations/${group.id}/members`, { method: 'POST', token: alice.token, json: { userId: dave.user.id } })
    assert.equal((await history(dave.token, group.id)).length, 0)

    // The owner leaves: the longest-standing remaining member becomes owner.
    assert.equal((await req(`/api/conversations/${group.id}/leave`, { method: 'POST', token: alice.token })).status, 204)
    const bobView = (await conversations(bob.token)).find((c) => c.id === group.id)
    assert.ok(bobView?.ownerId === bob.user.id || bobView?.ownerId === carol.user.id)
    assert.ok(!bobView?.memberIds.includes(alice.user.id))
    assert.equal((await req(`/api/channels/${group.id}/messages`, { token: alice.token })).status, 404)
    assert.ok(!(await conversations(alice.token)).some((c) => c.id === group.id))
  })

  test('groups are capped at 10 members', async () => {
    const extra: ApiAuthResult[] = []
    for (let i = 0; i < 9; i++) {
      const u = await register(`pal${i}`)
      await befriend(erin, u)
      extra.push(u)
    }
    const big = await json<ApiConversation>(await createGroup(erin.token, extra.slice(0, 8).map((u) => u.user.id)), 201)
    assert.equal(big.memberIds.length, 9)
    await json(await req(`/api/conversations/${big.id}/members`, { method: 'POST', token: erin.token, json: { userId: extra[8]!.user.id } }), 200)
    const eleventh = await register('pal-extra')
    await befriend(erin, eleventh)
    assert.equal(await errorCode(await req(`/api/conversations/${big.id}/members`, { method: 'POST', token: erin.token, json: { userId: eleventh.user.id } })), 'group_full')
    // Concurrent adds can't exceed the cap either.
    await req(`/api/conversations/${big.id}/members/${extra[8]!.user.id}`, { method: 'DELETE', token: erin.token })
    const results = await Promise.all(
      [extra[8]!, eleventh].map((u) => req(`/api/conversations/${big.id}/members`, { method: 'POST', token: erin.token, json: { userId: u.user.id } }))
    )
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
    assert.equal((await s.repo.listConversationMembers(big.id)).length, 10)
  })
})

// ======================================================================
describe('container security (release gate)', () => {
  test('the database itself refuses membership, ownership, invites and deletion of the container', async () => {
    const now = Date.now()
    await s.repo.addMember({ serverId: DIRECT_SERVER_ID, userId: alice.user.id, role: 'member', joinedAt: now })
    await s.repo.setOwner(DIRECT_SERVER_ID, alice.user.id, now)
    const raw = (s.repo as unknown as { db: DatabaseSync }).db
    // The same statements older server versions use (development sign-in, ownership recovery).
    raw.prepare("INSERT OR IGNORE INTO server_members (server_id, user_id, role, joined_at) VALUES ('@direct', ?, 'member', 1)").run(bob.user.id)
    raw.prepare("UPDATE server_members SET server_id = '@direct' WHERE server_id = 'hangout' AND user_id = ?").run(bob.user.id)
    raw.prepare("UPDATE servers SET owner_id = ? WHERE id = '@direct'").run(bob.user.id)
    raw.prepare("INSERT INTO server_invites (id, server_id, code_hash, created_by, created_at, expires_at, max_uses, uses) VALUES ('inv-x', '@direct', 'h', ?, 1, 9999999999999, 1, 0)").run(bob.user.id)
    assert.equal(Number(raw.prepare("SELECT COUNT(*) AS n FROM server_members WHERE server_id = '@direct'").get()?.n), 0)
    assert.equal(raw.prepare("SELECT owner_id FROM servers WHERE id = '@direct'").get()?.owner_id, null)
    assert.equal(Number(raw.prepare("SELECT COUNT(*) AS n FROM server_invites WHERE server_id = '@direct'").get()?.n), 0)
    assert.throws(() => raw.prepare("DELETE FROM servers WHERE id = '@direct'").run(), /cannot be deleted/)
    // Bob's real membership was untouched by the redirected update.
    assert.ok((await s.repo.membershipsForUser(bob.user.id)).some((m) => m.serverId === 'hangout'))
    assert.equal((await s.repo.integrityReport()).directContainerMembers, 0)
  })

  test('server owners, admins and instance administrators cannot reach a conversation through server tools', async () => {
    const dm = await json<ApiConversation>(await openDm(alice.token, bob.user.id), 200)
    const id = dm.id
    // root owns every server and is an instance administrator.
    const probes: [string, RequestInit & { json?: unknown }][] = [
      [`/api/channels/${id}/messages`, {}],
      [`/api/channels/${id}/pins`, {}],
      [`/api/channels/${id}/overrides`, {}],
      [`/api/channels/${id}/overrides/member`, { method: 'PUT', json: { allow: Permissions.viewChannel, deny: 0 } }],
      [`/api/channels/${id}`, { method: 'PATCH', json: { name: 'x' } }],
      [`/api/channels/${id}`, { method: 'DELETE' }],
      [`/api/search?q=hello&channelId=${id}`, {}],
      [`/api/search?q=hello&serverId=${encodeURIComponent(DIRECT_SERVER_ID)}`, {}],
      [`/api/servers/${encodeURIComponent(DIRECT_SERVER_ID)}/members`, {}],
      [`/api/servers/${encodeURIComponent(DIRECT_SERVER_ID)}/audit`, {}],
      [`/api/servers/${encodeURIComponent(DIRECT_SERVER_ID)}/invites`, { method: 'POST', json: {} }],
      [`/api/servers/${encodeURIComponent(DIRECT_SERVER_ID)}/channels`, { method: 'POST', json: { name: 'x', type: 'text' } }],
      [`/api/conversations/${id}/events`, {}]
    ]
    for (const [path, init] of probes) {
      const res = await req(path, { ...init, token: adminToken })
      assert.ok([400, 403, 404].includes(res.status), `${init.method ?? 'GET'} ${path} -> ${res.status}`)
      assert.notEqual(res.status, 200)
    }
    // Still nothing in the container, and the DM is intact for its members.
    assert.equal((await s.repo.integrityReport()).directContainerMembers, 0)
    assert.equal((await req(`/api/channels/${id}/messages`, { token: bob.token })).status, 200)
  })

  test('development sign-in (DEV_AUTH=true) never joins anyone to the container', async () => {
    const file = join(dir, 'devauth.db')
    const repo = new SqliteRepository(file)
    await repo.migrate()
    await seedIfEmpty(repo)
    const now = Date.now()
    for (const id of ['d-a', 'd-b']) {
      await repo.createUser({ id, username: id, displayName: id, avatarColor: '#123456', bot: false, createdAt: now })
    }
    const { conversation } = await repo.findOrCreateDm('d-a', 'd-b', now, 'dev-dm')
    await repo.createMessage({ channelId: conversation.channelId, authorId: 'd-a', content: 'private', createdAt: now, replyToId: null, attachmentIds: [] })
    const config = loadConfig({ NODE_ENV: 'test', DEV_AUTH: 'true', LOG_LEVEL: 'silent', ATTACHMENTS_DIR: attachmentsDir })
    const { app } = await buildApp(config, repo, { logger: false, hasher: HASHER, voiceReconcileIntervalMs: 0, attachmentCleanupIntervalMs: 0, statusExpiryIntervalMs: 0 })
    try {
      const res = await app.inject({ method: 'POST', url: '/api/dev/login', payload: { username: 'mallory' } })
      assert.equal(res.statusCode, 200, res.body)
      const token = (JSON.parse(res.body) as { token: string }).token
      const auth = { authorization: `${SCHEME} ${token}` }
      const listed = await app.inject({ url: '/api/servers', headers: auth })
      const servers = JSON.parse(listed.body) as ApiServer[]
      assert.ok(Array.isArray(servers) && servers.length > 0, `development sign-in still joins ordinary servers: ${listed.statusCode} ${listed.body.slice(0, 200)}`)
      assert.ok(!servers.some((x) => x.id === DIRECT_SERVER_ID))
      assert.equal((await app.inject({ url: '/api/channels/dev-dm/messages', headers: auth })).statusCode, 404)
      assert.equal((await repo.integrityReport()).directContainerMembers, 0)
    } finally {
      await app.close()
      await repo.close()
    }
  })

  test('newcomers do not learn who wrote only before they joined', async () => {
    const owner = await register('vis-owner', null)
    const early = await register('vis-early', null)
    const other = await register('vis-other', null)
    const late = await register('vis-late', null)
    for (const u of [early, other, late]) await befriend(owner, u)
    const group = await json<ApiConversation>(await createGroup(owner.token, [early.user.id, other.user.id]), 201)
    await sendOk(early.token, group.id, 'I was here first')
    await req(`/api/conversations/${group.id}/leave`, { method: 'POST', token: early.token })
    await req(`/api/conversations/${group.id}/members`, { method: 'POST', token: owner.token, json: { userId: late.user.id } })
    assert.equal((await req(`/api/users/${early.user.id}/profile`, { token: late.token })).status, 404)
    const users = await json<ApiUser[]>(await req('/api/users', { token: late.token }), 200)
    assert.ok(!users.some((u) => u.id === early.user.id))
    // Existing members still see them.
    assert.equal((await req(`/api/users/${early.user.id}/profile`, { token: other.token })).status, 200)
  })
})

// ======================================================================
describe('persistence and migration', () => {  test('relationships and conversations survive a backend restart', async () => {
    const before = await conversations(bob.token)
    const rels = await relationships(alice.token)
    const serverCount = (await s.repo.listServers()).length
    await stop(s)
    s = await start()
    assert.deepEqual((await conversations(bob.token)).map((c) => c.id), before.map((c) => c.id))
    assert.deepEqual(await relationships(alice.token), rels)
    // Seeding never runs again on a database that only gained the conversation container.
    assert.equal((await s.repo.listServers()).length, serverCount)
  })

  test('migration v5 is additive: a Milestone 9 database upgrades with nothing lost', async () => {
    const file = join(dir, 'm9.db')
    const db = new DatabaseSync(file)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
    for (const m of sqliteMigrations.filter((x) => x.version <= 4)) {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, 1)
    }
    db.prepare("INSERT INTO users (id, username, display_name, avatar_color, is_bot, created_at, instance_admin) VALUES ('u1', 'thereallsaint', 'Saint', '#6d72f6', 0, 1000, 1)").run()
    db.prepare("INSERT INTO users (id, username, display_name, avatar_color, is_bot, created_at, bio) VALUES ('u2', 'lsaint06', 'L', '#3ba776', 0, 2000, 'hi')").run()
    db.prepare("INSERT INTO servers (id, name, color, owner_id, position, created_at) VALUES ('s1', 'Home', '#111111', 'u1', 0, 1)").run()
    db.prepare("INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES ('s1', 'u1', 'owner', 1), ('s1', 'u2', 'member', 1)").run()
    db.prepare("INSERT INTO channels (id, server_id, name, type, topic, category, position, created_at) VALUES ('c1', 's1', 'general', 'text', NULL, 'Text', 0, 1)").run()
    db.prepare("INSERT INTO messages (channel_id, author_id, content, created_at) VALUES ('c1', 'u2', 'hello from M9', 5)").run()
    db.prepare("INSERT INTO read_states (user_id, channel_id, last_read_id, updated_at) VALUES ('u1', 'c1', 1, 6)").run()
    db.close()

    const repo = new SqliteRepository(file)
    await repo.migrate()
    await repo.migrate()
    assert.equal((await repo.getUser('u2'))?.bio, 'hi')
    assert.equal((await repo.getUser('u2'))?.allowServerDms, true)
    assert.equal((await repo.listMessages('c1', { limit: 10 }))[0]?.content, 'hello from M9')
    assert.deepEqual((await repo.listServers()).map((x) => x.id), ['s1'])
    assert.equal(await repo.countServers(), 1)
    assert.deepEqual((await repo.listChannels()).map((c) => c.id), ['c1'])
    assert.equal(await repo.getServer(DIRECT_SERVER_ID), undefined)
    assert.equal((await repo.integrityReport()).serversWithoutOwner.length, 0)
    assert.equal((await repo.readStates('u1', ['c1'], Date.now(), 99))[0]?.lastReadId, '1')
    assert.equal(await seedIfEmpty(repo), false, 'an existing install is not re-seeded')

    // The upgraded database supports the new features.
    await repo.sendFriendRequest('u1', 'u2', 10)
    assert.equal(await repo.acceptFriendRequest('u2', 'u1', 11), true)
    const { conversation } = await repo.findOrCreateDm('u1', 'u2', 12, 'dm-1')
    assert.equal(conversation.kind, 'dm')
    assert.ok(!(await repo.listChannels()).some((c) => c.id === 'dm-1'))

    const raw = (repo as unknown as { db: DatabaseSync }).db
    const versions = raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version))
    assert.deepEqual(versions, sqliteMigrations.map((m) => m.version))
    assert.equal(raw.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')
    assert.equal(raw.prepare('PRAGMA foreign_key_check').all().length, 0)
    await repo.close()
  })

  test('a fresh database still seeds its starter servers', async () => {
    const repo = new SqliteRepository(join(dir, 'fresh.db'))
    try {
      await repo.migrate()
      assert.equal(await seedIfEmpty(repo), true)
      const servers = await repo.listServers()
      assert.ok(servers.length > 0)
      assert.ok(!servers.some((x) => x.id === DIRECT_SERVER_ID))
      assert.equal(await repo.countServers(), servers.length)
    } finally {
      await repo.close()
    }
  })
})
