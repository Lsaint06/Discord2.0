/**
 * Large files (Milestone 13): authenticated, chunked and resumable uploads up to 5 GB, and the
 * lifecycle of files over the ephemeral threshold (deleted 24 h after the upload completes; the
 * message stays and shows "File expired"). Off unless UPLOAD_LARGE_FILES=true.
 *
 *   POST   /api/channels/:channelId/uploads   {filename, size} -> session (quota checked, reserved)
 *   GET    /api/uploads/:id                   -> session (resume: continue at receivedBytes)
 *   PUT    /api/uploads/:id?offset=N          raw bytes (application/octet-stream), <= chunkBytes
 *   POST   /api/uploads/:id/complete          -> pending attachment (send it with a message)
 *   DELETE /api/uploads/:id                   cancel
 */
import { mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { sanitizeFilename, typeForFilename, ALLOWED_EXTENSIONS } from '../attachments/fileTypes.js'
import { ChunkTooLargeError, PartMissingError, UploadPartStore, hashFileHead, isUploadSessionId } from '../attachments/uploads.js'
import type { LargeFileConfig } from '../config.js'
import type { AppContext } from '../context.js'
import type { AttachmentRecord, UploadSessionRecord } from '../db/repository.js'
import { requireUser } from '../lib/auth.js'
import {
  ApiError,
  badRequest,
  conflict,
  insufficientStorage,
  notFound,
  payloadTooLarge,
  tooManyRequests,
  unsupportedType
} from '../lib/errors.js'
import { LIMITS, Permissions, type ApiAttachment, type ApiUploadSession } from '../protocol.js'
import { readableChannel } from './messages.js'
import { toApiAttachment } from './messageViews.js'
import { createHash, randomBytes } from 'node:crypto'

/** Chunk size: well under Caddy's 64 MB request limit, small enough to retry cheaply. */
export const LARGE_CHUNK_BYTES = 16 * 1024 * 1024

const MB = 1024 * 1024
const size = (bytes: number): string =>
  bytes >= 1024 * MB ? `${Math.round((bytes / (1024 * MB)) * 10) / 10} GB` : `${Math.round(bytes / MB)} MB`

const parts = new WeakMap<AppContext, UploadPartStore>()
export function uploadParts(ctx: AppContext): UploadPartStore {
  let store = parts.get(ctx)
  if (!store) {
    store = new UploadPartStore(ctx.config.attachments.dir)
    parts.set(ctx, store)
  }
  return store
}

/** Uploads being finished right now (hashing a big file takes a while): left alone meanwhile. */
const finishingByCtx = new WeakMap<AppContext, Set<string>>()
function finishingUploads(ctx: AppContext): Set<string> {
  let set = finishingByCtx.get(ctx)
  if (!set) {
    set = new Set()
    finishingByCtx.set(ctx, set)
  }
  return set
}

/**
 * The attachment an upload becomes, derived from the upload's id: asking to finish it again
 * (after a lost answer, a client timeout or a crash) finds the same attachment.
 */
export function attachmentIdForSession(sessionId: string): string {
  return createHash('sha256').update(`discord2-upload:${sessionId}`).digest('hex').slice(0, 32)
}

const fileExists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined

function toApiSession(s: UploadSessionRecord, large: LargeFileConfig): ApiUploadSession {
  return {
    id: s.id,
    channelId: s.channelId,
    filename: s.filename,
    size: s.size,
    receivedBytes: s.received,
    chunkBytes: LARGE_CHUNK_BYTES,
    expiresAfterMs: s.ephemeral ? large.ephemeralMs : null
  }
}

export function registerLargeUploadRoutes(app: FastifyInstance, ctx: AppContext): void {
  const large = ctx.config.attachments.large
  const cfg = ctx.config.attachments
  if (!large) {
    const off = (): ApiError => new ApiError(404, 'large_uploads_disabled', 'Large file uploads aren’t enabled on this server.')
    app.post('/api/channels/:channelId/uploads', async (request) => {
      await requireUser(ctx, request)
      throw off()
    })
    return
  }
  const store = uploadParts(ctx)
  const finishing = finishingUploads(ctx)
  const idParam = { type: 'string', maxLength: 64 } as const

  const ownSession = async (userId: string, id: string): Promise<UploadSessionRecord> => {
    if (!isUploadSessionId(id)) throw notFound('Upload not found')
    const session = await ctx.repo.getUploadSession(id)
    // Someone else's upload is "not found" (no probing).
    if (!session || session.userId !== userId) throw notFound('Upload not found')
    return session
  }

  // ---- Start ----
  app.post<{ Params: { channelId: string }; Body: { filename: string; size: number } }>(
    '/api/channels/:channelId/uploads',
    {
      schema: {
        params: { type: 'object', properties: { channelId: idParam } },
        body: {
          type: 'object',
          required: ['filename', 'size'],
          additionalProperties: false,
          properties: {
            filename: { type: 'string', minLength: 1, maxLength: 255 },
            size: { type: 'integer', minimum: 1 }
          }
        }
      }
    },
    async (request, reply): Promise<ApiUploadSession> => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.uploadsPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const { channel } = await readableChannel(
        ctx,
        user,
        request.params.channelId,
        Permissions.sendMessages | Permissions.attachFiles,
        'You can’t upload files in this channel.'
      )
      const filename = sanitizeFilename(request.body.filename, LIMITS.filenameMaxLength)
      const type = typeForFilename(filename)
      if (!type) throw unsupportedType(`This file type isn’t allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}.`)
      const bytes = request.body.size
      if (bytes > large.maxFileBytes) {
        throw payloadTooLarge(`Files can be at most ${size(large.maxFileBytes)}.`, 'file_too_large')
      }
      const ephemeral = bytes > large.ephemeralThresholdBytes
      const usage = await ctx.repo.largeFileUsage(user.id)
      if (usage.sessions >= large.concurrentPerUser) {
        throw new ApiError(429, 'too_many_uploads', `You can upload at most ${large.concurrentPerUser} large files at a time.`)
      }
      if (ephemeral) {
        if (usage.user + bytes > large.userQuotaBytes) {
          throw insufficientStorage(`Your large files would use more than ${size(large.userQuotaBytes)}. Wait for some to expire.`)
        }
        if (usage.pool + bytes > large.poolBytes) {
          throw insufficientStorage('The server’s space for large files is full. Try again later.')
        }
      } else {
        const normal = await ctx.repo.attachmentUsage(user.id)
        if (normal.pendingCount >= cfg.maxPendingPerUser) {
          throw badRequest('Too many unsent uploads. Send or remove some first.', 'too_many_pending')
        }
        if (normal.user + bytes > cfg.userQuotaBytes) {
          throw insufficientStorage(`This would exceed your ${size(cfg.userQuotaBytes)} upload quota.`)
        }
        if (normal.total + bytes > cfg.totalQuotaBytes) throw insufficientStorage('The server’s attachment storage is full.')
      }
      // Room for this file and every upload still in progress, above the safety floor.
      const floor = ephemeral ? large.minFreeBytes : cfg.minFreeDiskBytes
      const pending = await ctx.repo.pendingUploadBytes()
      if (ctx.attachments.freeBytes() - pending - bytes < floor) {
        request.log.warn({ free: ctx.attachments.freeBytes(), pending, bytes }, 'large upload refused: disk space')
        throw insufficientStorage('The server doesn’t have enough free space for this file right now.')
      }
      const now = Date.now()
      const session: UploadSessionRecord = {
        id: randomBytes(16).toString('hex'),
        userId: user.id,
        channelId: channel.id,
        filename,
        contentType: type.contentType,
        kind: type.kind,
        size: bytes,
        received: 0,
        ephemeral,
        createdAt: now,
        updatedAt: now
      }
      await ctx.repo.createUploadSession(session)
      request.log.info({ op: 'upload_start', bytes, ephemeral }, 'large upload started')
      reply.code(201)
      return toApiSession(session, large)
    }
  )

  // ---- Status (resume) ----
  app.get<{ Params: { id: string } }>(
    '/api/uploads/:id',
    { schema: { params: { type: 'object', properties: { id: idParam } } } },
    async (request): Promise<ApiUploadSession> => {
      const user = await requireUser(ctx, request)
      return toApiSession(await ownSession(user.id, request.params.id), large)
    }
  )

  // ---- One chunk (raw body, streamed straight to disk) ----
  app.register(async (scoped) => {
    // Only this route accepts raw bytes; the stream is handed over unread.
    scoped.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload))
    scoped.put<{ Params: { id: string }; Querystring: { offset: string } }>(
      '/api/uploads/:id',
      {
        schema: {
          params: { type: 'object', properties: { id: idParam } },
          querystring: {
            type: 'object',
            required: ['offset'],
            additionalProperties: false,
            properties: { offset: { type: 'string', pattern: '^[0-9]{1,13}$' } }
          }
        }
      },
      async (request) => {
        const user = await requireUser(ctx, request)
        const limit = ctx.limiters.uploadChunksPerUser.take(user.id)
        if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
        const session = await ownSession(user.id, request.params.id)
        const offset = Number(request.query.offset)
        if (offset !== session.received) {
          throw new ApiError(409, 'wrong_offset', `The upload continues at byte ${session.received}.`)
        }
        const length = Number(request.headers['content-length'])
        if (!Number.isInteger(length) || length <= 0) throw badRequest('Send the chunk with a Content-Length', 'length_required')
        if (length > LARGE_CHUNK_BYTES) throw payloadTooLarge(`Chunks can be at most ${LARGE_CHUNK_BYTES} bytes.`, 'chunk_too_large')
        if (offset + length > session.size) throw badRequest('The chunk goes past the end of the file', 'past_end')
        if (ctx.attachments.freeBytes() < Math.min(large.minFreeBytes, cfg.minFreeDiskBytes)) {
          throw insufficientStorage('The server is low on disk space. Uploads are paused.')
        }
        const body = request.body as NodeJS.ReadableStream | undefined
        if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function') {
          throw new ApiError(415, 'unsupported_media_type', 'Send the chunk as application/octet-stream')
        }
        let written: number
        try {
          written = await store.writeChunk(session.id, offset, body as never, Math.min(length, session.size - offset))
        } catch (err) {
          if (err instanceof ChunkTooLargeError) throw payloadTooLarge('The chunk is larger than announced.', 'chunk_too_large')
          if (err instanceof PartMissingError) {
            // The partial file is gone (disk cleaned up): start over from 0.
            await ctx.repo.advanceUploadSession(session.id, session.received, 0, Date.now())
            throw new ApiError(409, 'wrong_offset', 'The upload has to start again from the beginning.')
          }
          // The app cancelled or lost the connection mid-chunk: normal, nothing was recorded.
          if ((err as Error).message === 'aborted' || (err as NodeJS.ErrnoException).code === 'ECONNRESET') {
            throw new ApiError(400, 'chunk_aborted', 'The chunk was cut off; send it again.')
          }
          throw err
        }
        if (written !== length) throw badRequest('The chunk was shorter than announced', 'short_chunk')
        if (!(await ctx.repo.advanceUploadSession(session.id, offset, offset + written, Date.now()))) {
          throw new ApiError(409, 'wrong_offset', 'Another chunk was stored meanwhile; ask for the upload status.')
        }
        return { receivedBytes: offset + written }
      }
    )
  })

  // ---- Complete ----
  // Idempotent: the attachment id comes from the upload id, so finishing again after a lost
  // answer returns the same attachment, and an attempt that stopped between moving the file
  // and recording it (crash, database error) is completed by the next one.
  app.post<{ Params: { id: string } }>(
    '/api/uploads/:id/complete',
    { schema: { params: { type: 'object', properties: { id: idParam } } } },
    async (request, reply): Promise<ApiAttachment> => {
      const user = await requireUser(ctx, request)
      const sessionId = request.params.id
      if (!isUploadSessionId(sessionId)) throw notFound('Upload not found')
      const attachmentId = attachmentIdForSession(sessionId)
      const alreadyFinished = async (): Promise<ApiAttachment | null> => {
        const done = await ctx.repo.getAttachment(attachmentId)
        return done && done.uploaderId === user.id ? toApiAttachment(done) : null
      }
      const session = await ctx.repo.getUploadSession(sessionId)
      if (!session || session.userId !== user.id) {
        const done = await alreadyFinished()
        if (done) return done
        throw notFound('Upload not found')
      }
      if (finishing.has(sessionId)) {
        throw conflict('This upload is still being finished. Try again in a moment.', 'upload_finishing')
      }
      if (session.received !== session.size) {
        throw new ApiError(409, 'upload_incomplete', `Only ${session.received} of ${session.size} bytes have arrived.`)
      }
      // The channel may have become off-limits while uploading.
      await readableChannel(ctx, user, session.channelId, Permissions.sendMessages | Permissions.attachFiles)
      finishing.add(sessionId)
      try {
        const target = ctx.attachments.pathFor(attachmentId)
        let file: { sha256: string; head: Buffer }
        let moved = false
        if (await store.hasPart(session.id)) {
          file = await store.finalize(session.id, session.size)
        } else if (await fileExists(target)) {
          // An earlier attempt moved the file into place but stopped before recording it.
          file = await hashFileHead(target)
          moved = true
        } else {
          await ctx.repo.deleteUploadSession(session.id)
          throw conflict('The uploaded file is gone from the server. Upload it again.', 'upload_lost')
        }
        const type = typeForFilename(session.filename)
        if (!type || !type.matches(file.head)) {
          await ctx.repo.deleteUploadSession(session.id)
          await store.remove(session.id)
          if (moved) await ctx.attachments.remove(attachmentId)
          throw unsupportedType('The file’s contents don’t match its extension.')
        }
        if (!moved) {
          mkdirSync(dirname(target), { recursive: true })
          await store.moveTo(session.id, target)
        }
        const now = Date.now()
        const record: AttachmentRecord = {
          id: attachmentId,
          messageId: null,
          channelId: session.channelId,
          uploaderId: user.id,
          filename: session.filename,
          contentType: session.contentType,
          // Large files are always downloaded, never decoded inline (even images).
          kind: 'file',
          size: session.size,
          width: null,
          height: null,
          sha256: file.sha256,
          position: 0,
          createdAt: now,
          // The 24 h start when the upload completes.
          expiresAt: session.ephemeral ? now + large.ephemeralMs : null
        }
        if (!(await ctx.repo.completeUploadSession(session.id, record))) {
          const done = await alreadyFinished()
          if (done) return done
          await ctx.attachments.remove(attachmentId)
          throw conflict('The upload changed while finishing. Try again.', 'upload_incomplete')
        }
        request.log.info({ op: 'upload_complete', bytes: session.size, ephemeral: session.ephemeral }, 'large upload complete')
        reply.code(201)
        return toApiAttachment(record)
      } finally {
        finishing.delete(sessionId)
      }
    }
  )

  // ---- Cancel ----
  app.delete<{ Params: { id: string } }>(
    '/api/uploads/:id',
    { schema: { params: { type: 'object', properties: { id: idParam } } } },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      const session = await ownSession(user.id, request.params.id)
      if (finishing.has(session.id)) {
        throw conflict('This upload is being finished and can’t be cancelled now.', 'upload_finishing')
      }
      await ctx.repo.deleteUploadSession(session.id)
      await store.remove(session.id)
      reply.code(204)
    }
  )
}

