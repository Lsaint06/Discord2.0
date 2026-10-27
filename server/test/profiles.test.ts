/**
 * Milestone 8 tests: profiles, profile images (upload security), presence across devices,
 * invisible mode, idle transitions, custom status expiry, synced preferences, the v4 migration,
 * and persistence across restarts.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { crc32, deflateSync } from 'node:zlib'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { buildApp } from '../src/app.js'
import { HashGate, OWASP_MINIMUM, PasswordHasher } from '../src/auth/password.js'
import { loadConfig } from '../src/config.js'
import type { AppContext } from '../src/context.js'
import { sqliteMigrations } from '../src/db/migrations.js'
import { seedIfEmpty } from '../src/db/seed.js'
import { SqliteRepository } from '../src/db/sqlite.js'
import { TokenBucketLimiter } from '../src/lib/rateLimit.js'
import { sniffImageFormat } from '../src/profile/media.js'
import { expireCustomStatuses } from '../src/realtime.js'
import { parsePreferences } from '../src/routes/profile.js'
import type {
  ApiAuthResult,
  ApiMe,
  ApiPreferences,
  ApiProfile,
  ApiUser,
  GatewayServerFrame
} from '../src/protocol.js'

const SCHEME = ['Bea', 'rer'].join('')
const HASHER = new PasswordHasher(OWASP_MINIMUM, new HashGate(4, 64))
const PASSWORD = 'violet-anchor-sunrise-42'

const dir = mkdtempSync(join(tmpdir(), 'd2-profiles-'))
const dbFile = join(dir, 'profiles.db')
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

async function login(username: string): Promise<ApiAuthResult> {
  return json<ApiAuthResult>(
    await req('/api/auth/login', { method: 'POST', json: { username, password: PASSWORD } }),
    200
  )
}

let adminToken = ''

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

function gateway(token: string, identify: Record<string, unknown> = {}) {
  const ws = new WebSocket(s.base.replace('http', 'ws') + '/gateway')
  const frames: GatewayServerFrame[] = []
  const waiters: { pred: (f: GatewayServerFrame) => boolean; resolve: (f: GatewayServerFrame) => void }[] = []
  const closed = new Promise<number>((resolve) => ws.addEventListener('close', (ev) => resolve(ev.code)))
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as GatewayServerFrame
    frames.push(frame)
    if (frame.op === 'hello') ws.send(JSON.stringify({ op: 'identify', d: { token, ...identify } }))
    for (const w of [...waiters]) {
      if (w.pred(frame)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(frame)
      }
    }
  })
  // Frames are consumed in order: each wait returns the first match after the previous one
  // (including frames that arrived before the wait started).
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
  const send = (frame: unknown) => ws.send(JSON.stringify(frame))
  const close = async () => {
    ws.close()
    await closed
  }
  return { ws, frames, waitFor, send, close, closed }
}

type Gw = ReturnType<typeof gateway>

async function ready(gw: Gw): Promise<Extract<GatewayServerFrame, { op: 'ready' }>> {
  return (await gw.waitFor((f) => f.op === 'ready')) as Extract<GatewayServerFrame, { op: 'ready' }>
}

/** Waits for a user_update about `userId` matching `pred`. */
function userUpdate(gw: Gw, userId: string, pred: (u: ApiUser) => boolean = () => true) {
  return gw.waitFor((f) => f.op === 'user_update' && f.d.id === userId && pred(f.d)) as Promise<
    Extract<GatewayServerFrame, { op: 'user_update' }>
  >
}

const updatesAbout = (gw: Gw, userId: string): ApiUser[] =>
  gw.frames.flatMap((f) => (f.op === 'user_update' && f.d.id === userId ? [f.d] : []))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function upload(token: string, kind: 'avatar' | 'banner', data: Uint8Array | string, name = 'x.png') {
  const form = new FormData()
  form.append('file', new Blob([typeof data === 'string' ? data : Buffer.from(data)]), name)
  return req(`/api/users/me/${kind}`, { method: 'POST', token, body: form })
}

async function image(width: number, height: number, format: 'png' | 'jpeg' | 'webp' | 'gif' = 'png') {
  const img = sharp({ create: { width, height, channels: 3, background: '#3366cc' } })
  return img.toFormat(format).toBuffer()
}

