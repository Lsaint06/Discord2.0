/**
 * Milestone 14 tests: profile styles (gradient, decoration, effect, banner preset), the synced
 * full-app theme, animated profile pictures/banners (crop, frame and size limits, still frame),
 * and migration 9.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { buildApp } from '../src/app.js'
import { HashGate, OWASP_MINIMUM, PasswordHasher } from '../src/auth/password.js'
import { loadConfig } from '../src/config.js'
import type { AppContext } from '../src/context.js'
import { seedIfEmpty } from '../src/db/seed.js'
import { SqliteRepository } from '../src/db/sqlite.js'
import { TokenBucketLimiter } from '../src/lib/rateLimit.js'
import { normalizeProfileStyle } from '../src/lib/validation.js'
import { parsePreferences } from '../src/routes/profile.js'
import {
  APP_THEMES,
  AVATAR_DECORATIONS,
  BANNER_PRESETS,
  NAME_STYLES,
  PROFILE_EFFECTS,
  type ApiAuthResult,
  type ApiMe,
  type ApiPreferences,
  type ApiProfile
} from '../src/protocol.js'

const SCHEME = ['Bea', 'rer'].join('')
const HASHER = new PasswordHasher(OWASP_MINIMUM, new HashGate(4, 64))
const PASSWORD = 'violet-anchor-sunrise-42'

const dir = mkdtempSync(join(tmpdir(), 'd2-custom-'))

let app: FastifyInstance
let ctx: AppContext
let repo: SqliteRepository
let base = ''
let adminToken = ''
let alice: ApiAuthResult
let bob: ApiAuthResult
let loner: ApiAuthResult

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

const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code

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

/** An animated image: `frames` solid-colour frames of width × height. */
async function animation(
  width: number,
  height: number,
  frames: number,
  format: 'gif' | 'webp' = 'gif'
): Promise<Buffer> {
  const colors = ['#ff3355', '#33dd77', '#3366ff', '#ffcc22']
  const raw = Buffer.alloc(width * height * frames * 4)
  for (let f = 0; f < frames; f++) {
    const hex = colors[f % colors.length]!
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    for (let p = 0; p < width * height; p++) {
      const o = (f * width * height + p) * 4
      raw[o] = r!
      raw[o + 1] = g!
      raw[o + 2] = b!
      raw[o + 3] = 255
    }
  }
  const img = sharp(raw, { raw: { width, height: height * frames, channels: 4, pageHeight: height } })
  return format === 'gif'
    ? img.gif({ loop: 0, delay: Array(frames).fill(80) }).toBuffer()
    : img.webp({ loop: 0, delay: Array(frames).fill(80) }).toBuffer()
}

async function upload(
  token: string,
  kind: 'avatar' | 'banner',
  data: Buffer,
  fields: Record<string, string | number> = {},
  name = 'x.gif'
) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v))
  form.append('file', new Blob([data]), name)
  return req(`/api/users/me/${kind}`, { method: 'POST', token, body: form })
}

async function media(token: string, id: string, size: 'full' | 'small' | 'still') {
  const res = await req(`/api/profile-media/${id}?size=${size}`, { token })
  assert.equal(res.status, 200)
  const bytes = Buffer.from(await res.arrayBuffer())
  const meta = await sharp(bytes, { animated: true }).metadata()
  return { bytes, pages: meta.pages ?? 1, width: meta.width, height: meta.pageHeight ?? meta.height }
}

before(async () => {
  repo = new SqliteRepository(join(dir, 'custom.db'))
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
  const admin = await repo.provisionAccount(
    { id: 'admin-1', username: 'root', displayName: 'Root', avatarColor: '#111111', bot: false, createdAt: now },
    await HASHER.hash(PASSWORD),
    now
  )
  for (const server of await repo.listServers()) await repo.setOwner(server.id, admin.id, now)
  adminToken = (await login('root')).token
  alice = await register('alice')
  bob = await register('bob')
  loner = await register('loner', null)
})

after(async () => {
  await app.close()
  await repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('meta and migration', () => {
  test('API 6 advertises customization', async () => {
    const meta = await json<{ apiVersion: number; customization: boolean }>(await req('/api/meta'), 200)
    assert.equal(meta.apiVersion, 6)
    assert.equal(meta.customization, true)
  })

  test('migration 9 adds the three user columns with safe defaults', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'custom.db'), { readOnly: true })
    try {
      const cols = db.prepare('PRAGMA table_info(users)').all().map((r) => String(r.name))
      for (const c of ['profile_style', 'avatar_animated', 'banner_animated']) assert.ok(cols.includes(c), c)
      const v = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }
      assert.ok(v.v >= 9)
    } finally {
      db.close()
    }
  })

  test('existing accounts have no style and nothing animated', async () => {
    const me = await json<ApiMe>(await req('/api/users/me', { token: bob.token }), 200)
    assert.equal(me.profileStyle, null)
    assert.equal(me.avatarAnimated, false)
    assert.equal(me.bannerAnimated, false)
  })
})

