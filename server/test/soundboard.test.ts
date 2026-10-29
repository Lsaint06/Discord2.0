/**
 * Milestone 14 tests: server soundboard — permissions, WAV validation, the voice-channel rule
 * for playing, delivery only to the people in that voice channel, rate limits, deletion.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
import { parseWav } from '../src/soundboard/wav.js'
import type { ApiAuthResult, ApiServer, ApiSoundboardSound, GatewayServerFrame } from '../src/protocol.js'

const SCHEME = ['Bea', 'rer'].join('')
const HASHER = new PasswordHasher(OWASP_MINIMUM, new HashGate(4, 64))
const PASSWORD = 'violet-anchor-sunrise-42'
const dir = mkdtempSync(join(tmpdir(), 'd2-soundboard-'))

let app: FastifyInstance
let ctx: AppContext
let repo: SqliteRepository
let base = ''
let admin: ApiAuthResult
let alice: ApiAuthResult
let bob: ApiAuthResult
let loner: ApiAuthResult
let hangout: ApiServer
let voiceId = ''

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

/** A WAV file: `ms` of a 440 Hz tone. */
function wav(ms: number, { rate = 48000, channels = 1, bits = 16 } = {}): Buffer {
  const frames = Math.round((rate * ms) / 1000)
  const bytesPer = bits / 8
  const data = Buffer.alloc(frames * channels * bytesPer)
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000)
    for (let c = 0; c < channels; c++) {
      if (bits === 16) data.writeInt16LE(v, (i * channels + c) * 2)
      else data.writeUInt8(128 + (v >> 8), i * channels + c)
    }
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8, 'ascii')
  head.write('fmt ', 12, 'ascii')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(channels, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * channels * bytesPer, 28)
  head.writeUInt16LE(channels * bytesPer, 32)
  head.writeUInt16LE(bits, 34)
  head.write('data', 36, 'ascii')
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

function upload(token: string, serverId: string, file: Buffer, fields: Record<string, string> = { name: 'Air horn' }) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  form.append('file', new Blob([file]), 'clip.wav')
  return req(`/api/servers/${serverId}/soundboard`, { method: 'POST', token, body: form })
}

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
  repo = new SqliteRepository(join(dir, 'sb.db'))
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
  hangout = servers.find((s) => s.id === 'hangout')!
  voiceId = hangout.channels.find((c) => c.type === 'voice')!.id
})

after(async () => {
  await app.close()
  await repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WAV validation', () => {
  test('accepts 16-bit PCM mono/stereo up to the limit; reports duration', () => {
    assert.equal(parseWav(wav(1000), 5000).durationMs, 1000)
    assert.equal(parseWav(wav(500, { channels: 2, rate: 44100 }), 5000).channels, 2)
  })
  test('refuses other formats, damaged files, long and empty clips', () => {
    assert.throws(() => parseWav(Buffer.from('not a wav file at all, definitely not one'), 5000), /WAV/)
    assert.throws(() => parseWav(wav(100, { bits: 8 }), 5000), /16-bit/)
    assert.throws(() => parseWav(wav(6000), 5000), /at most 5 seconds/)
    assert.throws(() => parseWav(wav(0), 5000), /empty/)
    const truncated = wav(500).subarray(0, 30)
    assert.throws(() => parseWav(truncated, 5000))
  })
})