/** A syntactically valid PNG whose header claims huge dimensions (decompression bomb). */
function pngClaiming(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(64))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

let alice: ApiAuthResult
let bob: ApiAuthResult
let loner: ApiAuthResult

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
  loner = await register('loner', null)
})

after(async () => {
  await stop(s)
  rmSync(dir, { recursive: true, force: true })
})

// ======================================================================
describe('profiles', () => {
  test('editing display name, bio, pronouns and accent color; peers see it live', async () => {
    const watcher = gateway(bob.token)
    await ready(watcher)
    const res = await req('/api/users/me', {
      method: 'PATCH',
      token: alice.token,
      json: {
        displayName: '  Alice   W. ',
        bio: 'Line one\r\nLine two\u0007 \u202Eflipped',
        pronouns: 'she/her',
        accentColor: '#AB12CD'
      }
    })
    const me = await json<ApiMe>(res, 200)
    assert.equal(me.displayName, 'Alice W.')
    assert.equal(me.bio, 'Line one\nLine two flipped', 'CR/LF normalized, control and bidi characters removed')
    assert.equal(me.pronouns, 'she/her')
    assert.equal(me.accentColor, '#ab12cd')
    assert.equal(me.username, 'alice', 'the login name never changes')
    assert.ok(me.createdAt > 0)
    const update = await userUpdate(watcher, alice.user.id, (u) => u.bio === me.bio)
    assert.equal(update.d.pronouns, 'she/her')
    await watcher.close()

    // Clearing optional fields.
    const cleared = await json<ApiMe>(
      await req('/api/users/me', { method: 'PATCH', token: alice.token, json: { pronouns: null, accentColor: null } }),
      200
    )
    assert.equal(cleared.pronouns, null)
    assert.equal(cleared.accentColor, null)
    assert.equal(cleared.bio, me.bio)
  })

  test('profile validation: length, lines, colors, and forged fields', async () => {
    const patch = (body: unknown) => req('/api/users/me', { method: 'PATCH', token: alice.token, json: body })
    assert.equal((await patch({ bio: 'x'.repeat(191) })).status, 400)
    assert.equal((await patch({ bio: Array.from({ length: 9 }, () => 'a').join('\n') })).status, 400)
    assert.equal((await patch({ pronouns: 'p'.repeat(41) })).status, 400)
    assert.equal((await patch({ accentColor: 'red' })).status, 400)
    assert.equal((await patch({ displayName: '   ' })).status, 400)
    assert.equal((await patch({ displayName: 'Eve', id: bob.user.id })).status, 400, 'no forged user id')
    assert.equal((await patch({ username: 'bob' })).status, 400, 'usernames are permanent')
    assert.equal((await patch({})).status, 400)
    assert.equal((await req('/api/users/me', { method: 'PATCH', json: { bio: 'hi' } })).status, 401)
  })

  test('full profile with mutual servers; hidden from people who share no server', async () => {
    const profile = await json<ApiProfile>(await req(`/api/users/${alice.user.id}/profile`, { token: bob.token }), 200)
    assert.equal(profile.user.id, alice.user.id)
    assert.deepEqual(profile.mutualServerIds, ['hangout'])
    assert.equal((await req(`/api/users/${alice.user.id}/profile`, { token: loner.token })).status, 404)
    assert.equal((await req('/api/users/nobody/profile', { token: bob.token })).status, 404)
  })
})