describe('profile style', () => {
  test('saved, normalized and visible to people who share a server', async () => {
    const me = await json<ApiMe>(
      await req('/api/users/me', {
        method: 'PATCH',
        token: alice.token,
        json: {
          profileStyle: {
            colors: ['#FF8800', '#3355ff'],
            angle: 135,
            decoration: 'star-orbit',
            effect: 'meteor-shower',
            banner: 'aurora',
            nameStyle: 'gold'
          }
        }
      }),
      200
    )
    assert.deepEqual(me.profileStyle, {
      colors: ['#ff8800', '#3355ff'],
      angle: 135,
      decoration: 'star-orbit',
      effect: 'meteor-shower',
      banner: 'aurora',
      nameStyle: 'gold'
    })
    const seen = await json<ApiProfile>(
      await req(`/api/users/${alice.user.id}/profile`, { token: bob.token }),
      200
    )
    assert.equal(seen.user.profileStyle?.decoration, 'star-orbit')
    // Someone who can't see Alice still can't read her profile.
    assert.equal((await req(`/api/users/${alice.user.id}/profile`, { token: loner.token })).status, 404)
  })

  test('every allow-listed id is accepted', async () => {
    const longest = Math.max(AVATAR_DECORATIONS.length, PROFILE_EFFECTS.length, BANNER_PRESETS.length, NAME_STYLES.length)
    for (let i = 0; i < longest; i++) {
      const style = {
        colors: [],
        angle: 0,
        decoration: AVATAR_DECORATIONS[i % AVATAR_DECORATIONS.length],
        effect: PROFILE_EFFECTS[i % PROFILE_EFFECTS.length],
        banner: BANNER_PRESETS[i % BANNER_PRESETS.length],
        nameStyle: NAME_STYLES[i % NAME_STYLES.length]
      }
      assert.deepEqual(normalizeProfileStyle(style), style)
    }
  })

  test('invalid styles are refused with a clear code', async () => {
    const bad: unknown[] = [
      { decoration: 'nitro-exclusive' },
      { effect: '../../etc/passwd' },
      { banner: 42 },
      { nameStyle: 'rainbow-paid' },
      { colors: ['#fff', '#000000'] },
      { colors: ['#111111', '#222222', '#333333', '#444444'] },
      { colors: 'red' },
      { angle: 360 },
      { angle: 12.5 },
      { css: 'background:url(http://evil)' }
    ]
    for (const profileStyle of bad) {
      const res = await req('/api/users/me', { method: 'PATCH', token: bob.token, json: { profileStyle } })
      assert.equal(res.status, 400, JSON.stringify(profileStyle))
      assert.equal(await errorCode(res), 'invalid_profile_style', JSON.stringify(profileStyle))
    }
    const notObject = await req('/api/users/me', { method: 'PATCH', token: bob.token, json: { profileStyle: 'x' } })
    assert.equal(notObject.status, 400)
    const me = await json<ApiMe>(await req('/api/users/me', { token: bob.token }), 200)
    assert.equal(me.profileStyle, null)
  })

  test('null or an empty style clears it', async () => {
    let me = await json<ApiMe>(
      await req('/api/users/me', { method: 'PATCH', token: bob.token, json: { profileStyle: { effect: 'winter-snow' } } }),
      200
    )
    assert.equal(me.profileStyle?.effect, 'winter-snow')
    assert.equal(me.profileStyle?.angle, 180)
    me = await json<ApiMe>(
      await req('/api/users/me', { method: 'PATCH', token: bob.token, json: { profileStyle: { colors: [] } } }),
      200
    )
    assert.equal(me.profileStyle, null)
    await json<ApiMe>(
      await req('/api/users/me', { method: 'PATCH', token: bob.token, json: { profileStyle: { effect: 'golden-sparks' } } }),
      200
    )
    me = await json<ApiMe>(
      await req('/api/users/me', { method: 'PATCH', token: bob.token, json: { profileStyle: null } }),
      200
    )
    assert.equal(me.profileStyle, null)
  })

  test('a corrupted stored style reads as none instead of failing', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'custom.db'))
    db.prepare("UPDATE users SET profile_style = '{\"decoration\":\"bogus\"' WHERE id = ?").run(bob.user.id)
    db.close()
    const me = await json<ApiMe>(await req('/api/users/me', { token: bob.token }), 200)
    assert.equal(me.profileStyle, null)
  })
})

