/**
 * Milestone 14 tests: private saved messages (bookmarks) and private personal notes — privacy,
 * visibility rules, limits, sync to your own sessions only, and the additive migrations.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { HashGate, OWASP_MINIMUM, PasswordHasher } from '../src/auth/password.js'
import { loadConfig } from '../src/config.js'
import type { AppContext } from '../src/context.js'
import { seedIfEmpty } from '../src/db/seed.js'
import { SqliteRepository } from '../src/db/sqlite.js'
import { TokenBucketLimiter } from '../src/lib/rateLimit.js'
import { normalizeUserNote } from '../src/routes/personal.js'
import type {
  ApiAuthResult,
  ApiMessage,
  ApiSavedMessage,
  ApiServer,
  ApiUserNote,
  GatewayServerFrame
} from '../src/protocol.js'

const SCHEME = ['Bea', 'rer'].join('')
const HASHER = new PasswordHasher(OWASP_MINIMUM, new HashGate(4, 64))
const PASSWORD = 'violet-anchor-sunrise-42'
const dir = mkdtempSync(join(tmpdir(), 'd2-personal-'))

let app: FastifyInstance
let ctx: AppContext
let repo: SqliteRepository
let base = ''
let admin: ApiAuthResult
let alice: ApiAuthResult
let bob: ApiAuthResult
let loner: ApiAuthResult
let generalId = ''

function req(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (init.token) headers.Authorization = `${SCHEME} ${init.token}`
  if (init.json !== undefined) headers['Content-Type'] = 'application/json'
  return fetch(`${base}${path}`, {
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

const code = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code

async function login(username: string): Promise<ApiAuthResult> {
  return json(await req('/api/auth/login', { method: 'POST', json: { username, password: PASSWORD } }), 200)
}

async function register(username: string, serverId: string | null): Promise<ApiAuthResult> {
  const invite = await json<{ code: string }>(
    await req('/api/admin/registration-invites', { method: 'POST', token: admin.token, json: { password: PASSWORD, serverId } }),
    201
  )
  return json(
    await req('/api/auth/register', {
      method: 'POST',
      json: { code: invite.code, username, displayName: username, password: PASSWORD }
    }),
    201
  )
}

let nonce = 0
const post = async (token: string, content: string) =>
  json<ApiMessage>(
    await req(`/api/channels/${generalId}/messages`, { method: 'POST', token, json: { content, nonce: `n${++nonce}` } }),
    201
  )
const save = (token: string, id: string) => req(`/api/saved-messages/${id}`, { method: 'PUT', token })
const unsave = (token: string, id: string) => req(`/api/saved-messages/${id}`, { method: 'DELETE', token })
const savedList = async (token: string) => json<ApiSavedMessage[]>(await req('/api/saved-messages', { token }), 200)

function gateway(token: string) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/gateway')
  const frames: GatewayServerFrame[] = []
  const ready = new Promise<void>((resolve) => {
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as GatewayServerFrame
      frames.push(frame)
      if (frame.op === 'hello') ws.send(JSON.stringify({ op: 'identify', d: { token } }))
      if (frame.op === 'ready') resolve()
    })
  })
  return { ws, frames, ready, close: () => ws.close() }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  repo = new SqliteRepository(join(dir, 'personal.db'))
  await repo.migrate()
  await seedIfEmpty(repo)
  const config = loadConfig({
    NODE_ENV: 'test',
    DEV_AUTH: 'false',
    LOG_LEVEL: 'silent',
    ATTACHMENTS_DIR: join(dir, 'attachments'),
    UPLOAD_MIN_FREE_DISK_MB: '1'
  })
  ;({ app, ctx } = await buildApp(config, repo, {
    logger: false,
    hasher: HASHER,
    voiceReconcileIntervalMs: 0,
    attachmentCleanupIntervalMs: 0,
    statusExpiryIntervalMs: 0
  }))
  for (const name of Object.keys(ctx.limiters) as (keyof AppContext['limiters'])[]) {
    ctx.limiters[name].dispose()
    ctx.limiters[name] = new TokenBucketLimiter(10_000, 1_000)
  }
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  base = `http://127.0.0.1:${address.port}`
  const now = Date.now()
  const root = await repo.provisionAccount(
    { id: 'admin-1', username: 'root', displayName: 'Root', avatarColor: '#111111', bot: false, createdAt: now },
    await HASHER.hash(PASSWORD),
    now
  )
  for (const server of await repo.listServers()) await repo.setOwner(server.id, root.id, now)
  admin = await login('root')
  alice = await register('alice', 'hangout')
  bob = await register('bob', 'hangout')
  loner = await register('loner', null)
  const servers = await json<ApiServer[]>(await req('/api/servers', { token: alice.token }), 200)
  generalId = servers.find((s) => s.id === 'hangout')!.channels.find((c) => c.type === 'text')!.id
})

after(async () => {
  await app.close()
  await repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('server support', () => {
  test('meta advertises both features; migrations 11 and 12 are applied', async () => {
    const meta = await json<Record<string, unknown>>(await req('/api/meta'), 200)
    assert.equal(meta.savedMessages, true)
    assert.equal(meta.userNotes, true)
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'personal.db'), { readOnly: true })
    const names = db.prepare('SELECT name FROM schema_migrations WHERE version IN (11, 12) ORDER BY version').all()
    db.close()
    assert.deepEqual(
      names.map((r) => r.name),
      ['saved_messages', 'user_notes']
    )
  })
})

describe('saved messages', () => {
  test('save what you can read; the list is yours only, newest first; saving twice keeps the time', async () => {
    const first = await post(bob.token, 'Remember: the party is on Friday')
    const second = await post(alice.token, 'Recipe link for later')
    const a = await json<{ messageId: string; saved: boolean; savedAt: number }>(await save(alice.token, first.id), 200)
    assert.equal(a.saved, true)
    await sleep(5)
    await json(await save(alice.token, second.id), 200)
    const again = await json<{ savedAt: number }>(await save(alice.token, first.id), 200)
    assert.equal(again.savedAt, a.savedAt)

    const list = await savedList(alice.token)
    assert.deepEqual(
      list.map((s) => s.message.id),
      [second.id, first.id]
    )
    assert.equal(list[1].serverId, 'hangout')
    assert.equal(list[1].message.content, 'Remember: the party is on Friday')
    assert.equal(list[1].savedAt, a.savedAt)
    // Private: Bob doesn't see Alice's saved messages.
    assert.deepEqual(await savedList(bob.token), [])
  })

  test('messages you can’t read are “not found”; bad ids are refused', async () => {
    const msg = await post(alice.token, 'Members only')
    const outsider = await save(loner.token, msg.id)
    assert.equal(outsider.status, 404)
    assert.equal((await save(alice.token, '999999999')).status, 404)
    assert.equal((await save(alice.token, 'abc')).status, 400)
    assert.equal((await save(alice.token, '1; DROP TABLE messages')).status, 400)
  })

  test('after leaving a server its messages are hidden but kept; deleting a message removes it', async () => {
    const msg = await post(alice.token, 'Bob should keep this one')
    await json(await save(bob.token, msg.id), 200)
    assert.equal((await savedList(bob.token)).length, 1)

    await json(await req('/api/servers/hangout/leave', { method: 'POST', token: bob.token }), 204)
    assert.deepEqual(await savedList(bob.token), [])
    const invite = await json<{ code: string }>(
      await req('/api/servers/hangout/invites', { method: 'POST', token: admin.token, json: {} }),
      201
    )
    await json(await req('/api/invites/accept', { method: 'POST', token: bob.token, json: { code: invite.code } }), 200)
    assert.deepEqual(
      (await savedList(bob.token)).map((s) => s.message.id),
      [msg.id]
    )

    await json(await req(`/api/channels/${generalId}/messages/${msg.id}`, { method: 'DELETE', token: alice.token }), 204)
    assert.deepEqual(await savedList(bob.token), [])
    assert.deepEqual(await repo.listSavedMessages(bob.user.id), [])
  })

  test('removing always works, even for a message you can no longer read', async () => {
    const msg = await post(alice.token, 'Short-lived access')
    await json(await save(bob.token, msg.id), 200)
    await json(await req('/api/servers/hangout/leave', { method: 'POST', token: bob.token }), 204)
    assert.equal((await unsave(bob.token, msg.id)).status, 204)
    assert.deepEqual(await repo.listSavedMessages(bob.user.id), [])
    const invite = await json<{ code: string }>(
      await req('/api/servers/hangout/invites', { method: 'POST', token: admin.token, json: {} }),
      201
    )
    await json(await req('/api/invites/accept', { method: 'POST', token: bob.token, json: { code: invite.code } }), 200)
  })

  test('your other sessions hear about it; nobody else does', async () => {
    const msg = await post(bob.token, 'Sync me')
    const a1 = gateway(alice.token)
    const a2 = gateway(alice.token)
    const b = gateway(bob.token)
    await Promise.all([a1.ready, a2.ready, b.ready])
    await json(await save(alice.token, msg.id), 200)
    assert.equal((await unsave(alice.token, msg.id)).status, 204)
    await sleep(150)
    const updates = (frames: GatewayServerFrame[]) =>
      frames.flatMap((f) => (f.op === 'saved_message_update' ? [{ id: f.d.messageId, saved: f.d.saved }] : []))
    for (const session of [a1, a2]) {
      assert.deepEqual(updates(session.frames), [
        { id: msg.id, saved: true },
        { id: msg.id, saved: false }
      ])
    }
    assert.deepEqual(updates(b.frames), [])
    for (const s of [a1, a2, b]) s.close()
  })

  test('each person can keep a bounded number (checked atomically)', async () => {
    const ids = [(await post(alice.token, 'one')).id, (await post(alice.token, 'two')).id, (await post(alice.token, 'three')).id]
    const now = Date.now()
    assert.equal((await repo.saveMessage(loner.user.id, ids[0], now, 2)).result, 'ok')
    assert.equal((await repo.saveMessage(loner.user.id, ids[1], now, 2)).result, 'ok')
    assert.equal((await repo.saveMessage(loner.user.id, ids[2], now, 2)).result, 'limit')
    // Re-saving one you already have is not blocked by the limit.
    assert.equal((await repo.saveMessage(loner.user.id, ids[0], now + 1, 2)).result, 'ok')
    assert.equal((await repo.listSavedMessages(loner.user.id)).length, 2)
  })
})

describe('personal notes', () => {
  const getNote = async (token: string, userId: string) =>
    json<ApiUserNote>(await req(`/api/users/${userId}/note`, { token }), 200)
  const putNote = (token: string, userId: string, note: unknown) =>
    req(`/api/users/${userId}/note`, { method: 'PUT', token, json: { note } })

  test('only the author can read a note', async () => {
    assert.deepEqual(await getNote(alice.token, bob.user.id), { userId: bob.user.id, note: '', updatedAt: null })
    const saved = await json<ApiUserNote>(await putNote(alice.token, bob.user.id, '  Owes me a pizza 🍕  '), 200)
    assert.equal(saved.note, 'Owes me a pizza 🍕')
    assert.ok(saved.updatedAt)
    assert.equal((await getNote(alice.token, bob.user.id)).note, 'Owes me a pizza 🍕')
    // Bob reads his own (empty) notes; there is no way to read Alice's.
    assert.equal((await getNote(bob.token, bob.user.id)).note, '')
    assert.equal((await getNote(bob.token, alice.user.id)).note, '')
    // Notes never appear in profiles or user objects.
    const profile = await json<Record<string, unknown>>(await req(`/api/users/${bob.user.id}/profile`, { token: bob.token }), 200)
    assert.ok(!JSON.stringify(profile).includes('pizza'))
  })

  test('only about people you can see; length and control characters are checked', async () => {
    assert.equal((await req(`/api/users/${alice.user.id}/note`, { token: loner.token })).status, 404)
    assert.equal((await putNote(loner.token, alice.user.id, 'hi')).status, 404)
    assert.equal((await putNote(alice.token, 'nobody', 'hi')).status, 404)

    const tooLong = await putNote(alice.token, bob.user.id, 'x'.repeat(257))
    assert.equal(tooLong.status, 400)
    assert.equal(await code(tooLong), 'invalid_note')
    assert.equal((await putNote(alice.token, bob.user.id, 42)).status, 400)
    // 256 characters is fine even when each is two UTF-16 units.
    assert.equal((await json<ApiUserNote>(await putNote(alice.token, bob.user.id, '🎲'.repeat(256)), 200)).note.length, 512)
    assert.equal(normalizeUserNote('a\r\nb\u0007\u0000c\td'), 'a\nbcd')
    // Clearing: whitespace only removes the note.
    const cleared = await json<ApiUserNote>(await putNote(alice.token, bob.user.id, '   '), 200)
    assert.deepEqual(cleared, { userId: bob.user.id, note: '', updatedAt: null })
    assert.equal(await repo.getUserNote(alice.user.id, bob.user.id), undefined)
  })

  test('changes reach your other sessions only', async () => {
    const a = gateway(alice.token)
    const b = gateway(bob.token)
    await Promise.all([a.ready, b.ready])
    await json(await putNote(alice.token, bob.user.id, 'Met at the LAN party'), 200)
    await sleep(150)
    const notes = (frames: GatewayServerFrame[]) => frames.filter((f) => f.op === 'user_note_update')
    assert.equal(notes(a.frames).length, 1)
    assert.equal(notes(b.frames).length, 0)
    a.close()
    b.close()
  })
})
