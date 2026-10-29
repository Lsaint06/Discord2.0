/**
 * Milestone 13 server administration: description and default notifications, server icons,
 * channel layout (categories and order), voice user limits, member timeouts (backend
 * enforcement everywhere), the timeout sweeper and migration 7.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { AccessToken } from 'livekit-server-sdk'
import sharp from 'sharp'
import { buildApp } from '../src/app.js'
import { HashGate, OWASP_MINIMUM, PasswordHasher } from '../src/auth/password.js'
import { loadConfig } from '../src/config.js'
import type { AppContext } from '../src/context.js'
import { sqliteMigrations } from '../src/db/migrations.js'
import { seedIfEmpty } from '../src/db/seed.js'
import { SqliteRepository } from '../src/db/sqlite.js'
import { applyTimeout, MODERATOR_DEFAULT } from '../src/lib/permissions.js'
import { TokenBucketLimiter } from '../src/lib/rateLimit.js'
import { normalizeServerDescription } from '../src/lib/validation.js'
import { expireTimeouts } from '../src/routes/serverAdmin.js'
import { voiceAuthorizer } from '../src/voice/enforce.js'
import { roomNameForChannel } from '../src/voice/access.js'
import { SEAT_HOLD_MS } from '../src/voice/seats.js'
import {
  Permissions,
  type ApiMember,
  type ApiMessage,
  type ApiServer,
  type ApiServerInvite,
  type GatewayServerFrame
} from '../src/protocol.js'

const SCHEME = ['Bea', 'rer'].join('')
const HASHER = new PasswordHasher(OWASP_MINIMUM, new HashGate(4, 64))
const dir = mkdtempSync(join(tmpdir(), 'd2-server-admin-'))
const dbFile = join(dir, 'admin.db')

let app: FastifyInstance
let ctx: AppContext
let repo: SqliteRepository
let base = ''

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

async function devLogin(username: string): Promise<{ token: string; id: string }> {
  const body = await json<{ token: string; user: { id: string } }>(
    await req('/api/dev/login', { method: 'POST', json: { username } }),
    200
  )
  return { token: body.token, id: body.user.id }
}

function gateway(token: string) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/gateway')
  const frames: GatewayServerFrame[] = []
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as GatewayServerFrame
    frames.push(frame)
    if (frame.op === 'hello') ws.send(JSON.stringify({ op: 'identify', d: { token } }))
  })
  const waitFor = async (pred: (f: GatewayServerFrame) => boolean, ms = 3000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const found = frames.find(pred)
      if (found) return found
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error('timed out waiting for frame')
  }
  return { ws, frames, waitFor }
}

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#cc6633' } }).png().toBuffer()

function upload(path: string, token: string, data: Buffer | string, name = 'icon.png') {
  const form = new FormData()
  form.append('file', new Blob([typeof data === 'string' ? data : new Uint8Array(data)]), name)
  return req(path, { method: 'POST', token, body: form })
}

interface Person {
  token: string
  id: string
}

let owner: Person
let admin: Person
let mod: Person
let member: Person
let outsider: Person
let serverId = ''
let textId = ''
let voiceId = ''

const view = async (who: Person): Promise<ApiServer> =>
  (await json<ApiServer[]>(await req('/api/servers', { token: who.token }), 200)).find((x) => x.id === serverId)!

before(async () => {
  repo = new SqliteRepository(dbFile)
  await repo.migrate()
  await seedIfEmpty(repo)
  const config = loadConfig({
    NODE_ENV: 'test',
    DEV_AUTH: 'true',
    LOG_LEVEL: 'silent',
    ATTACHMENTS_DIR: join(dir, 'attachments'),
    LIVEKIT_API_KEY: 'test-key',
    LIVEKIT_API_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    LIVEKIT_URL: 'http://127.0.0.1:9',
    LIVEKIT_PUBLIC_URL: 'ws://127.0.0.1:7880'
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

  owner = await devLogin('adm_owner')
  admin = await devLogin('adm_admin')
  mod = await devLogin('adm_mod')
  member = await devLogin('adm_member')
  outsider = await devLogin('adm_outsider')
  const server = await json<ApiServer>(
    await req('/api/servers', { method: 'POST', token: owner.token, json: { name: 'Admin Lab', color: '#225588' } }),
    201
  )
  serverId = server.id
  textId = server.channels.find((c) => c.type === 'text')!.id
  voiceId = server.channels.find((c) => c.type === 'voice')!.id
  const invite = await json<ApiServerInvite>(
    await req(`/api/servers/${serverId}/invites`, { method: 'POST', token: owner.token, json: { maxUses: 3 } }),
    201
  )
  for (const p of [admin, mod, member]) {
    await json(await req('/api/invites/accept', { method: 'POST', token: p.token, json: { code: invite.code } }), 200)
  }
  await json(await req(`/api/servers/${serverId}/members/${admin.id}`, { method: 'PATCH', token: owner.token, json: { role: 'admin' } }), 200)
  await json(await req(`/api/servers/${serverId}/members/${mod.id}`, { method: 'PATCH', token: owner.token, json: { role: 'moderator' } }), 200)
})

after(async () => {
  await app.close()
  await repo.close()
  rmSync(dir, { recursive: true, force: true })
})

// ======================================================================
describe('server overview: description and default notifications', () => {
  test('meta advertises API 5 with server administration', async () => {
    const meta = (await (await fetch(`${base}/api/meta`)).json()) as { apiVersion: number; serverAdmin: boolean }
    assert.ok(meta.apiVersion >= 5)
    assert.equal(meta.serverAdmin, true)
  })

  test('Manage Server can set them; members see them; others are refused', async () => {
    const before = await view(member)
    assert.equal(before.description, null)
    assert.equal(before.defaultNotifications, 'all')

    const updated = await json<ApiServer>(
      await req(`/api/servers/${serverId}`, {
        method: 'PATCH',
        token: admin.token,
        json: { description: '  Weekend games\r\n\r\n\r\nand  chill \u202e ', defaultNotifications: 'mentions' }
      }),
      200
    )
    assert.equal(updated.description, 'Weekend games\n\nand chill')
    assert.equal(updated.defaultNotifications, 'mentions')
    const seen = await view(member)
    assert.equal(seen.description, 'Weekend games\n\nand chill')
    assert.equal(seen.defaultNotifications, 'mentions')

    assert.equal((await req(`/api/servers/${serverId}`, { method: 'PATCH', token: member.token, json: { description: 'mine now' } })).status, 403)
    assert.equal((await req(`/api/servers/${serverId}`, { method: 'PATCH', token: mod.token, json: { defaultNotifications: 'all' } })).status, 403)
    assert.equal((await req(`/api/servers/${serverId}`, { method: 'PATCH', token: outsider.token, json: { description: 'x' } })).status, 404)
    assert.equal((await req(`/api/servers/${serverId}`, { method: 'PATCH', token: owner.token, json: { defaultNotifications: 'nothing' } })).status, 400)
    assert.equal((await req(`/api/servers/${serverId}`, { method: 'PATCH', token: owner.token, json: { description: 'x'.repeat(301) } })).status, 400)
    assert.equal((await req(`/api/servers/${serverId}`, { method: 'PATCH', token: owner.token, json: {} })).status, 400)

    // Clearing works; the audit log records the change without copying the text.
    const cleared = await json<ApiServer>(await req(`/api/servers/${serverId}`, { method: 'PATCH', token: owner.token, json: { description: null } }), 200)
    assert.equal(cleared.description, null)
    const audit = await json<{ action: string; detail: Record<string, unknown> | null }[]>(await req(`/api/servers/${serverId}/audit`, { token: owner.token }), 200)
    const entry = audit.find((e) => e.action === 'server.update' && e.detail?.defaultNotifications === 'mentions')
    assert.ok(entry)
    assert.equal(entry.detail?.description, true, 'only whether a description was set')
  })

  test('description normalization', () => {
    assert.equal(normalizeServerDescription(null), null)
    assert.equal(normalizeServerDescription('   '), null)
    assert.equal(normalizeServerDescription('a\u0000b\u0007c'), 'abc')
    assert.equal(normalizeServerDescription('line one  \n  line two'), 'line one\nline two')
    assert.throws(() => normalizeServerDescription(42))
  })
})

// ======================================================================
describe('server icon', () => {
  test('upload, members-only download, replace, remove', async () => {
    const res = await upload(`/api/servers/${serverId}/icon`, admin.token, await png(300, 200))
    const server = await json<ApiServer>(res, 200)
    assert.match(server.iconId ?? '', /^[a-f0-9]{32}$/)
    const first = server.iconId!
    assert.equal((await view(member)).iconId, first)

    const full = await req(`/api/server-icons/${first}`, { token: member.token })
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('content-type'), 'image/webp')
    const meta = await sharp(Buffer.from(await full.arrayBuffer())).metadata()
    assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 512, 512])
    const small = await sharp(Buffer.from(await (await req(`/api/server-icons/${first}?size=small`, { token: member.token })).arrayBuffer())).metadata()
    assert.deepEqual([small.width, small.height], [128, 128])

    // Non-members can't fetch it, and ids are checked before touching the disk.
    assert.equal((await req(`/api/server-icons/${first}`, { token: outsider.token })).status, 404)
    assert.equal((await req('/api/server-icons/..%2F..%2Fd2.db', { token: member.token })).status, 404)
    assert.equal((await req(`/api/server-icons/${first}`)).status, 401)

    // Only Manage Server; only real images; the original upload is never kept.
    assert.equal((await upload(`/api/servers/${serverId}/icon`, member.token, await png(100, 100))).status, 403)
    assert.equal((await upload(`/api/servers/${serverId}/icon`, outsider.token, await png(100, 100))).status, 404)
    assert.equal((await upload(`/api/servers/${serverId}/icon`, owner.token, 'not an image', 'evil.png')).status, 415)
    assert.equal(await errorCode(await upload(`/api/servers/${serverId}/icon`, owner.token, await png(32, 32))), 'image_too_small')

    // Replacing deletes the old files; removing clears the icon.
    const replaced = await json<ApiServer>(await upload(`/api/servers/${serverId}/icon`, owner.token, await png(128, 128)), 200)
    assert.notEqual(replaced.iconId, first)
    assert.equal((await req(`/api/server-icons/${first}`, { token: member.token })).status, 404)
    assert.equal(existsSync(ctx.serverIcons.pathFor(first, 'full')), false)
    assert.equal((await req(`/api/servers/${serverId}/icon`, { method: 'DELETE', token: member.token })).status, 403)
    const removed = await json<ApiServer>(await req(`/api/servers/${serverId}/icon`, { method: 'DELETE', token: owner.token }), 200)
    assert.equal(removed.iconId, null)
    assert.equal(existsSync(ctx.serverIcons.pathFor(replaced.iconId!, 'full')), false)
    const audit = await json<{ action: string }[]>(await req(`/api/servers/${serverId}/audit`, { token: owner.token }), 200)
    assert.ok(audit.some((e) => e.action === 'server.icon_changed'))
    assert.ok(audit.some((e) => e.action === 'server.icon_removed'))
  })
})

// ======================================================================
describe('channel layout (categories and order)', () => {
  test('reorders and recategorizes; hidden channels keep their place; stale lists are refused', async () => {
    const extra = await json<{ id: string }>(
      await req(`/api/servers/${serverId}/channels`, { method: 'POST', token: owner.token, json: { name: 'clips', type: 'text', category: '  🎮   Games ' } }),
      201
    )
    const hidden = await json<{ id: string }>(
      await req(`/api/servers/${serverId}/channels`, { method: 'POST', token: owner.token, json: { name: 'staff', type: 'text' } }),
      201
    )
    // Admins can't see the staff channel (hidden from the admin role).
    await json(await req(`/api/channels/${hidden.id}/overrides/admin`, { method: 'PUT', token: owner.token, json: { allow: 0, deny: Permissions.viewChannel } }), 200)
    const ownerBefore = await view(owner)
    assert.equal(ownerBefore.channels.find((c) => c.id === extra.id)?.category, '🎮 Games')
    const hiddenBefore = ownerBefore.channels.find((c) => c.id === hidden.id)!

    const adminView = await view(admin)
    assert.ok(!adminView.channels.some((c) => c.id === hidden.id))
    // New order: clips first in "Highlights", then voice, then general.
    const order = [
      { id: extra.id, category: 'Highlights' },
      { id: voiceId, category: 'Voice Channels' },
      { id: textId, category: 'Text Channels' }
    ]
    assert.equal(adminView.channels.length, 3)
    const arranged = await json<ApiServer>(await req(`/api/servers/${serverId}/layout`, { method: 'PUT', token: admin.token, json: { channels: order } }), 200)
    const sorted = [...arranged.channels].sort((a, b) => a.position - b.position).map((c) => c.id)
    assert.deepEqual(sorted, [extra.id, voiceId, textId])
    assert.equal(arranged.channels.find((c) => c.id === extra.id)?.category, 'Highlights')
    const hiddenAfter = (await view(owner)).channels.find((c) => c.id === hidden.id)!
    assert.equal(hiddenAfter.position, hiddenBefore.position, 'hidden channel untouched')
    assert.equal(hiddenAfter.category, hiddenBefore.category)

    // The list must be exactly what you can see.
    const stale = await req(`/api/servers/${serverId}/layout`, { method: 'PUT', token: admin.token, json: { channels: order.slice(1) } })
    assert.equal(stale.status, 409)
    assert.equal(await errorCode(stale), 'layout_changed')
    const probing = await req(`/api/servers/${serverId}/layout`, { method: 'PUT', token: admin.token, json: { channels: [...order.slice(1), { id: hidden.id, category: 'X' }] } })
    assert.equal(probing.status, 409, 'a hidden channel id is not accepted')
    assert.equal((await req(`/api/servers/${serverId}/layout`, { method: 'PUT', token: admin.token, json: { channels: [order[0], order[0], order[2]] } })).status, 400)
    assert.equal((await req(`/api/servers/${serverId}/layout`, { method: 'PUT', token: admin.token, json: { channels: order.map((c) => ({ ...c, category: '   ' })) } })).status, 400)
    // Members (no Manage Channels) and outsiders are refused.
    assert.equal((await req(`/api/servers/${serverId}/layout`, { method: 'PUT', token: member.token, json: { channels: order } })).status, 403)
    assert.equal((await req(`/api/servers/${serverId}/layout`, { method: 'PUT', token: outsider.token, json: { channels: order } })).status, 404)
    await json(await req(`/api/channels/${hidden.id}`, { method: 'DELETE', token: owner.token }), 204)
    await json(await req(`/api/channels/${extra.id}`, { method: 'DELETE', token: owner.token }), 204)
  })
})

// ======================================================================
describe('voice user limit', () => {
  test('only voice channels, 0-99, Manage Channels only', async () => {
    const updated = await json<{ userLimit: number }>(await req(`/api/channels/${voiceId}`, { method: 'PATCH', token: admin.token, json: { userLimit: 2 } }), 200)
    assert.equal(updated.userLimit, 2)
    assert.equal((await view(member)).channels.find((c) => c.id === voiceId)?.userLimit, 2)
    assert.equal((await view(member)).channels.find((c) => c.id === textId)?.userLimit, undefined)
    assert.equal((await req(`/api/channels/${textId}`, { method: 'PATCH', token: admin.token, json: { userLimit: 2 } })).status, 400)
    assert.equal((await req(`/api/channels/${voiceId}`, { method: 'PATCH', token: admin.token, json: { userLimit: 100 } })).status, 400)
    assert.equal((await req(`/api/channels/${voiceId}`, { method: 'PATCH', token: admin.token, json: { userLimit: -1 } })).status, 400)
    assert.equal((await req(`/api/channels/${voiceId}`, { method: 'PATCH', token: member.token, json: { userLimit: 0 } })).status, 403)
  })

  test('a full channel refuses tokens (seats held for joiners); managers may still join', async () => {
    await json(await req(`/api/channels/${voiceId}`, { method: 'PATCH', token: owner.token, json: { userLimit: 1 } }), 200)
    // Someone already in the room (as LiveKit reports it).
    ctx.voice.store.join(member.id, voiceId)
    const full = await req(`/api/voice/channels/${voiceId}/token`, { method: 'POST', token: mod.token })
    assert.equal(full.status, 403)
    assert.equal(await errorCode(full), 'channel_full')
    // Rejoining your own seat is fine.
    await json(await req(`/api/voice/channels/${voiceId}/token`, { method: 'POST', token: member.token }), 200)
    // Manage Channels bypasses the limit.
    await json(await req(`/api/voice/channels/${voiceId}/token`, { method: 'POST', token: admin.token }), 200)
    ctx.voice.store.leave(member.id, voiceId)
    // The admin's token now holds the only seat for a short while (not yet in the room).
    assert.equal((await req(`/api/voice/channels/${voiceId}/token`, { method: 'POST', token: mod.token })).status, 403)
    assert.ok(SEAT_HOLD_MS <= 60_000)

    await json(await req(`/api/channels/${voiceId}`, { method: 'PATCH', token: owner.token, json: { userLimit: 0 } }), 200)
    await json(await req(`/api/voice/channels/${voiceId}/token`, { method: 'POST', token: mod.token }), 200)
  })

  test('someone connecting late with an older token is turned away from a full channel', async () => {
    await json(await req(`/api/channels/${voiceId}`, { method: 'PATCH', token: owner.token, json: { userLimit: 1 } }), 200)
    // LiveKit's signed "participant joined" webhook.
    const connects = async (who: Person): Promise<void> => {
      const body = JSON.stringify({
        event: 'participant_joined',
        id: `join-${who.id}-${Date.now()}`,
        room: { name: roomNameForChannel(voiceId) },
        participant: { identity: who.id }
      })
      const signed = new AccessToken('test-key', 'test-secret-that-is-at-least-32-characters-long')
      signed.sha256 = createHash('sha256').update(body).digest('base64')
      await ctx.voice.bridge!.handleWebhook(body, await signed.toJwt())
    }
    const inRoom = (): string[] =>
      ctx.voice.store
        .snapshot()
        .filter((s) => s.channelId === voiceId)
        .map((s) => s.userId)
        .sort()
    await connects(member)
    assert.deepEqual(inRoom(), [member.id])
    // The moderator's token is from when the seat was free: connecting now is refused.
    await connects(mod)
    assert.deepEqual(inRoom(), [member.id])
    // Managers may still join, and reconnecting to your own seat is fine.
    await connects(admin)
    await connects(member)
    assert.deepEqual(inRoom(), [admin.id, member.id].sort())
    await json(await req(`/api/voice/channels/${voiceId}/token`, { method: 'POST', token: member.token }), 200)
    assert.equal((await req(`/api/voice/channels/${voiceId}/token`, { method: 'POST', token: mod.token })).status, 403)
    ctx.voice.store.leave(member.id, voiceId)
    ctx.voice.store.leave(admin.id, voiceId)
    await json(await req(`/api/channels/${voiceId}`, { method: 'PATCH', token: owner.token, json: { userLimit: 0 } }), 200)
  })
})

// ======================================================================
describe('member timeouts', () => {
  const timeout = (actor: Person, target: Person, minutes: number | null) =>
    req(`/api/servers/${serverId}/members/${target.id}/timeout`, { method: 'PUT', token: actor.token, json: { minutes } })

  test('pure rule: only View Channel survives a running timeout', () => {
    const now = 1_000_000
    assert.equal(applyTimeout(MODERATOR_DEFAULT, now + 1, now), Permissions.viewChannel)
    assert.equal(applyTimeout(MODERATOR_DEFAULT, now, now), MODERATOR_DEFAULT, 'ended')
    assert.equal(applyTimeout(MODERATOR_DEFAULT, null, now), MODERATOR_DEFAULT)
    assert.ok(MODERATOR_DEFAULT & Permissions.moderateMembers)
  })

  test('hierarchy: moderators time out members, never upward or themselves', async () => {
    assert.equal((await timeout(member, mod, 5)).status, 403, 'no permission')
    assert.equal((await timeout(mod, admin, 5)).status, 403, 'higher role')
    assert.equal((await timeout(admin, owner, 5)).status, 403, 'never the owner')
    assert.equal((await timeout(mod, mod, 5)).status, 400, 'not yourself')
    assert.equal((await timeout(outsider, member, 5)).status, 404)
    assert.equal((await timeout(mod, member, 0)).status, 400)
    assert.equal((await timeout(mod, member, 28 * 24 * 60 + 1)).status, 400)
    assert.equal((await req(`/api/servers/${serverId}/members/${member.id}/timeout`, { method: 'PUT', token: mod.token, json: { minutes: 5, extra: 1 } })).status, 400)
  })

  test('a timed-out member can read but not send, react, upload, invite or join voice', async () => {
    const msg = await json<ApiMessage>(await req(`/api/channels/${textId}/messages`, { method: 'POST', token: owner.token, json: { content: 'before the timeout' } }), 201)
    const gw = gateway(member.token)
    await gw.waitFor((f) => f.op === 'ready')

    const set = await json<ApiMember>(await timeout(mod, member, 10), 200)
    assert.ok(set.timeoutUntil && set.timeoutUntil > Date.now() + 9 * 60_000)
    await gw.waitFor((f) => f.op === 'server_update' && f.d.serverId === serverId)

    const mine = await view(member)
    assert.ok(mine.timeoutUntil && mine.timeoutUntil > Date.now())
    assert.equal(mine.permissions, Permissions.viewChannel)
    assert.ok(mine.channels.every((c) => c.permissions === Permissions.viewChannel), 'channels still visible, read-only')
    assert.equal((await req(`/api/channels/${textId}/messages`, { token: member.token })).status, 200, 'can read')
    assert.equal((await req(`/api/channels/${textId}/messages`, { method: 'POST', token: member.token, json: { content: 'let me talk' } })).status, 403)
    assert.equal((await req(`/api/channels/${textId}/messages/${msg.id}/reactions/${encodeURIComponent('👍')}`, { method: 'PUT', token: member.token })).status, 403)
    const form = new FormData()
    form.append('file', new Blob(['hi']), 'a.txt')
    assert.equal((await fetch(`${base}/api/channels/${textId}/attachments`, { method: 'POST', headers: { Authorization: `${SCHEME} ${member.token}` }, body: form })).status, 403)
    assert.equal((await req(`/api/servers/${serverId}/invites`, { method: 'POST', token: member.token, json: {} })).status, 403)
    assert.equal((await req(`/api/voice/channels/${voiceId}/token`, { method: 'POST', token: member.token })).status, 403)
    assert.equal(await voiceAuthorizer(ctx)(member.id, voiceId), null, 'removed from voice by enforcement')

    // Moderators see the timeout in the member list; it's audit-logged.
    const members = await json<ApiMember[]>(await req(`/api/servers/${serverId}/members`, { token: mod.token }), 200)
    assert.equal(members.find((m) => m.userId === member.id)?.timeoutUntil, set.timeoutUntil)
    assert.equal(members.find((m) => m.userId === mod.id)?.timeoutUntil, null)
    const audit = await json<{ action: string; targetUserId: string; detail: { minutes?: number } | null }[]>(await req(`/api/servers/${serverId}/audit`, { token: owner.token }), 200)
    assert.ok(audit.some((e) => e.action === 'server.timeout' && e.targetUserId === member.id && e.detail?.minutes === 10))

    // Lifting it restores everything at once.
    await json(await timeout(mod, member, null), 200)
    assert.ok((await view(member)).permissions! & Permissions.sendMessages)
    await json(await req(`/api/channels/${textId}/messages`, { method: 'POST', token: member.token, json: { content: 'back again' } }), 201)
    const audit2 = await json<{ action: string }[]>(await req(`/api/servers/${serverId}/audit`, { token: owner.token }), 200)
    assert.ok(audit2.some((e) => e.action === 'server.timeout_removed'))
    gw.ws.close()
  })

  test('timeouts end on time (enforced by the clock) and the sweeper tells clients', async () => {
    await json(await timeout(admin, mod, 60), 200)
    assert.equal((await view(mod)).permissions, Permissions.viewChannel, 'a timed-out moderator can’t moderate')
    assert.equal((await timeout(mod, member, 5)).status, 403)
    // Pretend the hour has passed.
    const db = new DatabaseSync(dbFile)
    db.prepare('UPDATE server_members SET timeout_until = ? WHERE server_id = ? AND user_id = ?').run(Date.now() - 1, serverId, mod.id)
    db.close()
    assert.ok((await view(mod)).permissions! & Permissions.moderateMembers, 'ended by the clock even before the sweep')
    const gw = gateway(mod.token)
    await gw.waitFor((f) => f.op === 'ready')
    assert.equal(await expireTimeouts(ctx), 1)
    await gw.waitFor((f) => f.op === 'server_update' && f.d.serverId === serverId)
    assert.equal(await expireTimeouts(ctx), 0, 'cleared once')
    const members = await json<ApiMember[]>(await req(`/api/servers/${serverId}/members`, { token: owner.token }), 200)
    assert.equal(members.find((m) => m.userId === mod.id)?.timeoutUntil, null)
    gw.ws.close()
  })

  test('transferring ownership clears a timeout', async () => {
    await json(await timeout(owner, admin, 30), 200)
    assert.equal((await view(admin)).permissions, Permissions.viewChannel)
    // The transfer route needs a password (dev identities have none): same repository step.
    await repo.transferOwnership(serverId, owner.id, admin.id)
    const now = await view(admin)
    assert.equal(now.role, 'owner')
    assert.equal(now.timeoutUntil, null)
    assert.equal((await repo.getMember(serverId, admin.id))?.timeoutUntil, null)
    await repo.transferOwnership(serverId, admin.id, owner.id)
  })

  test('leaving or being kicked and rejoining doesn’t end a timeout; old messages stay as they were', async () => {
    const old = await json<ApiMessage>(
      await req(`/api/channels/${textId}/messages`, { method: 'POST', token: member.token, json: { content: 'written before' } }),
      201
    )
    const until = (await json<ApiMember>(await timeout(mod, member, 30), 200)).timeoutUntil
    assert.ok(until)
    const edit = await req(`/api/channels/${textId}/messages/${old.id}`, {
      method: 'PATCH',
      token: member.token,
      json: { content: 'rewritten during the timeout' }
    })
    assert.equal(edit.status, 403)
    assert.equal(await errorCode(edit), 'timed_out')

    const invite = await json<ApiServerInvite>(
      await req(`/api/servers/${serverId}/invites`, { method: 'POST', token: owner.token, json: { maxUses: 5 } }),
      201
    )
    const rejoin = async () =>
      json(await req('/api/invites/accept', { method: 'POST', token: member.token, json: { code: invite.code } }), 200)
    await json(await req(`/api/servers/${serverId}/leave`, { method: 'POST', token: member.token }), 204)
    await rejoin()
    assert.equal((await view(member)).timeoutUntil, until, 'left and came back: still timed out')
    assert.equal((await view(member)).permissions, Permissions.viewChannel)
    await json(await req(`/api/servers/${serverId}/members/${member.id}`, { method: 'DELETE', token: mod.token }), 204)
    await rejoin()
    assert.equal((await view(member)).timeoutUntil, until, 'kicked and came back: still timed out')

    // Lifted: nothing comes back after the next rejoin, and editing works again.
    await json(await timeout(mod, member, null), 200)
    await json(await req(`/api/servers/${serverId}/leave`, { method: 'POST', token: member.token }), 204)
    await rejoin()
    assert.equal((await view(member)).timeoutUntil, null)
    await json(
      await req(`/api/channels/${textId}/messages/${old.id}`, { method: 'PATCH', token: member.token, json: { content: 'edited later' } }),
      200
    )
  })

  test('a parked timeout that runs out while someone is away is swept', async () => {
    const db = new DatabaseSync(dbFile)
    db.prepare('INSERT INTO server_timeout_holds (server_id, user_id, until) VALUES (?, ?, ?)').run(serverId, outsider.id, Date.now() - 1)
    db.close()
    await expireTimeouts(ctx)
    const check = new DatabaseSync(dbFile)
    assert.equal(Number(check.prepare('SELECT COUNT(*) AS n FROM server_timeout_holds').get()?.n), 0)
    check.close()
  })
})

// ======================================================================
describe('migration v7 (server administration)', () => {
  test('upgrades a v6 database: defaults, kept data, Moderate Members for roles that could kick', async () => {
    const file = join(dir, 'm13-v6.db')
    const db = new DatabaseSync(file)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
    for (const m of sqliteMigrations.filter((x) => x.version <= 6)) {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, 1)
    }
    db.prepare("INSERT INTO users (id, username, display_name, avatar_color, is_bot, created_at) VALUES ('u1', 'owner', 'Owner', '#6d72f6', 0, 1)").run()
    db.prepare("INSERT INTO servers (id, name, color, owner_id, position, created_at) VALUES ('s1', 'Home', '#111111', 'u1', 0, 1)").run()
    db.prepare("INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES ('s1', 'u1', 'owner', 1)").run()
    db.prepare("INSERT INTO channels (id, server_id, name, type, topic, category, position, created_at) VALUES ('v1', 's1', 'Lounge', 'voice', NULL, 'Voice', 0, 1)").run()
    const kick = Permissions.kickMembers | Permissions.viewChannel
    db.prepare("INSERT INTO server_role_permissions (server_id, role, permissions) VALUES ('s1', 'moderator', ?), ('s1', 'member', ?)").run(kick, Permissions.viewChannel)
    db.close()

    const upgraded = new SqliteRepository(file)
    await upgraded.migrate()
    await upgraded.migrate()
    const server = await upgraded.getServer('s1')
    assert.equal(server?.description, null)
    assert.equal(server?.iconId, null)
    assert.equal(server?.defaultNotifications, 'all')
    assert.equal((await upgraded.getChannel('v1'))?.userLimit, 0)
    assert.equal((await upgraded.getMember('s1', 'u1'))?.timeoutUntil, null)
    const roles = (await upgraded.getRolePermissions(['s1'])).get('s1')!
    assert.equal(roles.moderator, kick | Permissions.moderateMembers, 'could kick → can time out')
    assert.equal(roles.member, Permissions.viewChannel, 'unchanged')
    const raw = (upgraded as unknown as { db: DatabaseSync }).db
    assert.throws(() => raw.prepare("UPDATE channels SET user_limit = 100 WHERE id = 'v1'").run(), /CHECK/)
    assert.throws(() => raw.prepare("UPDATE servers SET default_notifications = 'none' WHERE id = 's1'").run(), /CHECK/)
    assert.equal(raw.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')
    assert.equal(raw.prepare('PRAGMA foreign_key_check').all().length, 0)
    assert.ok(Number(raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v) >= 7)
    await upgraded.close()
  })
})