// ======================================================================
describe('profile images', () => {
  test('avatar upload is re-encoded to WebP at fixed sizes with all metadata removed', async () => {
    const withExif = await sharp({ create: { width: 900, height: 700, channels: 3, background: '#ff0000' } })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret-location-data', Artist: 'secret-artist' } })
      .toBuffer()
    assert.ok((await sharp(withExif).metadata()).exif, 'fixture really has EXIF')

    const me = await json<ApiMe>(await upload(alice.token, 'avatar', withExif, 'holiday.jpg'), 200)
    assert.match(me.avatarId ?? '', /^[a-f0-9]{32}$/)

    for (const [size, px] of [['full', 512], ['small', 128]] as const) {
      const res = await req(`/api/profile-media/${me.avatarId}?size=${size}`, { token: bob.token })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'image/webp')
      assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/)
      assert.match(res.headers.get('cache-control') ?? '', /immutable/)
      const body = Buffer.from(await res.arrayBuffer())
      const meta = await sharp(body).metadata()
      assert.equal(meta.format, 'webp')
      assert.equal(meta.width, px)
      assert.equal(meta.height, px)
      assert.equal(meta.exif, undefined, 'EXIF stripped')
      assert.equal(meta.xmp, undefined, 'XMP stripped')
      assert.ok(!body.includes('secret-location-data'))
    }
  })

  test('banners are 1500×600 (and 600×240 thumbnails)', async () => {
    const me = await json<ApiMe>(await upload(alice.token, 'banner', await image(1600, 900, 'webp'), 'b.webp'), 200)
    const full = Buffer.from(await (await req(`/api/profile-media/${me.bannerId}`, { token: alice.token })).arrayBuffer())
    const small = Buffer.from(
      await (await req(`/api/profile-media/${me.bannerId}?size=small`, { token: alice.token })).arrayBuffer()
    )
    assert.deepEqual([(await sharp(full).metadata()).width, (await sharp(full).metadata()).height], [1500, 600])
    assert.deepEqual([(await sharp(small).metadata()).width, (await sharp(small).metadata()).height], [600, 240])
  })

  test('rejects spoofed, malformed, tiny, oversized and decompression-bomb images', async () => {
    const check = async (res: Response, status: number, code?: string) => {
      const text = await res.text()
      assert.equal(res.status, status, text)
      if (code) assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, code)
    }
    await check(await upload(bob.token, 'avatar', 'just text pretending', 'evil.png'), 415, 'unsupported_file_type')
    await check(await upload(bob.token, 'avatar', '%PDF-1.7 not an image', 'doc.png'), 415)
    await check(await upload(bob.token, 'avatar', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'x.svg'), 415)
    const png = await image(256, 256)
    await check(await upload(bob.token, 'avatar', Buffer.concat([png.subarray(0, 40), Buffer.alloc(200, 7)])), 400, 'image_unreadable')
    await check(await upload(bob.token, 'avatar', await image(20, 20)), 400, 'image_too_small')
    await check(await upload(bob.token, 'banner', await image(200, 100)), 400, 'image_too_small')
    await check(await upload(bob.token, 'avatar', pngClaiming(30_000, 30_000)), 413, 'image_too_large')
    await check(await upload(bob.token, 'avatar', Buffer.concat([png, Buffer.alloc(11 * 1024 * 1024)])), 413, 'file_too_large')
    await check(await upload(bob.token, 'avatar', Buffer.alloc(0)), 400)
    await check(await req('/api/users/me/avatar', { method: 'POST', token: bob.token, json: { url: 'http://x' } }), 400)
    await check(await upload('not-a-token', 'avatar', png), 401)
    // Nothing was stored for bob.
    const me = await json<ApiMe>(await req('/api/users/me', { token: bob.token }), 200)
    assert.equal(me.avatarId, null)
  })

  test('GIF and PNG inputs work; animated input is flattened', async () => {
    const me = await json<ApiMe>(await upload(bob.token, 'avatar', await image(300, 300, 'gif'), 'a.gif'), 200)
    assert.ok(me.avatarId)
    const me2 = await json<ApiMe>(await upload(bob.token, 'avatar', await image(300, 200, 'png')), 200)
    assert.notEqual(me2.avatarId, me.avatarId)
  })

  test('replacing or removing an image deletes the old files; ids are unguessable and path-safe', async () => {
    const first = await json<ApiMe>(await upload(alice.token, 'avatar', await image(400, 400)), 200)
    const second = await json<ApiMe>(await upload(alice.token, 'avatar', await image(500, 500)), 200)
    assert.notEqual(first.avatarId, second.avatarId)
    assert.equal((await req(`/api/profile-media/${first.avatarId}`, { token: alice.token })).status, 404)
    const shard = join(attachmentsDir, 'profile', first.avatarId!.slice(0, 2))
    assert.ok(!existsSync(join(shard, `${first.avatarId}.webp`)), 'old file removed')
    assert.ok(existsSync(join(attachmentsDir, 'profile', second.avatarId!.slice(0, 2), `${second.avatarId}.webp`)))

    for (const bad of ['..%2F..%2Fprofiles.db', '..', 'ABCDEF', 'a'.repeat(31), `${second.avatarId}.webp`]) {
      assert.equal((await req(`/api/profile-media/${bad}`, { token: alice.token })).status, 404, bad)
    }
    assert.equal((await req(`/api/profile-media/${second.avatarId}?size=huge`, { token: alice.token })).status, 400)
    assert.equal((await req(`/api/profile-media/${second.avatarId}`)).status, 401, 'authentication required')
    assert.equal((await req(`/api/profile-media/${second.avatarId}`, { token: loner.token })).status, 404, 'no shared server')

    const removed = await json<ApiMe>(await req('/api/users/me/avatar', { method: 'DELETE', token: alice.token }), 200)
    assert.equal(removed.avatarId, null)
    assert.equal((await req(`/api/profile-media/${second.avatarId}`, { token: alice.token })).status, 404)
    assert.ok(!existsSync(join(attachmentsDir, 'profile', second.avatarId!.slice(0, 2), `${second.avatarId}.webp`)))
  })

  test('only the owner can change their images; an instance admin can remove them (audited)', async () => {
    const target = await json<ApiMe>(await upload(bob.token, 'banner', await image(900, 400)), 200)
    // There is no route that takes another user's id for uploads; the session decides.
    assert.equal((await req(`/api/users/${bob.user.id}/banner`, { method: 'DELETE', token: alice.token })).status, 404)
    assert.equal(
      (await req(`/api/admin/accounts/${bob.user.id}/profile-media/banner`, { method: 'DELETE', token: alice.token })).status,
      403
    )
    const watcher = gateway(alice.token)
    await ready(watcher)
    assert.equal(
      (await req(`/api/admin/accounts/${bob.user.id}/profile-media/banner`, { method: 'DELETE', token: adminToken })).status,
      204
    )
    await userUpdate(watcher, bob.user.id, (u) => u.bannerId === null)
    await watcher.close()
    assert.equal((await req(`/api/profile-media/${target.bannerId}`, { token: alice.token })).status, 404)
    const audit = await json<{ action: string; targetUserId: string }[]>(await req('/api/admin/audit', { token: adminToken }), 200)
    assert.ok(audit.some((e) => e.action === 'admin.profile_media_removed' && e.targetUserId === bob.user.id))
  })

  test('orphaned files are swept; referenced files are kept', async () => {
    const me = await json<ApiMe>(await upload(alice.token, 'avatar', await image(256, 256)), 200)
    const orphanId = 'f'.repeat(32)
    await s.ctx.profileMedia.save(orphanId, {
      full: Buffer.from('x'),
      small: Buffer.from('y'),
      width: 1,
      height: 1,
      sha256: 'z'
    })
    const removed = await s.ctx.profileMedia.sweep(await s.repo.listProfileMediaIds(), 0, Date.now() + 1000)
    assert.equal(removed, 2)
    assert.ok(existsSync(s.ctx.profileMedia.pathFor(me.avatarId!, 'full')))
    assert.ok(!existsSync(s.ctx.profileMedia.pathFor(orphanId, 'full')))
  })

  test('format sniffing looks at bytes, not names', () => {
    assert.equal(sniffImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png')
    assert.equal(sniffImageFormat(Buffer.from('GIF89a')), 'gif')
    assert.equal(sniffImageFormat(Buffer.from('RIFF\0\0\0\0WEBP')), 'webp')
    assert.equal(sniffImageFormat(Buffer.from('<svg')), null)
  })
})

