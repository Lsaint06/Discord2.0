/**
 * Milestone 14: server soundboard. Server members list and fetch clips; people who can manage
 * the server add and remove them (the person who added a clip may remove it too). Playing a
 * clip is server-authoritative: you must be connected to a voice channel of that server and be
 * allowed to speak there, plays are rate limited per person, and the event goes only to the
 * people in that voice channel, whose apps play the clip locally at their own soundboard volume.
 */
import type { MultipartFile } from '@fastify/multipart'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { createReadStream, mkdirSync } from 'node:fs'
import { readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppContext } from '../context.js'
import type { SoundboardSoundRecord } from '../db/repository.js'
import { FileTooLargeError } from '../attachments/store.js'
import { requireUser } from '../lib/auth.js'
import {
  badRequest,
  conflict,
  forbidden,
  insufficientStorage,
  notFound,
  payloadTooLarge,
  tooManyRequests,
  unsupportedType
} from '../lib/errors.js'
import { TokenBucketLimiter } from '../lib/rateLimit.js'
import { normalizeEmoji } from '../lib/validation.js'
import { Permissions, SOUNDBOARD_LIMITS, type ApiSoundboardSound } from '../protocol.js'
import { parseWav, WavError } from '../soundboard/wav.js'

const ID = /^[a-f0-9]{32}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g

const toApi = (s: SoundboardSoundRecord): ApiSoundboardSound => ({
  id: s.id,
  serverId: s.serverId,
  name: s.name,
  emoji: s.emoji,
  uploaderId: s.uploaderId,
  durationMs: s.durationMs,
  createdAt: s.createdAt
})

export function normalizeSoundName(input: unknown): string {
  if (typeof input !== 'string') throw badRequest('Give the sound a name', 'invalid_name')
  const name = input.replace(CONTROL, '').replace(/\s+/g, ' ').trim()
  if (name.length < 1 || name.length > SOUNDBOARD_LIMITS.nameMaxLength) {
    throw badRequest(
      `Sound names are 1–${SOUNDBOARD_LIMITS.nameMaxLength} characters`,
      'invalid_name'
    )
  }
  return name
}

/**
 * Removes clip files that no longer have a database row (e.g. their server was deleted, which
 * cascades to the rows), once older than the grace period. A clip being uploaded right now is
 * moved into place just before its row is written, so it is always younger than the grace.
 */
export async function cleanupSoundboard(
  ctx: AppContext,
  log: FastifyBaseLogger,
  now = Date.now(),
  graceMs = 60 * 60_000
): Promise<number> {
  const dir = join(ctx.config.attachments.dir, 'soundboard')
  const referenced = await ctx.repo.listSoundboardSoundIds()
  let removed = 0
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const match = /^([a-f0-9]{32})\.wav$/.exec(name)
    if (!match?.[1] || referenced.has(match[1])) continue
    const path = join(dir, name)
    const info = await stat(path).catch(() => undefined)
    if (info && now - info.mtimeMs > graceMs) {
      await rm(path, { force: true })
      removed++
    }
  }
  if (removed) log.info({ removed }, 'soundboard cleanup')
  return removed
}

