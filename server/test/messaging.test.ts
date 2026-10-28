import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import type { AppContext } from '../src/context.js'
import { sqliteMigrations } from '../src/db/migrations.js'
import { seedIfEmpty } from '../src/db/seed.js'
import { SqliteRepository } from '../src/db/sqlite.js'
import { imageSize, sanitizeFilename, typeForFilename } from '../src/attachments/fileTypes.js'
import { cleanupAttachments } from '../src/routes/attachments.js'
import { buildSearchMatch, normalizeEmoji } from '../src/lib/validation.js'
import { TokenBucketLimiter } from '../src/lib/rateLimit.js'
import type {
  ApiAttachment,
  ApiMessage,
  ApiReadState,
  ApiSearchResult,
  GatewayServerFrame
} from '../src/protocol.js'

const dir = mkdtempSync(join(tmpdir(), 'd2-msg2-'))
const dbFile = join(dir, 'test.db')
const attachmentsDir = join(dir, 'attachments')
const config = loadConfig({
  NODE_ENV: 'test',
  DEV_AUTH: 'true',
  LOG_LEVEL: 'silent',
  DATABASE_URL: `sqlite:${dbFile}`,
  ATTACHMENTS_DIR: attachmentsDir,
  UPLOAD_MAX_IMAGE_MB: '1',
  UPLOAD_MAX_FILE_MB: '2',
  UPLOAD_MAX_REQUEST_MB: '2',
  // The test volume may be small; don't let the free-space guard interfere.
  UPLOAD_MIN_FREE_DISK_MB: '1'
})

interface Server {
  app: FastifyInstance
  ctx: AppContext
  repo: SqliteRepository
  base: string
}

async function start(): Promise<Server> {
  const repo = new SqliteRepository(dbFile)
  await repo.migrate()
  await seedIfEmpty(repo)
  const { app, ctx } = await buildApp(config, repo, {
    logger: false,
    attachmentCleanupIntervalMs: 0
  })
  // This suite signs in many users from one IP; the per-IP limits have their own tests.
  ctx.limiters.loginPerIp.dispose()
  ctx.limiters.apiPerIp.dispose()
  ctx.limiters.searchPerUser.dispose()
  ctx.limiters.loginPerIp = new TokenBucketLimiter(10_000, 1_000)
  ctx.limiters.apiPerIp = new TokenBucketLimiter(10_000, 1_000)
  ctx.limiters.searchPerUser = new TokenBucketLimiter(100, 100)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return { app, ctx, repo, base: `http://127.0.0.1:${address.port}` }
}

let server: Server

async function login(username: string): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${server.base}/api/dev/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { token: string; user: { id: string } }
  return { token: body.token, userId: body.user.id }
}