// ======================================================================
describe('presence', () => {
  test('multiple devices: idle only when every device is idle; offline only when all disconnect', async () => {
    const watcher = gateway(bob.token)
    await ready(watcher)

    const phone = gateway(alice.token)
    await ready(phone)
    await userUpdate(watcher, alice.user.id, (u) => u.status === 'online')

    phone.send({ op: 'set_idle', d: { idle: true } })
    await userUpdate(watcher, alice.user.id, (u) => u.status === 'idle')

    // Second session of the same account (another PC) is active → online again.
    const second = await login('alice')
    const pc = gateway(second.token)
    await ready(pc)
    await userUpdate(watcher, alice.user.id, (u) => u.status === 'online')

    pc.send({ op: 'set_idle', d: { idle: true } })
    await userUpdate(watcher, alice.user.id, (u) => u.status === 'idle')

    await pc.close()
    await sleep(150)
    assert.notEqual(updatesAbout(watcher, alice.user.id).at(-1)?.status, 'offline', 'still connected on the phone')

    phone.send({ op: 'set_idle', d: { idle: false } })
    await userUpdate(watcher, alice.user.id, (u) => u.status === 'online')
    const before = updatesAbout(watcher, alice.user.id).length
    phone.send({ op: 'set_idle', d: { idle: false } })
    await sleep(150)
    assert.equal(updatesAbout(watcher, alice.user.id).length, before, 'no duplicate events')

    await phone.close()
    await userUpdate(watcher, alice.user.id, (u) => u.status === 'offline')
    await watcher.close()
  })

  test('a device that is already idle when it (re)connects never flashes online', async () => {
    const watcher = gateway(bob.token)
    await ready(watcher)
    const gw = gateway(alice.token, { idle: true })
    await ready(gw)
    await userUpdate(watcher, alice.user.id, (u) => u.status === 'idle')
    assert.ok(!updatesAbout(watcher, alice.user.id).some((u) => u.status === 'online'))
    gw.send({ op: 'set_idle', d: 'yes' })
    assert.equal(await gw.closed, 4003, 'malformed idle frame closes the socket')
    await watcher.close()
  })

  test('invisible: others see offline (no custom status), the user keeps working, and it syncs', async () => {
    const watcher = gateway(bob.token)
    await ready(watcher)
    const pc1 = gateway(alice.token)
    await ready(pc1)
    const second = await login('alice')
    const pc2 = gateway(second.token)
    await ready(pc2)
    await userUpdate(watcher, alice.user.id, (u) => u.status === 'online')

    await json<ApiMe>(
      await req('/api/users/me/status', { method: 'PUT', token: alice.token, json: { customStatus: { text: 'Coding', emoji: '💻' } } }),
      200
    )
    await userUpdate(watcher, alice.user.id, (u) => u.customStatus?.text === 'Coding')

    const me = await json<ApiMe>(
      await req('/api/users/me/status', { method: 'PUT', token: alice.token, json: { status: 'invisible' } }),
      200
    )
    assert.equal(me.statusPreference, 'invisible')
    assert.equal(me.status, 'offline')
    assert.equal(me.ownCustomStatus?.text, 'Coding', 'you still see your own custom status')
    const seen = await userUpdate(watcher, alice.user.id, (u) => u.status === 'offline')
    assert.equal(seen.d.customStatus, null, 'custom status hidden while invisible')
    // Both of Alice's devices learn the new preference.
    await pc1.waitFor((f) => f.op === 'me_update' && f.d.statusPreference === 'invisible')
    await pc2.waitFor((f) => f.op === 'me_update' && f.d.statusPreference === 'invisible')

    // Still fully usable while invisible.
    const sent = await req('/api/channels/hangout-general/messages', { method: 'POST', token: alice.token, json: { content: 'boo' } })
    assert.equal(sent.status, 201)
    await watcher.waitFor((f) => f.op === 'message_create' && f.d.content === 'boo')
    const list = await json<ApiUser[]>(await req('/api/users', { token: bob.token }), 200)
    assert.equal(list.find((u) => u.id === alice.user.id)?.status, 'offline')

    // Changing the custom status or reconnecting while invisible reveals nothing.
    const quiet = updatesAbout(watcher, alice.user.id).length
    await req('/api/users/me/status', { method: 'PUT', token: alice.token, json: { customStatus: { text: 'Secret' } } })
    await pc2.close()
    const pc3 = gateway(second.token)
    await ready(pc3)
    await sleep(200)
    assert.equal(updatesAbout(watcher, alice.user.id).length, quiet, 'no events while invisible')

    await req('/api/users/me/status', { method: 'PUT', token: alice.token, json: { status: 'dnd', customStatus: null } })
    const back = await userUpdate(watcher, alice.user.id, (u) => u.status === 'dnd')
    assert.equal(back.d.customStatus, null)
    await pc1.close()
    await pc3.close()
    await watcher.close()
  })

  test('the legacy gateway set_status op is validated and persisted', async () => {
    const gw = gateway(alice.token)
    await ready(gw)
    gw.send({ op: 'set_status', d: { status: 'idle' } })
    await gw.waitFor((f) => f.op === 'me_update' && f.d.statusPreference === 'idle')
    assert.equal((await s.repo.getUser(alice.user.id))?.statusPreference, 'idle')
    gw.send({ op: 'set_status', d: { status: 'away' } })
    assert.equal(await gw.closed, 4003)
    await req('/api/users/me/status', { method: 'PUT', token: alice.token, json: { status: 'online' } })
  })

  test('status validation', async () => {
    const put = (body: unknown) => req('/api/users/me/status', { method: 'PUT', token: alice.token, json: body })
    assert.equal((await put({ status: 'offline' })).status, 400)
    assert.equal((await put({})).status, 400)
    assert.equal((await put({ customStatus: { text: 'x'.repeat(129) } })).status, 400)
    assert.equal((await put({ customStatus: { emoji: 'abc' } })).status, 400)
    assert.equal((await put({ customStatus: { text: 'hi', expiresInMs: 1000 } })).status, 400, 'at least a minute')
    assert.equal((await put({ customStatus: { text: 'hi', expiresInMs: 8 * 86_400_000 } })).status, 400, 'at most 7 days')
    assert.equal((await put({ customStatus: { text: 'hi', userId: bob.user.id } })).status, 400)
    const empty = await json<ApiMe>(await put({ customStatus: { text: '   ', emoji: null } }), 200)
    assert.equal(empty.ownCustomStatus, null, 'blank status clears it')
  })
})

