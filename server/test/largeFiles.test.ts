/**
 * Milestone 13 large files: chunked, resumable uploads (restart recovery, offsets, ownership,
 * cancel), the 5 GB ceiling, the "strictly over 500 MB" ephemeral rule (threshold scaled down
 * for the tests), quotas, free-space refusal, concurrency, expiry that keeps the message, range
 * downloads, abandoned-upload cleanup and migration 8. Real multi-gigabyte transfers are a
 * manual test on the Jetson (see the report).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { HashGate, OWASP_MINIMUM, PasswordHasher } from '../src/auth/password.js'
import { loadConfig } from '../src/config.js'
import type { AppContext } from '../src/context.js'
import { sqliteMigrations } from '../src/db/migrations.js'
import { seedIfEmpty } from '../src/db/seed.js'
import { SqliteRepository } from '../src/db/sqlite.js'
import { TokenBucketLimiter } from '../src/lib/rateLimit.js'
import { attachmentIdForSession, cleanupLargeFiles, uploadParts } from '../src/routes/largeUploads.js'
import type { ApiAttachment, ApiMessage, ApiUploadSession } from '../src/protocol.js'

const SCHEME = ['Bea', 'rer'].join('')
const HASHER = new PasswordHasher(OWASP_MINIMUM, new HashGate(4, 64))
const MiB = 1024 * 1024
const dir = mkdtempSync(join(tmpdir(), 'd2-large-'))
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined } as never

interface Server {
  app: FastifyInstance
  ctx: AppContext
  repo: SqliteRepository
  base: string
  file: string
}

const LARGE_ENV = {
  UPLOAD_LARGE_FILES: 'true',
  // Scaled down: 1 MiB plays the role of 500 MB.
  UPLOAD_EPHEMERAL_THRESHOLD_MB: '1',
  UPLOAD_LARGE_USER_QUOTA_MB: '3',
  UPLOAD_LARGE_POOL_MB: '5',
  UPLOAD_LARGE_MIN_FREE_MB: '1',
  UPLOAD_MIN_FREE_DISK_MB: '1',
  UPLOAD_LARGE_CONCURRENT: '2'
}

async function start(env: Record<string, string> = LARGE_ENV, name = `large-${Date.now()}-${Math.random()}`): Promise<Server> {
  const file = join(dir, `${name}.db`)
  const repo = new SqliteRepository(file)
  await repo.migrate()
  await seedIfEmpty(repo)
  const config = loadConfig({
    NODE_ENV: 'test',
    DEV_AUTH: 'true',
    LOG_LEVEL: 'silent',
    ATTACHMENTS_DIR: join(dir, `${name}-files`),
    ...env
  })
  const { app, ctx } = await buildApp(config, repo, {
    logger: false,
    hasher: HASHER,
    voiceReconcileIntervalMs: 0,
    attachmentCleanupIntervalMs: 0,
    statusExpiryIntervalMs: 0,
    largeFileSweepIntervalMs: 0
  })
  for (const n of Object.keys(ctx.limiters) as (keyof AppContext['limiters'])[]) {
    ctx.limiters[n].dispose()
    ctx.limiters[n] = new TokenBucketLimiter(10_000, 1_000)
  }
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return { app, ctx, repo, base: `http://127.0.0.1:${address.port}`, file }
}

async function stop(s: Server): Promise<void> {
  await s.app.close()
  await s.repo.close()
}

function client(s: Server) {
  const req = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
    if (init.token) headers.Authorization = `${SCHEME} ${init.token}`
    if (init.json !== undefined) headers['Content-Type'] = 'application/json'
    return fetch(`${s.base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body })
  }
  const login = async (username: string): Promise<string> =>
    ((await (await req('/api/dev/login', { method: 'POST', json: { username } })).json()) as { token: string }).token
  const startUpload = (token: string, channelId: string, filename: string, size: number) =>
    req(`/api/channels/${channelId}/uploads`, { method: 'POST', token, json: { filename, size } })
  const chunk = (token: string, id: string, offset: number, data: Uint8Array) =>
    req(`/api/uploads/${id}?offset=${offset}`, {
      method: 'PUT',
      token,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data
    })
  return { req, login, startUpload, chunk }
}

async function json<T>(res: Response, status: number): Promise<T> {
  const text = await res.text()
  assert.equal(res.status, status, `${res.status} ${text}`)
  return (text ? JSON.parse(text) : undefined) as T
}

const code = async (res: Response): Promise<string> => ((await res.json()) as { error: { code: string } }).error.code

/** A plain-text payload of exactly `size` bytes (valid UTF-8, no NULs). */
function textBytes(size: number, seed = 'x'): Buffer {
  const line = Buffer.from(`${seed} large file test line 0123456789\n`)
  const out = Buffer.alloc(size)
  for (let i = 0; i < size; i += line.length) line.copy(out, i, 0, Math.min(line.length, size - i))
  return out
}