describe('full-app theme preference', () => {
  test('every theme is accepted, synced and cleared', async () => {
    for (const appTheme of APP_THEMES) {
      const saved = await json<ApiPreferences>(
        await req('/api/users/me/preferences', { method: 'PATCH', token: alice.token, json: { appTheme } }),
        200
      )
      assert.equal(saved.appTheme, appTheme)
    }
    const read = await json<ApiPreferences>(await req('/api/users/me/preferences', { token: alice.token }), 200)
    assert.equal(read.appTheme, APP_THEMES[APP_THEMES.length - 1])
    const cleared = await json<ApiPreferences>(
      await req('/api/users/me/preferences', { method: 'PATCH', token: alice.token, json: { appTheme: null } }),
      200
    )
    assert.equal(cleared.appTheme, null)
    // Other preferences are untouched by theme changes.
    assert.equal(cleared.theme, 'dark')
  })

  test('unknown themes are refused; stored garbage reads as classic', async () => {
    const res = await req('/api/users/me/preferences', { method: 'PATCH', token: alice.token, json: { appTheme: 'paid-only' } })
    assert.equal(res.status, 400)
    assert.equal(parsePreferences({ data: '{"appTheme":"nope"}', updatedAt: 1 }).appTheme, null)
    assert.equal(parsePreferences({ data: '{"appTheme":"solar"}', updatedAt: 1 }).appTheme, 'solar')
    // Preferences saved by older servers (no appTheme) stay valid.
    assert.equal(parsePreferences({ data: '{"theme":"light"}', updatedAt: 1 }).appTheme, null)
  })
})

describe('animated profile images', () => {
  test('an animated GIF avatar stays animated, cropped, with a still frame', async () => {
    const gif = await animation(240, 200, 3)
    const me = await json<ApiMe>(
      await upload(alice.token, 'avatar', gif, { cropLeft: 20, cropTop: 0, cropWidth: 200, cropHeight: 200 }),
      200
    )
    assert.ok(me.avatarId)
    assert.equal(me.avatarAnimated, true)
    const full = await media(bob.token, me.avatarId, 'full')
    assert.equal(full.pages, 3)
    assert.equal(full.width, 320)
    assert.equal(full.height, 320)
    const small = await media(bob.token, me.avatarId, 'small')
    assert.equal(small.pages, 3)
    assert.equal(small.width, 128)
    const still = await media(bob.token, me.avatarId, 'still')
    assert.equal(still.pages, 1)
    assert.equal(still.width, 512)
    // Others see the flag too.
    const seen = await json<ApiProfile>(await req(`/api/users/${alice.user.id}/profile`, { token: bob.token }), 200)
    assert.equal(seen.user.avatarAnimated, true)
  })

  test('an animated WebP banner keeps its 5:2 crop', async () => {
    const webp = await animation(600, 300, 2, 'webp')
    const me = await json<ApiMe>(
      await upload(alice.token, 'banner', webp, { cropLeft: 0, cropTop: 30, cropWidth: 600, cropHeight: 240 }, 'b.webp'),
      200
    )
    assert.equal(me.bannerAnimated, true)
    const full = await media(alice.token, me.bannerId!, 'full')
    assert.equal(full.pages, 2)
    assert.equal(full.width, 960)
    assert.equal(full.height, 384)
  })

  test('a still picture is not animated; its still frame is the picture itself', async () => {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#224488' } }).png().toBuffer()
    const me = await json<ApiMe>(await upload(alice.token, 'avatar', png, {}, 'p.png'), 200)
    assert.equal(me.avatarAnimated, false)
    const full = await media(alice.token, me.avatarId!, 'full')
    const still = await media(alice.token, me.avatarId!, 'still')
    assert.deepEqual(still.bytes, full.bytes)
  })

  test('removing an animated picture clears the flag', async () => {
    await json<ApiMe>(await upload(bob.token, 'avatar', await animation(128, 128, 2)), 200)
    const me = await json<ApiMe>(await req('/api/users/me/avatar', { method: 'DELETE', token: bob.token }), 200)
    assert.equal(me.avatarId, null)
    assert.equal(me.avatarAnimated, false)
  })

  test('too many frames are refused before decoding', async () => {
    const res = await upload(bob.token, 'avatar', await animation(64, 64, 301))
    assert.equal(res.status, 413)
    assert.equal(await errorCode(res), 'image_too_large')
  })

  test('crops outside the image, of the wrong shape or malformed are refused', async () => {
    const gif = await animation(200, 200, 2)
    const outside = await upload(bob.token, 'avatar', gif, { cropLeft: 100, cropTop: 0, cropWidth: 200, cropHeight: 200 })
    assert.equal(outside.status, 400)
    assert.equal(await errorCode(outside), 'image_unreadable')
    const shape = await upload(bob.token, 'avatar', gif, { cropLeft: 0, cropTop: 0, cropWidth: 200, cropHeight: 100 })
    assert.equal(shape.status, 400)
    const malformed = await upload(bob.token, 'avatar', gif, { cropLeft: '-1', cropTop: 0, cropWidth: 200, cropHeight: 200 })
    assert.equal(malformed.status, 400)
    assert.equal(await errorCode(malformed), 'invalid_crop')
    const partial = await upload(bob.token, 'avatar', gif, { cropLeft: 0 })
    assert.equal(partial.status, 400)
    const me = await json<ApiMe>(await req('/api/users/me', { token: bob.token }), 200)
    assert.equal(me.avatarId, null)
  })
})