// ======================================================================
describe('custom status expiry', () => {
  test('expired statuses disappear immediately and are cleared and announced by the sweep', async () => {
    const watcher = gateway(bob.token)
    await ready(watcher)
    const gw = gateway(alice.token)
    await ready(gw)
    const me = await json<ApiMe>(
      await req('/api/users/me/status', {
        method: 'PUT',
        token: alice.token,
        json: { customStatus: { text: 'Lunch', emoji: '🍕', expiresInMs: 30 * 60_000 } }
      }),
      200
    )
    const expiresAt = me.ownCustomStatus?.expiresAt ?? 0
    assert.ok(Math.abs(expiresAt - (Date.now() + 30 * 60_000)) < 5000)
    await userUpdate(watcher, alice.user.id, (u) => u.customStatus?.text === 'Lunch')

    // Not yet expired: the sweep leaves it alone.
    assert.equal(await expireCustomStatuses(s.ctx), 0)

    // Time passes (simulated by moving the expiry into the past).
    const db = (s.repo as unknown as { db: DatabaseSync }).db
    db.prepare('UPDATE users SET custom_status_expires_at = ? WHERE id = ?').run(Date.now() - 1, alice.user.id)
    const list = await json<ApiUser[]>(await req('/api/users', { token: bob.token }), 200)
    assert.equal(list.find((u) => u.id === alice.user.id)?.customStatus, null, 'hidden even before the sweep')

    assert.equal(await expireCustomStatuses(s.ctx), 1)
    await userUpdate(watcher, alice.user.id, (u) => u.customStatus === null && u.status === 'online')
    await gw.waitFor((f) => f.op === 'me_update' && f.d.ownCustomStatus === null)
    const row = await s.repo.getUser(alice.user.id)
    assert.equal(row?.customStatusText, null)
    assert.equal(row?.customStatusExpiresAt, null)
    assert.equal(await expireCustomStatuses(s.ctx), 0)
    await gw.close()
    await watcher.close()
  })

  test('statuses without expiry stay until cleared manually', async () => {
    await req('/api/users/me/status', { method: 'PUT', token: alice.token, json: { customStatus: { text: 'Forever' } } })
    assert.equal(await expireCustomStatuses(s.ctx, Date.now() + 365 * 86_400_000), 0)
    const cleared = await json<ApiMe>(
      await req('/api/users/me/status', { method: 'PUT', token: alice.token, json: { customStatus: null } }),
      200
    )
    assert.equal(cleared.ownCustomStatus, null)
  })
})