/** Uploads `data` in `parts` chunks and completes it. */
async function uploadAll(s: Server, token: string, channelId: string, filename: string, data: Buffer, parts = 2): Promise<ApiAttachment> {
  const c = client(s)
  const session = await json<ApiUploadSession>(await c.startUpload(token, channelId, filename, data.length), 201)
  const step = Math.ceil(data.length / parts)
  for (let offset = 0; offset < data.length; offset += step) {
    const r = await json<{ receivedBytes: number }>(await c.chunk(token, session.id, offset, data.subarray(offset, offset + step)), 200)
    assert.equal(r.receivedBytes, Math.min(data.length, offset + step))
  }
  return json<ApiAttachment>(await c.req(`/api/uploads/${session.id}/complete`, { method: 'POST', token }), 201)
}

after(() => rmSync(dir, { recursive: true, force: true }))

// ======================================================================
describe('large uploads switched off (default)', () => {
  test('meta says so and the route refuses', async () => {
    const s = await start({})
    try {
      const meta = (await (await fetch(`${s.base}/api/meta`)).json()) as { largeFiles: unknown }
      assert.equal(meta.largeFiles, null)
      const c = client(s)
      const token = await c.login('lf_off')
      const res = await c.startUpload(token, 'hangout-general', 'big.zip', 10 * MiB)
      assert.equal(res.status, 404)
      assert.equal(await code(res), 'large_uploads_disabled')
      assert.equal(loadConfig({ NODE_ENV: 'test' }).attachments.large, null)
      assert.throws(() => loadConfig({ NODE_ENV: 'test', UPLOAD_LARGE_FILES: 'true', UPLOAD_MAX_LARGE_FILE_MB: '6000' }), /5 GB/)
    } finally {
      await stop(s)
    }
  })
})