export function registerSoundboardRoutes(app: FastifyInstance, ctx: AppContext): void {
  const dir = join(ctx.config.attachments.dir, 'soundboard')
  mkdirSync(dir, { recursive: true })
  const fileOf = (id: string): string => {
    if (!ID.test(id)) throw new Error('invalid soundboard id')
    return join(dir, `${id}.wav`)
  }
  const plays = new TokenBucketLimiter(SOUNDBOARD_LIMITS.playBurst, SOUNDBOARD_LIMITS.playRefillPerSecond)
  const uploads = new TokenBucketLimiter(10, 10 / 60)
  app.addHook('onClose', async () => {
    plays.dispose()
    uploads.dispose()
  })

  app.get<{ Params: { serverId: string } }>(
    '/api/servers/:serverId/soundboard',
    { schema: { params: { type: 'object', properties: { serverId: { type: 'string', maxLength: 64 } } } } },
    async (request): Promise<ApiSoundboardSound[]> => {
      const user = await requireUser(ctx, request)
      await ctx.access.requireServer(user, request.params.serverId)
      return (await ctx.repo.listSoundboardSounds(request.params.serverId)).map(toApi)
    }
  )

  app.post<{ Params: { serverId: string } }>(
    '/api/servers/:serverId/soundboard',
    { schema: { params: { type: 'object', properties: { serverId: { type: 'string', maxLength: 64 } } } } },
    async (request, reply): Promise<ApiSoundboardSound> => {
      const user = await requireUser(ctx, request)
      const serverId = request.params.serverId
      await ctx.access.requireServer(
        user,
        serverId,
        Permissions.manageServer,
        'Only people who can manage this server can add sounds.'
      )
      const limit = uploads.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      if (!request.isMultipart()) throw badRequest('Expected multipart/form-data', 'not_multipart')
      if (ctx.attachments.freeBytes() < ctx.config.attachments.minFreeDiskBytes) {
        throw insufficientStorage('The server is low on disk space. Uploads are paused.')
      }

      const fields: Record<string, string> = {}
      let tmpPath: string | null = null
      let failure: unknown = null
      for await (const part of request.parts()) {
        if (part.type !== 'file') {
          if (/^(name|emoji)$/.test(part.fieldname) && typeof part.value === 'string' && part.value.length <= 200) {
            fields[part.fieldname] = part.value
          }
          continue
        }
        const file = part as MultipartFile
        if (tmpPath || failure) {
          file.file.resume()
          continue
        }
        try {
          const got = await ctx.attachments.receive(file.file, SOUNDBOARD_LIMITS.maxBytes)
          if (file.file.truncated) {
            await ctx.attachments.discard(got.tmpPath)
            failure = payloadTooLarge(`Sounds can be at most ${SOUNDBOARD_LIMITS.maxBytes / 1024} KB.`, 'file_too_large')
          } else {
            tmpPath = got.tmpPath
          }
        } catch (err) {
          failure =
            err instanceof FileTooLargeError
              ? payloadTooLarge(`Sounds can be at most ${SOUNDBOARD_LIMITS.maxBytes / 1024} KB.`, 'file_too_large')
              : err
          if (!file.file.destroyed) file.file.resume()
        }
      }
      if (failure) {
        if (tmpPath) await ctx.attachments.discard(tmpPath)
        throw failure
      }
      if (!tmpPath) throw badRequest('No sound was uploaded', 'no_file')

      try {
        const name = normalizeSoundName(fields.name)
        const emoji = fields.emoji ? normalizeEmoji(fields.emoji) : null
        const bytes = await readFile(tmpPath)
        let info
        try {
          info = parseWav(bytes, SOUNDBOARD_LIMITS.maxDurationMs)
        } catch (err) {
          if (err instanceof WavError) {
            throw err.code === 'not_wav' || err.code === 'unsupported_wav'
              ? unsupportedType(err.message)
              : badRequest(err.message, err.code === 'too_long' ? 'sound_too_long' : 'sound_empty')
          }
          throw err
        }
        const { createHash } = await import('node:crypto')
        const record: SoundboardSoundRecord = {
          id: randomBytes(16).toString('hex'),
          serverId,
          name,
          emoji,
          uploaderId: user.id,
          durationMs: info.durationMs,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          createdAt: Date.now()
        }
        await rename(tmpPath, fileOf(record.id))
        tmpPath = null
        if (!(await ctx.repo.addSoundboardSound(record, SOUNDBOARD_LIMITS.maxSoundsPerServer))) {
          await unlink(fileOf(record.id)).catch(() => undefined)
          throw conflict(
            `A server can have at most ${SOUNDBOARD_LIMITS.maxSoundsPerServer} sounds.`,
            'soundboard_full'
          )
        }
        await ctx.audit.record({
          action: 'soundboard.sound_added',
          actorId: user.id,
          serverId,
          request,
          detail: { soundId: record.id, name: record.name }
        })
        ctx.hub.sendToUsers(await ctx.access.serverMembers(serverId), {
          op: 'server_update',
          d: { serverId }
        })
        reply.code(201)
        return toApi(record)
      } finally {
        if (tmpPath) await ctx.attachments.discard(tmpPath)
      }
    }
  )

  app.delete<{ Params: { soundId: string } }>(
    '/api/soundboard/:soundId',
    { schema: { params: { type: 'object', properties: { soundId: { type: 'string', maxLength: 64 } } } } },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      const sound = ID.test(request.params.soundId)
        ? await ctx.repo.getSoundboardSound(request.params.soundId)
        : undefined
      if (!sound) throw notFound('Sound not found')
      const access = await ctx.access.requireServer(user, sound.serverId)
      const canManage = (access.permissions & Permissions.manageServer) !== 0
      if (!canManage && sound.uploaderId !== user.id) {
        throw forbidden('Only people who can manage this server can remove sounds.', 'missing_permission')
      }
      await ctx.repo.deleteSoundboardSound(sound.id)
      await unlink(fileOf(sound.id)).catch(() => undefined)
      await ctx.audit.record({
        action: 'soundboard.sound_removed',
        actorId: user.id,
        serverId: sound.serverId,
        request,
        detail: { soundId: sound.id, name: sound.name }
      })
      ctx.hub.sendToUsers(await ctx.access.serverMembers(sound.serverId), {
        op: 'server_update',
        d: { serverId: sound.serverId }
      })
      reply.code(204)
    }
  )

  app.get<{ Params: { soundId: string } }>(
    '/api/soundboard/:soundId/audio',
    { schema: { params: { type: 'object', properties: { soundId: { type: 'string', maxLength: 64 } } } } },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      const sound = ID.test(request.params.soundId)
        ? await ctx.repo.getSoundboardSound(request.params.soundId)
        : undefined
      if (!sound) throw notFound('Sound not found')
      await ctx.access.requireServer(user, sound.serverId)
      const path = fileOf(sound.id)
      const info = await stat(path).catch(() => null)
      if (!info) throw notFound('Sound file is missing')
      reply
        .header('Content-Type', 'audio/wav')
        .header('Content-Length', info.size)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('ETag', `"${sound.sha256.slice(0, 32)}"`)
      return reply.send(createReadStream(path))
    }
  )

  app.post<{ Params: { soundId: string } }>(
    '/api/soundboard/:soundId/play',
    { schema: { params: { type: 'object', properties: { soundId: { type: 'string', maxLength: 64 } } } } },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      const sound = ID.test(request.params.soundId)
        ? await ctx.repo.getSoundboardSound(request.params.soundId)
        : undefined
      if (!sound) throw notFound('Sound not found')
      await ctx.access.requireServer(user, sound.serverId)
      // You must be in a voice channel of this server, and allowed to speak there.
      const channelId = ctx.voice.store.channelOf(user.id)
      const channel = channelId ? await ctx.repo.getChannel(channelId) : undefined
      if (!channelId || !channel || channel.serverId !== sound.serverId) {
        throw forbidden('Join a voice channel in this server to play sounds.', 'not_in_voice')
      }
      await ctx.access.requireChannel(user, channelId, Permissions.speak, 'You can’t speak in this voice channel.')
      const limit = plays.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const listeners = new Set(
        ctx.voice.store
          .snapshot()
          .filter((s) => s.channelId === channelId)
          .map((s) => s.userId)
      )
      ctx.hub.sendToUsers(listeners, {
        op: 'soundboard_play',
        d: { serverId: sound.serverId, channelId, soundId: sound.id, userId: user.id }
      })
      reply.code(204)
    }
  )
}
