import type { MultipartFile } from '@fastify/multipart'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import type { AttachmentRecord } from '../db/repository.js'
import { imageSize, sanitizeFilename, typeForFilename, ALLOWED_EXTENSIONS } from '../attachments/fileTypes.js'
import { FileTooLargeError, isAttachmentId, newAttachmentId } from '../attachments/store.js'
import { requireUser } from '../lib/auth.js'
import {
  badRequest,
  insufficientStorage,
  notFound,
  payloadTooLarge,
  tooManyRequests,
  unsupportedType
} from '../lib/errors.js'
import { LIMITS, Permissions, type ApiAttachment } from '../protocol.js'
import { readableChannel } from './messages.js'
import { toApiAttachment } from './messageViews.js'

const MB = 1024 * 1024
const mb = (bytes: number): string => `${Math.round((bytes / MB) * 10) / 10} MB`

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

export function registerAttachmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const cfg = ctx.config.attachments
  const store = ctx.attachments

  // ---- Upload (one or more files, streamed to disk; nothing is buffered in memory) ----
  app.post<{ Params: { channelId: string } }>(
    '/api/channels/:channelId/attachments',
    {
      schema: {
        params: { type: 'object', properties: { channelId: { type: 'string', maxLength: 64 } } }
      }
    },
    async (request, reply) => {
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
      if (!request.isMultipart()) throw badRequest('Expected multipart/form-data', 'not_multipart')

      // Cheap checks before reading any bytes.
      const usage = await ctx.repo.attachmentUsage(user.id)
      if (usage.pendingCount >= cfg.maxPendingPerUser) {
        throw badRequest('Too many unsent uploads. Send or remove some first.', 'too_many_pending')
      }
      if (usage.user >= cfg.userQuotaBytes) {
        throw insufficientStorage(`You've used your ${mb(cfg.userQuotaBytes)} upload quota.`)
      }
      if (usage.total >= cfg.totalQuotaBytes) {
        throw insufficientStorage('The server’s attachment storage is full.')
      }
      if (store.freeBytes() < cfg.minFreeDiskBytes) {
        request.log.warn({ free: store.freeBytes() }, 'upload refused: low disk space')
        throw insufficientStorage('The server is low on disk space. Uploads are paused.')
      }

      const created: AttachmentRecord[] = []
      let requestBytes = 0

      /** Validates and stores one file part; throws an ApiError on any problem. */
      const storeOne = async (file: MultipartFile): Promise<AttachmentRecord> => {
          const filename = sanitizeFilename(file.filename ?? '', LIMITS.filenameMaxLength)
          const type = typeForFilename(filename)
          if (!type) {
            throw unsupportedType(
              `This file type isn’t allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}.`
            )
          }
          const typeLimit = type.kind === 'image' ? cfg.maxImageBytes : cfg.maxFileBytes
          const remaining = Math.min(
            cfg.maxRequestBytes - requestBytes,
            cfg.userQuotaBytes - usage.user - requestBytes,
            cfg.totalQuotaBytes - usage.total - requestBytes
          )
          const maxBytes = Math.max(0, Math.min(typeLimit, remaining))

          let received
          try {
            received = await store.receive(file.file, maxBytes)
          } catch (err) {
            if (err instanceof FileTooLargeError) {
              throw payloadTooLarge(
                maxBytes < typeLimit
                  ? 'This upload would exceed your storage quota or the per-upload limit.'
                  : `${type.kind === 'image' ? 'Images' : 'Files'} can be at most ${mb(typeLimit)}.`,
                'file_too_large'
              )
            }
            throw err
          }
          // @fastify/multipart also truncates at its own (global) limit.
          if (file.file.truncated) {
            await store.discard(received.tmpPath)
            throw payloadTooLarge(`Files can be at most ${mb(typeLimit)}.`, 'file_too_large')
          }
          if (received.size === 0) {
            await store.discard(received.tmpPath)
            throw badRequest('The file is empty', 'empty_file')
          }
          if (!type.matches(received.head)) {
            await store.discard(received.tmpPath)
            throw unsupportedType(`The file’s contents don’t match its .${type.ext} extension.`)
          }
          let width: number | null = null
          let height: number | null = null
          if (type.kind === 'image') {
            const size = imageSize(type.contentType, received.head)
            if (!size) {
              await store.discard(received.tmpPath)
              throw unsupportedType('This image could not be read.')
            }
            if (size.width * size.height > cfg.maxImagePixels) {
              await store.discard(received.tmpPath)
              throw payloadTooLarge(
                `Images can be at most ${Math.round(cfg.maxImagePixels / 1e6)} megapixels.`,
                'image_too_large'
              )
            }
            width = size.width
            height = size.height
          }

          const id = newAttachmentId()
          await store.commit(received.tmpPath, id)
          const record: AttachmentRecord = {
            id,
            messageId: null,
            channelId: channel.id,
            uploaderId: user.id,
            filename,
            contentType: type.contentType,
            kind: type.kind,
            size: received.size,
            width,
            height,
            sha256: received.sha256,
            position: 0,
            createdAt: Date.now()
          }
          try {
            await ctx.repo.createAttachment(record)
          } catch (err) {
            await store.remove(id)
            throw err
          }
          return record
      }

      // On failure keep draining the remaining parts (without storing them) so the client
      // receives the error promptly instead of stalling on an unread request body.
      let failure: unknown = null
      try {
        for await (const part of request.parts()) {
          if (part.type !== 'file') continue // ignore stray fields
          const file = part as MultipartFile
          if (failure) {
            file.file.resume()
            continue
          }
          if (created.length >= cfg.maxFilesPerMessage) {
            failure = badRequest(`At most ${cfg.maxFilesPerMessage} files per upload`, 'too_many_files')
            file.file.resume()
            continue
          }
          try {
            const record = await storeOne(file)
            created.push(record)
            requestBytes += record.size
          } catch (err) {
            failure = err
            if (!file.file.destroyed) file.file.resume()
          }
        }
      } catch (err) {
        failure ??= err
        // The multipart stream itself failed; don't reuse this connection.
        reply.header('Connection', 'close')
      }

      if (failure) {
        // Roll back everything this request stored.
        await ctx.repo.deleteAttachmentRows(created.map((a) => a.id)).catch(() => undefined)
        await Promise.all(created.map((a) => store.remove(a.id)))
        const code = (failure as { code?: string }).code
        if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
          throw badRequest(`At most ${cfg.maxFilesPerMessage} files per upload`, 'too_many_files')
        }
        if (code === 'FST_REQ_FILE_TOO_LARGE') {
          throw payloadTooLarge(`Files can be at most ${mb(cfg.maxFileBytes)}.`, 'file_too_large')
        }
        throw failure
      }

      if (created.length === 0) throw badRequest('No file was uploaded', 'no_file')
      request.log.info(
        {
          op: 'upload',
          channel: channel.id,
          files: created.length,
          bytes: requestBytes,
          types: created.map((a) => a.contentType)
        },
        'attachments uploaded'
      )
      reply.code(201)
      return created.map(toApiAttachment) satisfies ApiAttachment[]
    }
  )

  // ---- Download ----
  app.get<{ Params: { attachmentId: string }; Querystring: { download?: string } }>(
    '/api/attachments/:attachmentId',
    {
      schema: {
        params: {
          type: 'object',
          properties: { attachmentId: { type: 'string', maxLength: 64 } }
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { download: { type: 'string', enum: ['0', '1'] } }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      const id = request.params.attachmentId
      if (!isAttachmentId(id)) throw notFound('Attachment not found')
      const attachment = await ctx.repo.getAttachment(id)
      if (!attachment) throw notFound('Attachment not found')
      if (attachment.messageId === null) {
        // Unsent uploads are visible to their uploader only.
        if (attachment.uploaderId !== user.id) throw notFound('Attachment not found')
      } else {
        // Sent attachments follow the channel: member of the server and View Channel.
        const access = await ctx.access.channel(user, attachment.channelId)
        if (!access || access.channelPermissions === 0) throw notFound('Attachment not found')
      }

      const inline = attachment.kind === 'image' && request.query.download !== '1'
      const type = attachment.contentType.startsWith('text/')
        ? `${attachment.contentType}; charset=utf-8`
        : attachment.contentType
      let stream
      try {
        stream = store.open(attachment.id)
        await new Promise<void>((resolve, reject) => {
          stream!.once('open', () => resolve())
          stream!.once('error', reject)
        })
      } catch {
        request.log.error({ attachment: attachment.id }, 'attachment file missing on disk')
        throw notFound('Attachment file is missing')
      }
      reply
        .header('Content-Type', type)
        .header('Content-Length', attachment.size)
        .header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', attachment.filename))
        // Uploaded content is never active: no scripts, no plugins, no same-origin access.
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cross-Origin-Resource-Policy', 'same-site')
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('ETag', `"${attachment.sha256}"`)
      return reply.send(stream)
    }
  )

  // ---- Cancel an upload that wasn't sent ----
  app.delete<{ Params: { attachmentId: string } }>(
    '/api/attachments/:attachmentId',
    {
      schema: {
        params: {
          type: 'object',
          properties: { attachmentId: { type: 'string', maxLength: 64 } }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      const id = request.params.attachmentId
      if (!isAttachmentId(id)) throw notFound('Attachment not found')
      const removed = await ctx.repo.deletePendingAttachment(id, user.id)
      if (!removed) {
        const existing = await ctx.repo.getAttachment(id)
        if (existing && existing.uploaderId === user.id) {
          throw badRequest('This attachment was already sent; delete the message instead.', 'already_sent')
        }
        throw notFound('Attachment not found')
      }
      await store.remove(id)
      reply.code(204)
    }
  )
}

/**
 * Housekeeping: deletes abandoned (never sent) uploads, then files on disk that have no row.
 * Sent attachments are only ever deleted together with their message.
 */
export async function cleanupAttachments(
  ctx: AppContext,
  log: FastifyBaseLogger,
  now = Date.now()
): Promise<{ stale: number; orphans: number; temps: number }> {
  const stale = await ctx.repo.listStalePendingAttachments(now - ctx.config.attachments.pendingTtlMs)
  await ctx.repo.deleteAttachmentRows(stale.map((a) => a.id))
  await Promise.all(stale.map((a) => ctx.attachments.remove(a.id)))
  // Read the referenced ids *after* deleting stale rows; the grace period protects uploads in flight.
  const referenced = await ctx.repo.listAttachmentIds()
  const swept = await ctx.attachments.sweep(referenced, 60 * 60_000, now)
  if (stale.length || swept.orphans || swept.temps) {
    log.info({ stale: stale.length, ...swept }, 'attachment cleanup')
  }
  return { stale: stale.length, ...swept }
}