// ======================================================================
describe('chunked uploads', () => {
  test('5 GB ceiling; the threshold itself keeps normal retention, one byte more expires in 24 h', async () => {
    const s = await start()
    try {
      const c = client(s)
      const token = await c.login('lf_alice')
      const meta = (await (await fetch(`${s.base}/api/meta`)).json()) as { largeFiles: { maxBytes: number; ephemeralThresholdBytes: number; chunkBytes: number } }
      assert.equal(meta.largeFiles.maxBytes, 5 * 1024 * MiB)
      assert.equal(meta.largeFiles.ephemeralThresholdBytes, MiB)
      assert.equal(meta.largeFiles.chunkBytes, 16 * MiB)
      const tooBig = await c.startUpload(token, 'hangout-general', 'huge.zip', 5 * 1024 * MiB + 1)
      assert.equal(tooBig.status, 413)

      // Exactly at the threshold: normal retention.
      const exact = await uploadAll(s, token, 'hangout-general', 'exact.txt', textBytes(MiB, 'exact'))
      assert.equal(exact.size, MiB)
      assert.equal(exact.expiresAt, undefined)
      assert.equal(exact.kind, 'file')

      // One byte more: expires 24 h after the upload completes.
      const before = Date.now()
      const over = await uploadAll(s, token, 'hangout-general', 'over.txt', textBytes(MiB + 1, 'over'), 3)
      const after = Date.now()
      assert.ok(over.expiresAt! >= before + 24 * 3_600_000 && over.expiresAt! <= after + 24 * 3_600_000)

      // Send both in a message; everyone in the channel can download, with byte ranges.
      const msg = await json<ApiMessage>(
        await c.req('/api/channels/hangout-general/messages', { method: 'POST', token, json: { content: 'big ones', attachmentIds: [exact.id, over.id] } }),
        201
      )
      assert.equal(msg.attachments.length, 2)
      const bob = await c.login('lf_bob')
      const full = await c.req(`/api/attachments/${over.id}`, { token: bob })
      assert.equal(full.status, 200)
      assert.equal(full.headers.get('accept-ranges'), 'bytes')
      const body = Buffer.from(await full.arrayBuffer())
      assert.equal(createHash('sha256').update(body).digest('hex'), createHash('sha256').update(textBytes(MiB + 1, 'over')).digest('hex'))
      const part = await c.req(`/api/attachments/${over.id}`, { token: bob, headers: { Range: 'bytes=100-199' } })
      assert.equal(part.status, 206)
      assert.equal(part.headers.get('content-range'), `bytes 100-199/${MiB + 1}`)
      assert.deepEqual(Buffer.from(await part.arrayBuffer()), textBytes(MiB + 1, 'over').subarray(100, 200))
      const tail = await c.req(`/api/attachments/${over.id}`, { token: bob, headers: { Range: `bytes=${MiB}-` } })
      assert.equal(tail.status, 206)
      assert.equal((await tail.arrayBuffer()).byteLength, 1)
      assert.equal((await c.req(`/api/attachments/${over.id}`, { token: bob, headers: { Range: `bytes=${MiB + 5}-` } })).status, 416)
    } finally {
      await stop(s)
    }
  })

  test('offsets, chunk limits and ownership are enforced; cancel removes everything', async () => {
    const s = await start()
    try {
      const c = client(s)
      const alice = await c.login('lf_alice2')
      const eve = await c.login('lf_eve')
      const data = textBytes(200_000)
      const session = await json<ApiUploadSession>(await c.startUpload(alice, 'hangout-general', 'notes.txt', data.length), 201)
      assert.equal(session.receivedBytes, 0)
      assert.equal(session.expiresAfterMs, null)

      const wrong = await c.chunk(alice, session.id, 5, data.subarray(0, 10))
      assert.equal(wrong.status, 409)
      assert.equal(await code(wrong), 'wrong_offset')
      assert.equal((await c.chunk(alice, session.id, 0, textBytes(200_001))).status, 400, 'past the end')
      await json(await c.chunk(alice, session.id, 0, data.subarray(0, 50_000)), 200)
      assert.equal((await c.chunk(alice, session.id, 0, data.subarray(0, 10))).status, 409, 'no rewriting stored bytes')
      assert.equal((await c.req(`/api/uploads/${session.id}/complete`, { method: 'POST', token: alice })).status, 409, 'incomplete')

      // Someone else's upload doesn't exist for them.
      assert.equal((await c.req(`/api/uploads/${session.id}`, { token: eve })).status, 404)
      assert.equal((await c.chunk(eve, session.id, 50_000, data.subarray(50_000))).status, 404)
      assert.equal((await c.req(`/api/uploads/${session.id}/complete`, { method: 'POST', token: eve })).status, 404)
      assert.equal((await c.req(`/api/uploads/${session.id}`, { method: 'DELETE', token: eve })).status, 404)
      assert.equal((await c.req('/api/uploads/..%2F..%2Fd2', { token: alice })).status, 404)
      // Raw bytes only on the chunk route; JSON elsewhere is unaffected.
      assert.equal(
        (await c.req(`/api/uploads/${session.id}?offset=50000`, { method: 'PUT', token: alice, json: { a: 1 } })).status,
        415
      )
      assert.equal((await c.req('/api/servers', { method: 'POST', token: alice, headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' })).status, 415)

      const part = uploadParts(s.ctx).partPath(session.id)
      assert.ok(existsSync(part))
      await json(await c.req(`/api/uploads/${session.id}`, { method: 'DELETE', token: alice }), 204)
      assert.equal(existsSync(part), false)
      assert.equal((await c.req(`/api/uploads/${session.id}`, { token: alice })).status, 404)
    } finally {
      await stop(s)
    }
  })

  test('an upload survives a server restart and resumes where the database says', async () => {
    const name = 'restart'
    let s = await start(LARGE_ENV, name)
    const data = textBytes(300_000, 'resume')
    let sessionId = ''
    let token = ''
    try {
      const c = client(s)
      token = await c.login('lf_carol')
      const session = await json<ApiUploadSession>(await c.startUpload(token, 'hangout-general', 'resume.txt', data.length), 201)
      sessionId = session.id
      await json(await c.chunk(token, sessionId, 0, data.subarray(0, 120_000)), 200)
      // Bytes written past the recorded offset (e.g. a chunk cut off by the crash) are harmless.
      writeFileSync(uploadParts(s.ctx).partPath(sessionId), Buffer.concat([data.subarray(0, 120_000), Buffer.from('GARBAGE')]))
    } finally {
      await stop(s)
    }
    s = await start(LARGE_ENV, name)
    try {
      const c = client(s)
      const status = await json<ApiUploadSession>(await c.req(`/api/uploads/${sessionId}`, { token }), 200)
      assert.equal(status.receivedBytes, 120_000)
      await json(await c.chunk(token, sessionId, 120_000, data.subarray(120_000)), 200)
      const attachment = await json<ApiAttachment>(await c.req(`/api/uploads/${sessionId}/complete`, { method: 'POST', token }), 201)
      const stored = Buffer.from(await (await c.req(`/api/attachments/${attachment.id}`, { token })).arrayBuffer())
      assert.equal(stored.length, data.length)
      assert.ok(stored.equals(data), 'identical bytes after resume')
    } finally {
      await stop(s)
    }
  })

  test('contents must match the extension', async () => {
    const s = await start()
    try {
      const c = client(s)
      const token = await c.login('lf_mallory')
      const fake = textBytes(5000)
      const session = await json<ApiUploadSession>(await c.startUpload(token, 'hangout-general', 'game.zip', fake.length), 201)
      await json(await c.chunk(token, session.id, 0, fake), 200)
      assert.equal((await c.req(`/api/uploads/${session.id}/complete`, { method: 'POST', token })).status, 415)
      assert.equal(existsSync(uploadParts(s.ctx).partPath(session.id)), false)
      assert.equal((await c.req(`/api/uploads/${session.id}`, { token })).status, 404)
      // Videos are accepted (as downloads).
      const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(2000, 1)])
      const video = await uploadAll(s, token, 'hangout-general', 'clip.mp4', mp4, 1)
      assert.equal(video.contentType, 'video/mp4')
      assert.equal(video.kind, 'file')
    } finally {
      await stop(s)
    }
  })

  test('finishing is idempotent and completes an interrupted attempt', async () => {
    const s = await start()
    try {
      const c = client(s)
      const token = await c.login('lf_finish')
      const other = await c.login('lf_finish_eve')
      const data = textBytes(150_000, 'finish')
      const begin = async (name: string): Promise<string> => {
        const session = await json<ApiUploadSession>(await c.startUpload(token, 'hangout-general', name, data.length), 201)
        await json(await c.chunk(token, session.id, 0, data), 200)
        return session.id
      }
      const finish = (id: string, as = token) => c.req(`/api/uploads/${id}/complete`, { method: 'POST', token: as })

      // The answer got lost: asking again returns the same attachment; others still get 404.
      const first = await begin('a.txt')
      const attachment = await json<ApiAttachment>(await finish(first), 201)
      assert.equal(attachment.id, attachmentIdForSession(first))
      assert.equal((await json<ApiAttachment>(await finish(first), 200)).id, attachment.id)
      assert.equal((await finish(first, other)).status, 404)

      // Stopped after the file was moved into place, before it was recorded.
      const second = await begin('b.txt')
      const target = s.ctx.attachments.pathFor(attachmentIdForSession(second))
      mkdirSync(dirname(target), { recursive: true })
      renameSync(uploadParts(s.ctx).partPath(second), target)
      const recovered = await json<ApiAttachment>(await finish(second), 201)
      const bytes = Buffer.from(await (await c.req(`/api/attachments/${recovered.id}`, { token })).arrayBuffer())
      assert.ok(bytes.equals(data), 'recovered file intact')

      // Nothing left on disk: a clear error, and the upload is gone.
      const third = await begin('c.txt')
      rmSync(uploadParts(s.ctx).partPath(third))
      const lost = await finish(third)
      assert.equal(lost.status, 409)
      assert.equal(await code(lost), 'upload_lost')
      assert.equal((await c.req(`/api/uploads/${third}`, { token })).status, 404)

      // While one attempt is hashing, a second attempt and cancelling are refused.
      const fourth = await begin('d.txt')
      const parts = uploadParts(s.ctx)
      const original = parts.finalize.bind(parts)
      let release = (): void => undefined
      const gate = new Promise<void>((r) => (release = r))
      let entered = (): void => undefined
      const inside = new Promise<void>((r) => (entered = r))
      parts.finalize = async (id: string, size: number) => {
        entered()
        await gate
        return original(id, size)
      }
      try {
        const pending = finish(fourth)
        await inside
        const again = await finish(fourth)
        assert.equal(again.status, 409)
        assert.equal(await code(again), 'upload_finishing')
        assert.equal((await c.req(`/api/uploads/${fourth}`, { method: 'DELETE', token })).status, 409)
        release()
        assert.equal((await json<ApiAttachment>(await pending, 201)).id, attachmentIdForSession(fourth))
      } finally {
        parts.finalize = original
      }
    } finally {
      await stop(s)
    }
  })
})

// ======================================================================
describe('limits', () => {
  test('uploads still in progress count against the normal quota', async () => {
    const s = await start({ ...LARGE_ENV, UPLOAD_USER_QUOTA_MB: '1.5' })
    try {
      const c = client(s)
      const token = await c.login('lf_quota')
      const bytes = Math.floor(0.9 * MiB)
      await json(await c.startUpload(token, 'hangout-general', 'one.txt', bytes), 201)
      // Nothing is stored yet, but the first upload's space is reserved.
      const second = await c.startUpload(token, 'hangout-general', 'two.txt', bytes)
      assert.equal(second.status, 507)
      assert.equal(await code(second), 'storage_full')
    } finally {
      await stop(s)
    }
  })
  test('per-user concurrency, per-user large quota and the shared pool', async () => {
    const s = await start()
    try {
      const c = client(s)
      const a = await c.login('lf_quota_a')
      const b = await c.login('lf_quota_b')
      const big = 2.5 * MiB
      await json(await c.startUpload(a, 'hangout-general', 'a1.zip', big), 201)
      // 2.5 + 1.5 MiB > the 3 MiB per-user large quota.
      assert.equal((await c.startUpload(a, 'hangout-general', 'a2.zip', 1.5 * MiB)).status, 507)
      // Normal-retention files are not counted against the large pool.
      await json(await c.startUpload(a, 'hangout-general', 'small.txt', 1000), 201)
      const third = await c.startUpload(a, 'hangout-general', 'more.txt', 1000)
      assert.equal(third.status, 429)
      assert.equal(await code(third), 'too_many_uploads')
      // B fills the 5 MiB pool together with A's reservation; nothing more fits.
      await json(await c.startUpload(b, 'hangout-general', 'b1.zip', big), 201)
      assert.equal((await c.startUpload(b, 'hangout-general', 'b2.zip', Math.round(1.2 * MiB))).status, 507)
    } finally {
      await stop(s)
    }
  })

  test('refused while free space would fall below the floor', async () => {
    const s = await start({ ...LARGE_ENV, UPLOAD_LARGE_MIN_FREE_MB: String(1024 * 1024 * 1024) })
    try {
      const c = client(s)
      const token = await c.login('lf_disk')
      const res = await c.startUpload(token, 'hangout-general', 'big.zip', 2 * MiB)
      assert.equal(res.status, 507)
    } finally {
      await stop(s)
    }
  })
})

// ======================================================================
describe('expiry and cleanup', () => {
  test('expired files lose their bytes but the message stays; downloads answer 410', async () => {
    const s = await start()
    try {
      const c = client(s)
      const token = await c.login('lf_dave')
      const att = await uploadAll(s, token, 'hangout-general', 'trip.txt', textBytes(MiB + 10))
      const msg = await json<ApiMessage>(
        await c.req('/api/channels/hangout-general/messages', { method: 'POST', token, json: { content: 'holiday video', attachmentIds: [att.id] } }),
        201
      )
      const path = s.ctx.attachments.pathFor(att.id)
      assert.ok(existsSync(path))
      // Not yet due: nothing happens.
      assert.equal((await cleanupLargeFiles(s.ctx, silent)).expired, 0)
      // Time is up (by the clock) before the sweep: downloads are already refused.
      const db = new DatabaseSync(s.file)
      db.prepare('UPDATE attachments SET expires_at = ? WHERE id = ?').run(Date.now() - 1, att.id)
      db.close()
      const gone = await c.req(`/api/attachments/${att.id}`, { token })
      assert.equal(gone.status, 410)
      assert.equal(await code(gone), 'attachment_expired')
      // The sweep deletes the bytes and marks the row; running it again is harmless.
      assert.equal((await cleanupLargeFiles(s.ctx, silent)).expired, 1)
      assert.equal(existsSync(path), false)
      assert.equal((await cleanupLargeFiles(s.ctx, silent)).expired, 0)
      const page = await json<ApiMessage[]>(await c.req('/api/channels/hangout-general/messages?limit=5', { token }), 200)
      const kept = page.find((m) => m.id === msg.id)!
      assert.equal(kept.content, 'holiday video')
      assert.equal(kept.attachments[0]?.expired, true)
      assert.equal(kept.attachments[0]?.filename, 'trip.txt')
      // Deleting the message afterwards still works.
      await json(await c.req(`/api/channels/hangout-general/messages/${msg.id}`, { method: 'DELETE', token }), 204)
    } finally {
      await stop(s)
    }
  })

  test('abandoned sessions and stray part files are removed', async () => {
    const s = await start()
    try {
      const c = client(s)
      const token = await c.login('lf_erin')
      const session = await json<ApiUploadSession>(await c.startUpload(token, 'hangout-general', 'left.txt', 50_000), 201)
      await json(await c.chunk(token, session.id, 0, textBytes(10_000)), 200)
      const stray = join(uploadParts(s.ctx).dir, `${'f'.repeat(32)}.part`)
      writeFileSync(stray, 'leftover')
      const old = new Date(Date.now() - 2 * 3_600_000)
      utimesSync(stray, old, old)
      const fresh = await cleanupLargeFiles(s.ctx, silent)
      assert.equal(fresh.abandoned, 0, 'recent sessions are kept')
      assert.equal(fresh.parts, 1, 'only the stray file')
      assert.ok(existsSync(uploadParts(s.ctx).partPath(session.id)))
      const later = await cleanupLargeFiles(s.ctx, silent, Date.now() + 25 * 3_600_000)
      assert.equal(later.abandoned, 1)
      assert.equal(existsSync(uploadParts(s.ctx).partPath(session.id)), false)
      assert.equal((await c.req(`/api/uploads/${session.id}`, { token })).status, 404)
    } finally {
      await stop(s)
    }
  })
})

// ======================================================================
describe('migration v8 (large files)', () => {
  test('a v7 database upgrades with existing attachments untouched', async () => {
    const file = join(dir, 'm13-v7.db')
    const db = new DatabaseSync(file)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
    for (const m of sqliteMigrations.filter((x) => x.version <= 7)) {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, 1)
    }
    db.prepare("INSERT INTO users (id, username, display_name, avatar_color, is_bot, created_at) VALUES ('u1', 'u', 'U', '#000000', 0, 1)").run()
    db.prepare("INSERT INTO servers (id, name, color, owner_id, position, created_at) VALUES ('s1', 'S', '#111111', 'u1', 0, 1)").run()
    db.prepare("INSERT INTO channels (id, server_id, name, type, topic, category, position, created_at) VALUES ('c1', 's1', 'general', 'text', NULL, 'Text', 0, 1)").run()
    db.prepare("INSERT INTO messages (channel_id, author_id, content, created_at) VALUES ('c1', 'u1', 'hi', 2)").run()
    db.prepare(`INSERT INTO attachments (id, message_id, channel_id, uploader_id, filename, content_type, kind, size, sha256, created_at) VALUES ('${'a'.repeat(32)}', 1, 'c1', 'u1', 'a.txt', 'text/plain', 'file', 5, 'h', 3)`).run()
    db.close()
    const repo = new SqliteRepository(file)
    await repo.migrate()
    const a = await repo.getAttachment('a'.repeat(32))
    assert.equal(a?.expiresAt, null)
    assert.equal(a?.expiredAt, null)
    assert.deepEqual(await repo.largeFileUsage('u1'), { user: 0, pool: 0, sessions: 0 })
    assert.equal((await repo.attachmentUsage('u1')).user, 5)
    const raw = (repo as unknown as { db: DatabaseSync }).db
    assert.equal(Number(raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v), 8)
    assert.throws(() => raw.prepare("INSERT INTO upload_sessions (id, user_id, channel_id, filename, content_type, kind, size, received, created_at, updated_at) VALUES ('x', 'u1', 'c1', 'f', 't', 'file', 10, 11, 1, 1)").run(), /CHECK/)
    assert.equal(raw.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')
    await repo.close()
  })
})