// ======================================================================
describe('preferences', () => {
  test('defaults, partial updates, validation, and live sync to the other device', async () => {
    const defaults = await json<ApiPreferences>(await req('/api/users/me/preferences', { token: bob.token }), 200)
    assert.equal(defaults.theme, 'dark')
    assert.equal(defaults.updatedAt, null)

    const otherDevice = gateway(bob.token)
    await ready(otherDevice)
    const saved = await json<ApiPreferences>(
      await req('/api/users/me/preferences', {
        method: 'PATCH',
        token: bob.token,
        json: { theme: 'light', accentColor: '#3BA776', density: 'compact', idleTimeoutMinutes: 15 }
      }),
      200
    )
    assert.equal(saved.theme, 'light')
    assert.equal(saved.accentColor, '#3ba776')
    assert.equal(saved.reducedMotion, 'system', 'untouched fields keep their value')
    assert.ok(saved.updatedAt)
    const pushed = (await otherDevice.waitFor((f) => f.op === 'preferences_update')) as Extract<
      GatewayServerFrame,
      { op: 'preferences_update' }
    >
    assert.equal(pushed.d.density, 'compact')
    await otherDevice.close()

    const patch = (body: unknown) => req('/api/users/me/preferences', { method: 'PATCH', token: bob.token, json: body })
    assert.equal((await patch({ theme: 'neon' })).status, 400)
    assert.equal((await patch({ idleTimeoutMinutes: 0 })).status, 400)
    assert.equal((await patch({ idleTimeoutMinutes: 2.5 })).status, 400)
    assert.equal((await patch({ accentColor: 'javascript:alert(1)' })).status, 400)
    assert.equal((await patch({ fontSize: 99 })).status, 400, 'device-only settings are not stored on the server')
    assert.equal((await patch({})).status, 400)

    // Alice's preferences are separate.
    const alicePrefs = await json<ApiPreferences>(await req('/api/users/me/preferences', { token: alice.token }), 200)
    assert.equal(alicePrefs.theme, 'dark')
  })

  test('stored garbage never breaks parsing', () => {
    assert.equal(parsePreferences({ data: 'not json', updatedAt: 1 }).theme, 'dark')
    const p = parsePreferences({ data: JSON.stringify({ theme: 'light', accentColor: 'nope', idleTimeoutMinutes: 999 }), updatedAt: 5 })
    assert.equal(p.theme, 'light')
    assert.equal(p.accentColor, null)
    assert.equal(p.idleTimeoutMinutes, 10)
    assert.equal(p.updatedAt, 5)
  })
})