describe('soundboard', () => {
  let sound: ApiSoundboardSound

  test('members can list, non-members can’t see it', async () => {
    assert.deepEqual(await json(await req('/api/servers/hangout/soundboard', { token: alice.token }), 200), [])
    assert.equal((await req('/api/servers/hangout/soundboard', { token: loner.token })).status, 404)
  })

  test('only people who can manage the server add sounds; uploads are validated', async () => {
    const denied = await upload(alice.token, 'hangout', wav(800))
    assert.equal(denied.status, 403)
    const notWav = await upload(admin.token, 'hangout', Buffer.from('\x89PNG\r\n\x1a\nnot-a-wav-file-at-all-really-not'))
    assert.equal(notWav.status, 415)
    const tooLong = await upload(admin.token, 'hangout', wav(6000, { rate: 16000 }))
    assert.equal(tooLong.status, 400)
    assert.equal(await code(tooLong), 'sound_too_long')
    const tooBig = await upload(admin.token, 'hangout', wav(4900, { channels: 2 }))
    assert.equal(tooBig.status, 413)
    const noName = await upload(admin.token, 'hangout', wav(500), { name: '   ' })
    assert.equal(noName.status, 400)
    sound = await json<ApiSoundboardSound>(
      await upload(admin.token, 'hangout', wav(900), { name: '  Air   horn ', emoji: '📯' }),
      201
    )
    assert.equal(sound.name, 'Air horn')
    assert.equal(sound.emoji, '📯')
    assert.equal(sound.durationMs, 900)
    const list = await json<ApiSoundboardSound[]>(await req('/api/servers/hangout/soundboard', { token: bob.token }), 200)
    assert.deepEqual(list.map((s) => s.id), [sound.id])
  })

  test('the audio is served to members only, as plain audio/wav', async () => {
    const res = await req(`/api/soundboard/${sound.id}/audio`, { token: bob.token })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'audio/wav')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/)
    const bytes = Buffer.from(await res.arrayBuffer())
    assert.equal(parseWav(bytes, 5000).durationMs, 900)
    assert.equal((await req(`/api/soundboard/${sound.id}/audio`, { token: loner.token })).status, 404)
    assert.equal((await req('/api/soundboard/../../etc/passwd/audio', { token: bob.token })).status, 404)
  })

  test('playing needs you in a voice channel of that server; only that channel hears it', async () => {
    const notInVoice = await req(`/api/soundboard/${sound.id}/play`, { method: 'POST', token: alice.token })
    assert.equal(notInVoice.status, 403)
    assert.equal(await code(notInVoice), 'not_in_voice')

    const bobGw = gateway(bob.token)
    const lonerGw = gateway(loner.token)
    const adminGw = gateway(admin.token)
    await Promise.all([bobGw.ready, lonerGw.ready, adminGw.ready])
    ctx.voice.store.join(alice.user.id, voiceId)
    ctx.voice.store.join(bob.user.id, voiceId)
    // Root is in the server but not in voice: doesn't hear it.
    const played = await req(`/api/soundboard/${sound.id}/play`, { method: 'POST', token: alice.token })
    assert.equal(played.status, 204)
    await sleep(150)
    const heard = (frames: GatewayServerFrame[]) =>
      frames.filter((f) => f.op === 'soundboard_play') as Extract<GatewayServerFrame, { op: 'soundboard_play' }>[]
    assert.deepEqual(heard(bobGw.frames).map((f) => f.d), [
      { serverId: 'hangout', channelId: voiceId, soundId: sound.id, userId: alice.user.id }
    ])
    assert.equal(heard(lonerGw.frames).length, 0)
    assert.equal(heard(adminGw.frames).length, 0)
    bobGw.close()
    lonerGw.close()
    adminGw.close()
  })

  test('plays are rate limited per person (a burst of 3, then a pause)', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      statuses.push((await req(`/api/soundboard/${sound.id}/play`, { method: 'POST', token: bob.token })).status)
    }
    assert.deepEqual(statuses, [204, 204, 204, 429])
  })

  test('a voice channel in another server doesn’t count', async () => {
    const other = (await repo.listChannels()).find((c) => c.serverId === 'gamenight' && c.type === 'voice')
    assert.ok(other)
    ctx.voice.store.join(alice.user.id, other.id)
    const res = await req(`/api/soundboard/${sound.id}/play`, { method: 'POST', token: alice.token })
    assert.equal(res.status, 403)
    ctx.voice.store.leave(alice.user.id, other.id)
  })

  test('removing: not by ordinary members; managers can, and the file goes too', async () => {
    assert.equal((await req(`/api/soundboard/${sound.id}`, { method: 'DELETE', token: bob.token })).status, 403)
    assert.equal((await req(`/api/soundboard/${sound.id}`, { method: 'DELETE', token: admin.token })).status, 204)
    assert.equal(existsSync(join(dir, 'attachments', 'soundboard', `${sound.id}.wav`)), false)
    assert.equal((await req(`/api/soundboard/${sound.id}/audio`, { method: 'GET', token: bob.token })).status, 404)
    assert.equal((await req(`/api/soundboard/${sound.id}/play`, { method: 'POST', token: bob.token })).status, 404)
  })

  test('a server holds a bounded number of sounds (checked atomically)', async () => {
    const rec = (id: string) => ({
      id,
      serverId: 'studyhall',
      name: id,
      emoji: null,
      uploaderId: null,
      durationMs: 100,
      size: 100,
      sha256: 'x',
      createdAt: Date.now()
    })
    assert.equal(await repo.addSoundboardSound(rec('a'.repeat(32)), 2), true)
    assert.equal(await repo.addSoundboardSound(rec('b'.repeat(32)), 2), true)
    assert.equal(await repo.addSoundboardSound(rec('c'.repeat(32)), 2), false)
    assert.equal((await repo.listSoundboardSounds('studyhall')).length, 2)
  })
})