function api(token: string, path: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init
  return fetch(`${server.base}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...rest.headers
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body
  })
}

/** A minimal PNG: signature + IHDR (enough for type/dimension sniffing), padded to `size`. */
function png(width: number, height: number, size = 64): Uint8Array {
  const buf = new Uint8Array(Math.max(size, 33))
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(buf.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return buf
}

async function upload(
  token: string,
  channelId: string,
  files: { name: string; data: Uint8Array | string }[]
): Promise<Response> {
  const form = new FormData()
  for (const f of files) form.append('file', new Blob([f.data]), f.name)
  return api(token, `/api/channels/${channelId}/attachments`, { method: 'POST', body: form })
}

async function send(
  token: string,
  channelId: string,
  body: { content?: string; replyToId?: string; attachmentIds?: string[] }
): Promise<ApiMessage> {
  const res = await api(token, `/api/channels/${channelId}/messages`, { method: 'POST', json: body })
  assert.equal(res.status, 201, await res.clone().text())
  return (await res.json()) as ApiMessage
}

async function history(token: string, channelId: string, query = ''): Promise<ApiMessage[]> {
  const res = await api(token, `/api/channels/${channelId}/messages${query}`)
  assert.equal(res.status, 200)
  return (await res.json()) as ApiMessage[]
}

function gateway(token: string) {
  const ws = new WebSocket(server.base.replace('http', 'ws') + '/gateway')
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
  return { ws, frames, waitFor, ready: waitFor((f) => f.op === 'ready') }
}

const storedFiles = (): string[] =>
  existsSync(join(attachmentsDir, 'files'))
    ? readdirSync(join(attachmentsDir, 'files')).flatMap((shard) =>
        readdirSync(join(attachmentsDir, 'files', shard))
      )
    : []

describe('Messaging 2.0', () => {
  before(async () => {
    server = await start()
  })

  after(async () => {
    await server.app.close()
    await server.repo.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // ---------- Attachments ----------

  test('accepts allowed files and reports image dimensions', async () => {
    const { token } = await login('up-alice')
    const res = await upload(token, 'hangout-general', [
      { name: 'shot.png', data: png(1920, 1080) },
      { name: 'notes.txt', data: 'hello' }
    ])
    assert.equal(res.status, 201)
    const files = (await res.json()) as ApiAttachment[]
    assert.equal(files.length, 2)
    assert.deepEqual(
      { kind: files[0]!.kind, type: files[0]!.contentType, w: files[0]!.width, h: files[0]!.height },
      { kind: 'image', type: 'image/png', w: 1920, h: 1080 }
    )
    assert.deepEqual({ kind: files[1]!.kind, type: files[1]!.contentType }, { kind: 'file', type: 'text/plain' })
  })

  test('rejects disallowed extensions and spoofed content', async () => {
    const { token } = await login('up-bob')
    for (const name of ['run.exe', 'page.html', 'icon.svg', 'script.js', 'noext']) {
      const res = await upload(token, 'hangout-general', [{ name, data: 'x' }])
      assert.equal(res.status, 415, name)
    }
    // A text file renamed to .png does not pass the signature check.
    const spoofed = await upload(token, 'hangout-general', [{ name: 'fake.png', data: '<script>' }])
    assert.equal(spoofed.status, 415)
    // Binary data posing as text.
    const binary = await upload(token, 'hangout-general', [{ name: 'x.txt', data: new Uint8Array([0, 1, 2]) }])
    assert.equal(binary.status, 415)
    assert.equal((await upload(token, 'hangout-lounge', [{ name: 'a.txt', data: 'x' }])).status, 400)
  })

  test('enforces per-type size limits and the per-request aggregate', async () => {
    const { token, userId } = await login('up-carol')
    const bigImage = await upload(token, 'hangout-general', [
      { name: 'big.png', data: png(100, 100, 1.5 * 1024 * 1024) }
    ])
    assert.equal(bigImage.status, 413)
    assert.equal(((await bigImage.json()) as { error: { code: string } }).error.code, 'file_too_large')

    const before = (await server.repo.attachmentUsage(userId)).pendingCount
    const chunk = 'a'.repeat(900 * 1024)
    const aggregate = await upload(token, 'hangout-general', [
      { name: '1.txt', data: chunk },
      { name: '2.txt', data: chunk },
      { name: '3.txt', data: chunk }
    ])
    assert.equal(aggregate.status, 413)
    // Nothing from the rejected request is kept.
    assert.equal((await server.repo.attachmentUsage(userId)).pendingCount, before)
    const pixels = await upload(token, 'hangout-general', [{ name: 'huge.png', data: png(20000, 20000) }])
    assert.equal(pixels.status, 413)
  })

  test('only the uploader sees an unsent file; everyone sees it once sent', async () => {
    const alice = await login('acl-alice')
    const bob = await login('acl-bob')
    const [file] = (await (await upload(alice.token, 'hangout-general', [{ name: 'a.png', data: png(4, 4) }])).json()) as ApiAttachment[]
    assert.equal((await fetch(`${server.base}/api/attachments/${file!.id}`)).status, 401)
    assert.equal((await api(bob.token, `/api/attachments/${file!.id}`)).status, 404)
    // Bob can't attach (claim) Alice's upload to his own message, nor cancel it.
    const claim = await api(bob.token, '/api/channels/hangout-general/messages', {
      method: 'POST',
      json: { content: 'mine now', attachmentIds: [file!.id] }
    })
    assert.equal(claim.status, 409)
    assert.equal((await api(bob.token, `/api/attachments/${file!.id}`, { method: 'DELETE' })).status, 404)

    await send(alice.token, 'hangout-general', { attachmentIds: [file!.id] })
    const res = await api(bob.token, `/api/attachments/${file!.id}`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.match(res.headers.get('content-disposition') ?? '', /^inline;/)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/)
    const dl = await api(bob.token, `/api/attachments/${file!.id}?download=1`)
    assert.match(dl.headers.get('content-disposition') ?? '', /^attachment;/)
  })

  test('non-image files are always downloaded, never rendered', async () => {
    const { token } = await login('dl-erin')
    const [file] = (await (await upload(token, 'hangout-general', [{ name: 'doc.pdf', data: '%PDF-1.7 test' }])).json()) as ApiAttachment[]
    const res = await api(token, `/api/attachments/${file!.id}`)
    assert.equal(res.headers.get('content-type'), 'application/pdf')
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment;/)
  })

  test('blocks path traversal and sanitizes file names', async () => {
    const { token } = await login('trav-frank')
    for (const id of ['..%2F..%2Fetc%2Fpasswd', '..\\..\\x', 'ABCDEF', 'a'.repeat(33)]) {
      const res = await api(token, `/api/attachments/${id}`)
      assert.ok([400, 404].includes(res.status), `${id} -> ${res.status}`)
    }
    const res = await upload(token, 'hangout-general', [{ name: '../../evil\u202E.png', data: png(2, 2) }])
    const [file] = (await res.json()) as ApiAttachment[]
    assert.equal(file!.filename, 'evil_.png')
    assert.ok(storedFiles().includes(file!.id), 'stored under its opaque id')
    assert.equal(sanitizeFilename('C:\\Windows\\system32\\a.txt'), 'a.txt')
    assert.equal(sanitizeFilename('...'), 'file')
  })

  test('cancelling an upload removes it; a sent attachment cannot be cancelled', async () => {
    const { token } = await login('cancel-gina')
    const [a] = (await (await upload(token, 'hangout-general', [{ name: 'a.txt', data: 'a' }])).json()) as ApiAttachment[]
    assert.equal((await api(token, `/api/attachments/${a!.id}`, { method: 'DELETE' })).status, 204)
    assert.ok(!storedFiles().includes(a!.id))
    const [b] = (await (await upload(token, 'hangout-general', [{ name: 'b.txt', data: 'b' }])).json()) as ApiAttachment[]
    await send(token, 'hangout-general', { attachmentIds: [b!.id] })
    assert.equal((await api(token, `/api/attachments/${b!.id}`, { method: 'DELETE' })).status, 400)
  })

  // ---------- Edit / delete ----------

  test('only the author can edit; edits keep createdAt and broadcast', async () => {
    const alice = await login('edit-alice')
    const bob = await login('edit-bob')
    const gwBob = gateway(bob.token)
    await gwBob.ready
    const msg = await send(alice.token, 'hangout-memes', { content: 'first draft' })
    const path = `/api/channels/hangout-memes/messages/${msg.id}`

    assert.equal((await api(bob.token, path, { method: 'PATCH', json: { content: 'hacked' } })).status, 403)
    const res = await api(alice.token, path, { method: 'PATCH', json: { content: 'final', expectedEditedAt: null } })
    assert.equal(res.status, 200)
    const edited = (await res.json()) as ApiMessage
    assert.equal(edited.content, 'final')
    assert.equal(edited.createdAt, msg.createdAt)
    assert.ok(edited.editedAt && edited.editedAt >= msg.createdAt)

    const frame = await gwBob.waitFor((f) => f.op === 'message_update' && f.d.id === msg.id)
    assert.equal(frame.op === 'message_update' && frame.d.content, 'final')

    // Concurrent edit: the client's view (never edited) is stale now.
    const stale = await api(alice.token, path, { method: 'PATCH', json: { content: 'again', expectedEditedAt: null } })
    assert.equal(stale.status, 409)
    assert.equal((await api(alice.token, path, { method: 'PATCH', json: { content: '   ' } })).status, 400)
    // Wrong channel for the message id.
    const wrong = await api(alice.token, `/api/channels/hangout-music/messages/${msg.id}`, { method: 'PATCH', json: { content: 'x' } })
    assert.equal(wrong.status, 404)
    gwBob.ws.close()
  })

  test('only the author can delete; deletion broadcasts and removes attachments', async () => {
    const alice = await login('del-alice')
    const bob = await login('del-bob')
    const gwBob = gateway(bob.token)
    await gwBob.ready
    const [file] = (await (await upload(alice.token, 'hangout-memes', [{ name: 'p.png', data: png(8, 8) }])).json()) as ApiAttachment[]
    const msg = await send(alice.token, 'hangout-memes', { content: 'temporary', attachmentIds: [file!.id] })
    const path = `/api/channels/hangout-memes/messages/${msg.id}`
    assert.equal((await api(bob.token, path, { method: 'DELETE' })).status, 403)
    assert.equal((await api(alice.token, path, { method: 'DELETE' })).status, 204)
    await gwBob.waitFor((f) => f.op === 'message_delete' && f.d.id === msg.id)
    assert.ok(!(await history(bob.token, 'hangout-memes')).some((m) => m.id === msg.id))
    assert.equal((await api(bob.token, `/api/attachments/${file!.id}`)).status, 404)
    assert.ok(!storedFiles().includes(file!.id), 'file removed from disk')
    assert.equal((await api(alice.token, path, { method: 'DELETE' })).status, 404)
    gwBob.ws.close()
  })

  // ---------- Replies ----------

  test('replies reference same-channel messages and survive parent deletion', async () => {
    const alice = await login('reply-alice')
    const bob = await login('reply-bob')
    const parent = await send(alice.token, 'hangout-music', { content: 'what should we play?' })
    const reply = await send(bob.token, 'hangout-music', { content: 'rocket league', replyToId: parent.id })
    assert.deepEqual(
      { id: reply.replyTo?.id, deleted: reply.replyTo?.deleted, author: reply.replyTo?.authorId },
      { id: parent.id, deleted: false, author: alice.userId }
    )
    const cross = await api(bob.token, '/api/channels/hangout-memes/messages', {
      method: 'POST',
      json: { content: 'x', replyToId: parent.id }
    })
    assert.equal(cross.status, 400)

    await api(alice.token, `/api/channels/hangout-music/messages/${parent.id}`, { method: 'DELETE' })
    const after = (await history(bob.token, 'hangout-music')).find((m) => m.id === reply.id)
    assert.deepEqual(after?.replyTo, { id: parent.id, deleted: true })
    const late = await api(bob.token, '/api/channels/hangout-music/messages', {
      method: 'POST',
      json: { content: 'too late', replyToId: parent.id }
    })
    assert.equal(late.status, 400)
  })

  // ---------- Reactions ----------

  test('reactions toggle, never duplicate, sync in real time and persist', async () => {
    const alice = await login('react-alice')
    const bob = await login('react-bob')
    const gwAlice = gateway(alice.token)
    await gwAlice.ready
    const msg = await send(alice.token, 'hangout-general', { content: 'react to me' })
    const path = (emoji: string) =>
      `/api/channels/hangout-general/messages/${msg.id}/reactions/${encodeURIComponent(emoji)}`

    for (let i = 0; i < 2; i++) assert.equal((await api(bob.token, path('🔥'), { method: 'PUT' })).status, 200)
    await api(alice.token, path('🔥'), { method: 'PUT' })
    await api(alice.token, path('👍🏽'), { method: 'PUT' })
    const frame = await gwAlice.waitFor((f) => f.op === 'reaction_update' && f.d.userId === bob.userId)
    assert.equal(frame.op === 'reaction_update' && frame.d.count, 1)

    let view = (await history(bob.token, 'hangout-general')).find((m) => m.id === msg.id)!
    assert.deepEqual(view.reactions, [
      { emoji: '🔥', count: 2, me: true },
      { emoji: '👍🏽', count: 1, me: false }
    ])
    await api(bob.token, path('🔥'), { method: 'DELETE' })
    await api(bob.token, path('🔥'), { method: 'DELETE' })
    view = (await history(bob.token, 'hangout-general')).find((m) => m.id === msg.id)!
    assert.deepEqual(view.reactions?.[0], { emoji: '🔥', count: 1, me: false })

    for (const bad of ['a', 'hello', '123', '<b>', '🔥 🔥']) {
      assert.equal((await api(bob.token, path(bad), { method: 'PUT' })).status, 400, bad)
    }
    gwAlice.ws.close()
  })

  test('limits distinct reactions per message', async () => {
    const { token, userId } = await login('react-limit')
    const msg = await send(token, 'hangout-welcome', { content: 'many reactions' })
    const emoji = [...'😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙😚🙂🤗'] // 20
    for (const e of emoji) await server.repo.addReaction(msg.id, e, userId, Date.now(), 20)
    const res = await api(token, `/api/channels/hangout-welcome/messages/${msg.id}/reactions/${encodeURIComponent('🎉')}`, { method: 'PUT' })
    assert.equal(res.status, 400)
    assert.equal(normalizeEmoji('🇺🇸'), '🇺🇸')
    assert.equal(normalizeEmoji('1️⃣'), '1️⃣')
    assert.equal(normalizeEmoji('👨‍👩‍👧'), '👨‍👩‍👧')
  })

  // ---------- Pins ----------

  test('pins: add, list, remove, broadcast; channel-bound', async () => {
    const alice = await login('pin-alice')
    const bob = await login('pin-bob')
    const gwBob = gateway(bob.token)
    await gwBob.ready
    const msg = await send(alice.token, 'hangout-announcements', { content: 'pin me' })
    // Milestone 7: pinning needs Pin Messages (moderators by default), not just membership.
    assert.equal((await api(alice.token, `/api/channels/hangout-announcements/pins/${msg.id}`, { method: 'PUT' })).status, 403)
    await server.repo.setMemberRole('hangout', alice.userId, 'moderator')
    await server.repo.setMemberRole('hangout', bob.userId, 'moderator')
    assert.equal((await api(alice.token, `/api/channels/hangout-announcements/pins/${msg.id}`, { method: 'PUT' })).status, 200)
    await gwBob.waitFor((f) => f.op === 'pin_update' && f.d.messageId === msg.id && f.d.pinned)
    const pins = (await (await api(bob.token, '/api/channels/hangout-announcements/pins')).json()) as ApiMessage[]
    assert.equal(pins[0]?.id, msg.id)
    assert.equal(pins[0]?.pinned, true)
    // Wrong channel.
    assert.equal((await api(bob.token, `/api/channels/hangout-general/pins/${msg.id}`, { method: 'PUT' })).status, 404)
    assert.equal((await api(bob.token, `/api/channels/hangout-announcements/pins/${msg.id}`, { method: 'DELETE' })).status, 200)
    const after = (await (await api(bob.token, '/api/channels/hangout-announcements/pins')).json()) as ApiMessage[]
    assert.equal(after.length, 0)
    gwBob.ws.close()
  })

  // ---------- Search ----------

  test('search: full text, filters, pagination and injection-safe queries', async () => {
    const alice = await login('search-alice')
    const bob = await login('search-bob')
    for (let i = 0; i < 4; i++) await send(alice.token, 'hangout-general', { content: `banana split ${i}` })
    await send(bob.token, 'hangout-memes', { content: 'Banana memes' })
    const search = async (qs: string) => {
      const res = await api(alice.token, `/api/search?${qs}`)
      assert.equal(res.status, 200, await res.clone().text())
      return (await res.json()) as ApiSearchResult
    }

    const all = await search('q=banan')
    assert.equal(all.messages.length, 5, 'prefix match across channels')
    const scoped = await search('q=banana&channelId=hangout-general')
    assert.equal(scoped.messages.length, 4)
    const byBob = await search(`q=banana&authorId=${bob.userId}`)
    assert.deepEqual(byBob.messages.map((m) => m.content), ['Banana memes'])

    const page1 = await search('q=banana&channelId=hangout-general&limit=3')
    assert.equal(page1.messages.length, 3)
    assert.ok(page1.nextBefore)
    const page2 = await search(`q=banana&channelId=hangout-general&limit=3&before=${page1.nextBefore}`)
    assert.equal(page2.messages.length, 1)
    assert.equal(page2.nextBefore, null)

    // FTS operators and SQL in user input are inert.
    for (const q of ['" OR 1=1 --', 'banana" NEAR(x', "'; DROP TABLE messages; --", 'NOT banana']) {
      const res = await api(alice.token, `/api/search?q=${encodeURIComponent(q)}`)
      assert.ok([200, 400].includes(res.status), q)
    }
    assert.equal(buildSearchMatch('"; DROP'), '"drop"*')
    assert.equal(buildSearchMatch('***'), null)
    assert.equal((await api(alice.token, '/api/search?q=')).status, 400)
    assert.equal((await search('q=banana&since=2000-01-01&until=2000-01-02')).messages.length, 0)

    // Edits and deletes are reflected in the index.
    const msg = await send(alice.token, 'hangout-general', { content: 'kiwi' })
    await api(alice.token, `/api/channels/hangout-general/messages/${msg.id}`, { method: 'PATCH', json: { content: 'mango' } })
    assert.equal((await search('q=kiwi')).messages.length, 0)
    assert.equal((await search('q=mango')).messages.length, 1)
    await api(alice.token, `/api/channels/hangout-general/messages/${msg.id}`, { method: 'DELETE' })
    assert.equal((await search('q=mango')).messages.length, 0)
  })

  // ---------- Unread state ----------

  test('unread counts, monotonic read position, and sync between sessions', async () => {
    const alice = await login('unread-alice')
    const bob = await login('unread-bob')
    const states = async () =>
      (await (await api(alice.token, '/api/read-states')).json()) as ApiReadState[]
    const general = () => states().then((s) => s.find((x) => x.channelId === 'hangout-welcome')!)

    assert.equal((await general()).unreadCount, 0, 'starts caught up')
    const sent: ApiMessage[] = []
    for (let i = 0; i < 3; i++) sent.push(await send(bob.token, 'hangout-welcome', { content: `news ${i}` }))
    await send(alice.token, 'hangout-music', { content: 'elsewhere' })
    assert.equal((await general()).unreadCount, 3)
    assert.equal((await general()).lastMessageId, sent[2]!.id)

    const second = gateway(alice.token)
    await second.ready
    const ack = await api(alice.token, '/api/channels/hangout-welcome/read', { method: 'PUT', json: { messageId: sent[1]!.id } })
    assert.equal(ack.status, 200)
    await second.waitFor((f) => f.op === 'read_state_update' && f.d.lastReadId === sent[1]!.id)
    assert.equal((await general()).unreadCount, 1)
    // Never moves backwards.
    await api(alice.token, '/api/channels/hangout-welcome/read', { method: 'PUT', json: { messageId: sent[0]!.id } })
    assert.equal((await general()).lastReadId, sent[1]!.id)
    // Your own messages are never unread.
    await send(alice.token, 'hangout-welcome', { content: 'my reply' })
    assert.equal((await general()).unreadCount, 0)
    // Bob's sessions never get Alice's read state.
    const gwBob = gateway(bob.token)
    await gwBob.ready
    await api(alice.token, '/api/channels/hangout-welcome/read', { method: 'PUT', json: { messageId: sent[2]!.id } })
    await new Promise((r) => setTimeout(r, 100))
    assert.ok(!gwBob.frames.some((f) => f.op === 'read_state_update'))
    second.ws.close()
    gwBob.ws.close()
  })

  test('messages in a channel that was empty when first seen stay unread (regression)', async () => {
    const alice = await login('empty-alice')
    const bob = await login('empty-bob')
    const music = async () =>
      ((await (await api(alice.token, '/api/read-states')).json()) as ApiReadState[]).find(
        (x) => x.channelId === 'studyhall-resources'
      )!
    // First look at the channel while it is empty: nothing unread, position recorded.
    const first = await music()
    assert.equal(first.unreadCount, 0)
    // Bob posts while Alice is away; her next fetch (restart / reconnect) must count them.
    await send(bob.token, 'studyhall-resources', { content: 'first ever message' })
    await send(bob.token, 'studyhall-resources', { content: 'second one' })
    const later = await music()
    assert.equal(later.unreadCount, 2, 'not silently marked read')
    assert.notEqual(later.lastReadId, later.lastMessageId)
  })

  // ---------- History window ----------

  test('loads a window of history around a message', async () => {
    const { token, userId } = await login('around-hank')
    const ids: string[] = []
    for (let i = 0; i < 9; i++) {
      ids.push((await server.repo.createMessage({ channelId: 'gamenight-lfg', authorId: userId, content: `m${i}`, createdAt: Date.now(), replyToId: null, attachmentIds: [] })).id)
    }
    const around = await history(token, 'gamenight-lfg', `?around=${ids[4]}&limit=4`)
    assert.deepEqual(around.map((m) => m.content), ['m2', 'm3', 'm4', 'm5'])
  })

  // ---------- Persistence ----------

  test('messages, reactions, pins and files survive a backend restart', async () => {
    const { token, userId } = await login('persist-ivy')
    await server.repo.setMemberRole('hangout', userId, 'moderator')
    const [file] = (await (await upload(token, 'hangout-general', [{ name: 'keep.png', data: png(3, 3, 200) }])).json()) as ApiAttachment[]
    const msg = await send(token, 'hangout-general', { content: 'still here', attachmentIds: [file!.id] })
    await api(token, `/api/channels/hangout-general/messages/${msg.id}/reactions/${encodeURIComponent('✅')}`, { method: 'PUT' })
    await api(token, `/api/channels/hangout-general/pins/${msg.id}`, { method: 'PUT' })

    await server.app.close()
    await server.repo.close()
    server = await start()

    const view = (await history(token, 'hangout-general')).find((m) => m.id === msg.id)!
    assert.equal(view.content, 'still here')
    assert.equal(view.attachments?.[0]?.id, file!.id)
    assert.deepEqual(view.reactions, [{ emoji: '✅', count: 1, me: true }])
    assert.equal(view.pinned, true)
    const res = await api(token, `/api/attachments/${file!.id}`)
    assert.equal(res.status, 200)
    assert.equal((await res.arrayBuffer()).byteLength, 200)
  })

  // ---------- Cleanup ----------

  test('cleanup removes abandoned uploads and orphan files but never sent attachments', async () => {
    const { token } = await login('cleanup-jo')
    const [pending] = (await (await upload(token, 'hangout-general', [{ name: 'old.txt', data: 'old' }])).json()) as ApiAttachment[]
    const [kept] = (await (await upload(token, 'hangout-general', [{ name: 'kept.txt', data: 'kept' }])).json()) as ApiAttachment[]
    await send(token, 'hangout-general', { content: 'with file', attachmentIds: [kept!.id] })
    // An orphan file without a row (e.g. crash between write and insert), old enough to sweep.
    const orphan = 'f'.repeat(32)
    const orphanPath = join(attachmentsDir, 'files', 'ff', orphan)
    mkdirSync(join(attachmentsDir, 'files', 'ff'), { recursive: true })
    writeFileSync(orphanPath, 'orphan')
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    utimesSync(orphanPath, old, old)

    const later = Date.now() + config.attachments.pendingTtlMs + 60_000
    const result = await cleanupAttachments(server.ctx, server.app.log, later)
    assert.ok(result.stale >= 1)
    assert.ok(!storedFiles().includes(pending!.id), 'abandoned upload deleted')
    assert.ok(!storedFiles().includes(orphan), 'orphan swept')
    assert.ok(storedFiles().includes(kept!.id), 'sent attachment kept')
    assert.equal((await api(token, `/api/attachments/${kept!.id}`)).status, 200)
  })
})

describe('migration from the Milestone 5 schema', () => {
  test('upgrades a real v1 database in place, keeping old messages readable and searchable', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'd2-legacy-'))
    const file = join(legacyDir, 'legacy.db')
    try {
      const legacy = new DatabaseSync(file)
      legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
      legacy.exec(sqliteMigrations[0]!.sql)
      legacy.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?)').run('initial_schema', Date.now())
      legacy.exec(`
        INSERT INTO users VALUES ('u1', 'old', 'Old Timer', '#123456', 0, 1);
        INSERT INTO servers VALUES ('s1', 'Old', '#123456', 'u1', 0, 1);
        INSERT INTO channels VALUES ('c1', 's1', 'general', 'text', NULL, 'Text', 0, 1);
        INSERT INTO messages (channel_id, author_id, content, created_at) VALUES ('c1', 'u1', 'from milestone five', 5);
      `)
      legacy.close()

      const repo = new SqliteRepository(file)
      await repo.migrate()
      await repo.migrate() // repeatable
      const [old] = await repo.listMessages('c1', { limit: 10 })
      assert.deepEqual(
        { content: old!.content, editedAt: old!.editedAt, replyToId: old!.replyToId },
        { content: 'from milestone five', editedAt: null, replyToId: null }
      )
      const found = await repo.searchMessages({ match: '"milestone"*', channelIds: ['c1'], limit: 5 })
      assert.equal(found.length, 1, 'existing history was indexed')
      const versions = (await (repo as unknown as { all: (sql: string) => { version: number }[] }).all('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version)
      assert.deepEqual(versions, sqliteMigrations.map((m) => m.version))
      await repo.close()

      // The old (Milestone 5) server's queries still work on the migrated file.
      const m5 = new DatabaseSync(file)
      m5.exec('PRAGMA foreign_keys = ON')
      m5.prepare('INSERT INTO messages (channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?)').run('c1', 'u1', 'written by m5', 6)
      const rows = m5.prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?').all('c1', 50)
      assert.equal(rows.length, 2)
      m5.close()
    } finally {
      rmSync(legacyDir, { recursive: true, force: true })
    }
  })
})

describe('file type helpers', () => {
  test('allowlist and image sizes', () => {
    assert.equal(typeForFilename('a.PNG')?.contentType, 'image/png')
    assert.equal(typeForFilename('a.exe'), undefined)
    assert.deepEqual(imageSize('image/png', png(640, 480)), { width: 640, height: 480 })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x00, 0x10, 0x00])
    assert.deepEqual(imageSize('image/gif', gif), { width: 32, height: 16 })
    // JPEG: SOI, APP1 Exif with orientation 6 (rotated 90°), SOF0 300x200 -> displayed 200x300.
    const exif = [
      0x45, 0x78, 0x69, 0x66, 0, 0, // "Exif\0\0"
      0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, // big-endian TIFF, IFD at 8
      0, 1, // one entry
      0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, // orientation = 6
      0, 0, 0, 0
    ]
    const app1 = [0xff, 0xe1, 0, exif.length + 2, ...exif]
    const sof = [0xff, 0xc0, 0, 17, 8, 0, 200, 1, 44, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
    const jpeg = new Uint8Array([0xff, 0xd8, ...app1, ...sof])
    assert.deepEqual(imageSize('image/jpeg', jpeg), { width: 200, height: 300 })
  })
})