// ======================================================================
describe('persistence and migration', () => {
  test('profiles, images, status and preferences survive a backend restart', async () => {
    await req('/api/users/me', { method: 'PATCH', token: alice.token, json: { bio: 'Persistent bio', pronouns: 'they/them' } })
    const withAvatar = await json<ApiMe>(await upload(alice.token, 'avatar', await image(300, 300)), 200)
    await req('/api/users/me/status', {
      method: 'PUT',
      token: alice.token,
      json: { status: 'dnd', customStatus: { text: 'Focus', emoji: '🎧' } }
    })
    await req('/api/users/me/preferences', { method: 'PATCH', token: alice.token, json: { theme: 'system' } })

    await stop(s)
    s = await start()

    const me = await json<ApiMe>(await req('/api/users/me', { token: alice.token }), 200)
    assert.equal(me.bio, 'Persistent bio')
    assert.equal(me.pronouns, 'they/them')
    assert.equal(me.avatarId, withAvatar.avatarId)
    assert.equal(me.statusPreference, 'dnd')
    assert.equal(me.ownCustomStatus?.text, 'Focus')
    assert.equal((await req(`/api/profile-media/${me.avatarId}`, { token: bob.token })).status, 200)
    const prefs = await json<ApiPreferences>(await req('/api/users/me/preferences', { token: alice.token }), 200)
    assert.equal(prefs.theme, 'system')

    // Presence after reconnecting uses the saved preference.
    const watcher = gateway(bob.token)
    await ready(watcher)
    const gw = gateway(alice.token)
    await ready(gw)
    const seen = await userUpdate(watcher, alice.user.id, (u) => u.status === 'dnd')
    assert.equal(seen.d.customStatus?.emoji, '🎧')
    await gw.close()
    await watcher.close()
    await req('/api/users/me/status', { method: 'PUT', token: alice.token, json: { status: 'online', customStatus: null } })
  })

  test('migration v4 is additive: a Milestone 7 database upgrades with nothing lost', async () => {
    const file = join(dir, 'm7.db')
    const db = new DatabaseSync(file)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
    for (const m of sqliteMigrations.filter((x) => x.version <= 3)) {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, 1)
    }
    db.prepare("INSERT INTO users (id, username, display_name, avatar_color, is_bot, created_at, instance_admin) VALUES ('u1', 'thereallsaint', 'Saint', '#6d72f6', 0, 1000, 1)").run()
    db.prepare("INSERT INTO users (id, username, display_name, avatar_color, is_bot, created_at) VALUES ('u2', 'lsaint06', 'L', '#3ba776', 0, 2000)").run()
    db.prepare("INSERT INTO credentials (user_id, password_hash, created_at, updated_at) VALUES ('u1', 'phc', 1, 1)").run()
    db.prepare("INSERT INTO servers (id, name, color, owner_id, position, created_at) VALUES ('s1', 'Home', '#111111', 'u1', 0, 1)").run()
    db.prepare("INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES ('s1', 'u1', 'owner', 1), ('s1', 'u2', 'member', 1)").run()
    db.prepare("INSERT INTO channels (id, server_id, name, type, topic, category, position, created_at) VALUES ('c1', 's1', 'general', 'text', NULL, 'Text', 0, 1)").run()
    db.prepare("INSERT INTO messages (channel_id, author_id, content, created_at) VALUES ('c1', 'u2', 'hello from M7', 5)").run()
    db.prepare("INSERT INTO attachments (id, message_id, channel_id, uploader_id, filename, content_type, kind, size, sha256, created_at) VALUES ('a1', 1, 'c1', 'u2', 'pic.png', 'image/png', 'image', 10, 'h', 6)").run()
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, id, kind, expires_at) VALUES ('th', 'u1', 1, 1, 'sid', 'password', 99999999999999)").run()
    db.close()

    const repo = new SqliteRepository(file)
    await repo.migrate()
    await repo.migrate() // idempotent
    const u1 = await repo.getUser('u1')
    assert.equal(u1?.username, 'thereallsaint')
    assert.equal(u1?.displayName, 'Saint')
    assert.equal(u1?.instanceAdmin, true)
    assert.equal(u1?.statusPreference, 'online')
    assert.equal(u1?.bio, null)
    assert.equal(u1?.avatarId, null)
    assert.equal(u1?.createdAt, 1000)
    assert.equal(await repo.getPasswordHash('u1'), 'phc')
    assert.equal((await repo.listMessages('c1', { limit: 10 }))[0]?.content, 'hello from M7')
    assert.equal((await repo.getAttachment('a1'))?.filename, 'pic.png')
    assert.equal((await repo.findSession('th'))?.user.id, 'u1', 'existing sessions keep working')
    assert.deepEqual(await repo.mutualServerIds('u1', 'u2'), ['s1'])
    const raw = (repo as unknown as { db: DatabaseSync }).db
    const versions = raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version))
    assert.deepEqual(versions, sqliteMigrations.map((m) => m.version))
    assert.equal(raw.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')
    assert.equal(raw.prepare('PRAGMA foreign_key_check').all().length, 0)
    // Milestone 7 code paths (no knowledge of the new columns) still work.
    raw.prepare("INSERT INTO users (id, username, display_name, avatar_color, is_bot, created_at) VALUES ('u3', 'newbie', 'N', '#000000', 0, 3)").run()
    assert.equal((await repo.getUser('u3'))?.statusPreference, 'online')
    await repo.close()
  })
})

// The repository stores session token hashes; this mirrors auth/secrets.sha256Hex for the M7 row above.
function sha(value: string): string {
  return value
}

test('profile files live inside the attachments directory (the data volume)', () => {
  const root = join(attachmentsDir, 'profile')
  assert.ok(existsSync(root))
  assert.ok(readdirSync(root).every((name) => /^[a-f0-9]{2}$/.test(name)))
})