/**
 * Large-file housekeeping (safe to run any time, including right after a restart):
 * abandoned upload sessions and stray part files are deleted, and large files whose time is up
 * lose their bytes (the message and attachment row stay, marked expired). Deleting a missing
 * file is not an error, so an interrupted run simply finishes next time.
 */
export async function cleanupLargeFiles(
  ctx: AppContext,
  log: FastifyBaseLogger,
  now = Date.now()
): Promise<{ abandoned: number; parts: number; expired: number }> {
  const large = ctx.config.attachments.large
  const store = uploadParts(ctx)
  const finishing = finishingUploads(ctx)
  let abandoned = 0
  if (large) {
    for (const s of await ctx.repo.listAbandonedUploadSessions(now - large.abandonAfterMs)) {
      if (finishing.has(s.id)) continue
      await ctx.repo.deleteUploadSession(s.id)
      await store.remove(s.id)
      abandoned++
    }
  }
  const partsRemoved = await store.sweep(await ctx.repo.listUploadSessionIds(), 60 * 60_000, now)
  let expired = 0
  // Expiry runs even if large uploads were switched off later: promised deletions still happen.
  for (;;) {
    const due = await ctx.repo.listDueExpirations(now, 200)
    if (due.length === 0) break
    for (const a of due) {
      // Bytes first, then the mark: a crash in between just repeats the (idempotent) delete.
      await ctx.attachments.remove(a.id)
      await ctx.repo.markAttachmentExpired(a.id, now)
      expired++
    }
    if (due.length < 200) break
  }
  if (abandoned || partsRemoved || expired) log.info({ abandoned, parts: partsRemoved, expired }, 'large file cleanup')
  return { abandoned, parts: partsRemoved, expired }
}
