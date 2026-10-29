/**
 * Milestone 8: profiles, profile pictures and banners, status / custom status, and synced
 * preferences. Every route derives the user from the session; nobody can change another
 * person's profile (except an instance administrator removing an inappropriate image).
 */
import type { MultipartFile } from '@fastify/multipart'
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify'
import type { AppContext } from '../context.js'
import type { CustomStatusRecord, ProfileMediaRecord } from '../db/repository.js'
import { FileTooLargeError } from '../attachments/store.js'
import { requireUser } from '../lib/auth.js'
import {
  ApiError,
  badRequest,
  insufficientStorage,
  notFound,
  payloadTooLarge,
  tooManyRequests,
  unsupportedType
} from '../lib/errors.js'
import {
  normalizeBio,
  normalizeColor,
  normalizeCustomStatusText,
  normalizeDisplayName,
  normalizeEmoji,
  normalizeProfileStyle,
  normalizePronouns
} from '../lib/validation.js'
import {
  isProfileMediaId,
  processProfileImage,
  ProfileImageError,
  type CropRect,
  type ProfileImageSize
} from '../profile/media.js'
import {
  APP_THEMES,
  DEFAULT_PREFERENCES,
  LIMITS,
  type ApiPreferences,
  type AppThemeId,
  type ApiProfile,
  type MessageDensity,
  type ProfileImageKind,
  type ReducedMotionPreference,
  type SelectableStatus,
  type ThemePreference
} from '../protocol.js'
import { publishProfileChange, publishStatusChange, toApiMe } from '../realtime.js'
import { requireInstanceAdmin } from './admin.js'

const MB = 1024 * 1024
const KINDS: readonly ProfileImageKind[] = ['avatar', 'banner']
const THEMES: readonly ThemePreference[] = ['dark', 'light', 'system']
const DENSITIES: readonly MessageDensity[] = ['cozy', 'compact']
const MOTION: readonly ReducedMotionPreference[] = ['system', 'on', 'off']
const COLOR_PATTERN = '^#[0-9a-fA-F]{6}$'

const nullableString = (maxLength: number) => ({
  anyOf: [{ type: 'string', maxLength }, { type: 'null' }]
})

/** Stored preferences → full, valid preferences (unknown or invalid values fall back to defaults). */
export function parsePreferences(stored: { data: string; updatedAt: number } | undefined): ApiPreferences {
  if (!stored) return { ...DEFAULT_PREFERENCES }
  let raw: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(stored.data)
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
  } catch {
    raw = {}
  }
  const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback
  const idle = raw.idleTimeoutMinutes
  return {
    theme: pick(raw.theme, THEMES, DEFAULT_PREFERENCES.theme),
    accentColor:
      typeof raw.accentColor === 'string' && new RegExp(COLOR_PATTERN).test(raw.accentColor)
        ? raw.accentColor.toLowerCase()
        : null,
    density: pick(raw.density, DENSITIES, DEFAULT_PREFERENCES.density),
    reducedMotion: pick(raw.reducedMotion, MOTION, DEFAULT_PREFERENCES.reducedMotion),
    showTimestamps:
      typeof raw.showTimestamps === 'boolean' ? raw.showTimestamps : DEFAULT_PREFERENCES.showTimestamps,
    idleTimeoutMinutes:
      typeof idle === 'number' &&
      Number.isInteger(idle) &&
      idle >= LIMITS.idleTimeoutMinMinutes &&
      idle <= LIMITS.idleTimeoutMaxMinutes
        ? idle
        : DEFAULT_PREFERENCES.idleTimeoutMinutes,
    appTheme: APP_THEMES.includes(raw.appTheme as AppThemeId) ? (raw.appTheme as AppThemeId) : null,
    updatedAt: stored.updatedAt
  }
}

export function imageError(err: ProfileImageError): ApiError {
  switch (err.code) {
    case 'unsupported_type':
      return unsupportedType(err.message)
    case 'too_large':
      return payloadTooLarge(err.message, 'image_too_large')
    case 'too_small':
      return badRequest(err.message, 'image_too_small')
    case 'busy':
      return new ApiError(503, 'busy', err.message, 2000)
    default:
      return badRequest(err.message, 'image_unreadable')
  }
}

/**
 * Receives the first file of a multipart image upload into a temp file (other parts are
 * drained). The caller processes it and must discard `tmpPath` afterwards.
 */
export async function receiveImageUpload(
  ctx: AppContext,
  request: FastifyRequest
): Promise<{ tmpPath: string; head: Buffer; fields: Record<string, string> }> {
  if (!request.isMultipart()) throw badRequest('Expected multipart/form-data', 'not_multipart')
  if (ctx.attachments.freeBytes() < ctx.config.attachments.minFreeDiskBytes) {
    throw insufficientStorage('The server is low on disk space. Uploads are paused.')
  }
  let received: { tmpPath: string; head: Buffer } | null = null
  let failure: unknown = null
  // Small text fields sent with the image (Milestone 14: the crop of an animated image).
  const fields: Record<string, string> = {}
  try {
    for await (const part of request.parts()) {
      if (part.type !== 'file') {
        if (
          /^[a-z]{1,16}$/i.test(part.fieldname) &&
          typeof part.value === 'string' &&
          part.value.length <= 32 &&
          Object.keys(fields).length < 8
        ) {
          fields[part.fieldname] = part.value
        }
        continue
      }
      const file = part as MultipartFile
      if (received || failure) {
        file.file.resume() // only the first file counts; drain the rest
        continue
      }
      try {
        const got = await ctx.attachments.receive(file.file, LIMITS.profileImageMaxBytes)
        if (file.file.truncated || got.size === 0) {
          await ctx.attachments.discard(got.tmpPath)
          failure = got.size === 0 ? badRequest('The file is empty', 'empty_file') : null
          failure ??= payloadTooLarge(
            `Images can be at most ${LIMITS.profileImageMaxBytes / MB} MB.`,
            'file_too_large'
          )
        } else {
          received = { tmpPath: got.tmpPath, head: got.head }
        }
      } catch (err) {
        failure =
          err instanceof FileTooLargeError
            ? payloadTooLarge(`Images can be at most ${LIMITS.profileImageMaxBytes / MB} MB.`, 'file_too_large')
            : err
        if (!file.file.destroyed) file.file.resume()
      }
    }
  } catch (err) {
    failure ??= err
  }
  if (failure) {
    if (received) await ctx.attachments.discard(received.tmpPath)
    throw failure
  }
  if (!received) throw badRequest('No image was uploaded', 'no_file')
  return { ...received, fields }
}

/** Milestone 14: crop fields of an upload (all four, whole pixels) or null when absent. */
export function cropFromFields(fields: Record<string, string>): CropRect | null {
  const keys = ['cropLeft', 'cropTop', 'cropWidth', 'cropHeight'] as const
  if (keys.every((k) => fields[k] === undefined)) return null
  const values = keys.map((k) => (/^\d{1,6}$/.test(fields[k] ?? '') ? Number(fields[k]) : NaN))
  if (values.some((v) => !Number.isInteger(v))) throw badRequest('Invalid crop', 'invalid_crop')
  const [left, top, width, height] = values as [number, number, number, number]
  return { left, top, width, height }
}

export function registerProfileRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- Profile text fields ----
  app.patch<{
    Body: {
      displayName?: string
      avatarColor?: string
      bio?: string | null
      pronouns?: string | null
      accentColor?: string | null
      profileStyle?: unknown
    }
  }>(
    '/api/users/me',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            displayName: { type: 'string', maxLength: 64 },
            avatarColor: { type: 'string', maxLength: 7 },
            // Generous raw limits; the normalizers enforce the real ones after cleanup.
            bio: nullableString(LIMITS.bioMaxLength * 2),
            pronouns: nullableString(LIMITS.pronounsMaxLength * 2),
            accentColor: nullableString(7),
            // Milestone 14: checked field by field by normalizeProfileStyle.
            profileStyle: { anyOf: [{ type: 'object', maxProperties: 8 }, { type: 'null' }] }
          }
        }
      }
    },
    async (request) => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.profilePerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)

      const body = request.body
      if (Object.keys(body).length === 0) throw badRequest('Nothing to update')
      const updated = await ctx.repo.updateUser(user.id, {
        displayName: body.displayName === undefined ? undefined : normalizeDisplayName(body.displayName),
        avatarColor: body.avatarColor === undefined ? undefined : normalizeColor(body.avatarColor),
        bio: body.bio === undefined ? undefined : normalizeBio(body.bio),
        pronouns: body.pronouns === undefined ? undefined : normalizePronouns(body.pronouns),
        accentColor:
          body.accentColor === undefined
            ? undefined
            : body.accentColor === null
              ? null
              : normalizeColor(body.accentColor),
        profileStyle: body.profileStyle === undefined ? undefined : normalizeProfileStyle(body.profileStyle)
      })
      if (!updated) throw badRequest('User no longer exists')
      await publishProfileChange(ctx, updated)
      return toApiMe(ctx, updated)
    }
  )

  // ---- Status preference and custom status ----
  app.put<{
    Body: {
      status?: SelectableStatus
      customStatus?: {
        text?: string | null
        emoji?: string | null
        expiresInMs?: number | null
      } | null
    }
  }>(
    '/api/users/me/status',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['online', 'idle', 'dnd', 'invisible'] },
            customStatus: {
              anyOf: [
                { type: 'null' },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    text: nullableString(LIMITS.customStatusMaxLength * 2),
                    emoji: nullableString(LIMITS.emojiMaxLength),
                    expiresInMs: {
                      anyOf: [
                        { type: 'integer', minimum: 60_000, maximum: LIMITS.customStatusMaxMs },
                        { type: 'null' }
                      ]
                    }
                  }
                }
              ]
            }
          }
        }
      }
    },
    async (request) => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.presencePerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const { status, customStatus } = request.body
      if (status === undefined && customStatus === undefined) throw badRequest('Nothing to update')

      let custom: CustomStatusRecord | null | undefined
      if (customStatus === null) {
        custom = null
      } else if (customStatus !== undefined) {
        const text = normalizeCustomStatusText(customStatus.text)
        let emoji: string | null = null
        if (customStatus.emoji) {
          try {
            emoji = normalizeEmoji(customStatus.emoji)
          } catch {
            throw badRequest('The status emoji must be a single emoji', 'invalid_emoji')
          }
        }
        custom =
          text || emoji
            ? {
                text,
                emoji,
                expiresAt: customStatus.expiresInMs ? Date.now() + customStatus.expiresInMs : null
              }
            : null
      }

      let updated = user
      if (status !== undefined) updated = (await ctx.repo.setStatusPreference(user.id, status)) ?? updated
      if (custom !== undefined) updated = (await ctx.repo.setCustomStatus(user.id, custom)) ?? updated
      await publishStatusChange(ctx, updated)
      return toApiMe(ctx, updated)
    }
  )

  // ---- Synced preferences ----
  app.get('/api/users/me/preferences', async (request): Promise<ApiPreferences> => {
    const user = await requireUser(ctx, request)
    return parsePreferences(await ctx.repo.getPreferences(user.id))
  })

  app.patch<{ Body: Partial<Omit<ApiPreferences, 'updatedAt'>> }>(
    '/api/users/me/preferences',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            theme: { type: 'string', enum: [...THEMES] },
            accentColor: { anyOf: [{ type: 'string', pattern: COLOR_PATTERN }, { type: 'null' }] },
            density: { type: 'string', enum: [...DENSITIES] },
            reducedMotion: { type: 'string', enum: [...MOTION] },
            showTimestamps: { type: 'boolean' },
            idleTimeoutMinutes: {
              type: 'integer',
              minimum: LIMITS.idleTimeoutMinMinutes,
              maximum: LIMITS.idleTimeoutMaxMinutes
            },
            appTheme: { anyOf: [{ type: 'string', enum: [...APP_THEMES] }, { type: 'null' }] }
          }
        }
      }
    },
    async (request): Promise<ApiPreferences> => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.presencePerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const current = parsePreferences(await ctx.repo.getPreferences(user.id))
      const next = { ...current, ...request.body }
      if (typeof next.accentColor === 'string') next.accentColor = next.accentColor.toLowerCase()
      const now = Date.now()
      // Only known keys are stored (the schema already rejects anything else).
      const data = JSON.stringify({
        theme: next.theme,
        accentColor: next.accentColor,
        density: next.density,
        reducedMotion: next.reducedMotion,
        showTimestamps: next.showTimestamps,
        idleTimeoutMinutes: next.idleTimeoutMinutes,
        appTheme: next.appTheme ?? null
      })
      await ctx.repo.savePreferences(user.id, data, now)
      const saved: ApiPreferences = { ...next, updatedAt: now }
      ctx.hub.sendToUser(user.id, { op: 'preferences_update', d: saved })
      return saved
    }
  )

  // ---- Avatar and banner upload / removal ----
  for (const kind of KINDS) {
    app.post(`/api/users/me/${kind}`, async (request) => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.profileMediaPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const received = await receiveImageUpload(ctx, request)

      let image
      try {
        image = await processProfileImage(kind, received.tmpPath, received.head, {
          keepAnimation: true,
          crop: cropFromFields(received.fields)
        })
      } catch (err) {
        throw err instanceof ProfileImageError ? imageError(err) : err
      } finally {
        // The original upload is never kept.
        await ctx.attachments.discard(received.tmpPath)
      }

      const media: ProfileMediaRecord = {
        id: ctx.profileMedia.newId(),
        userId: user.id,
        kind,
        width: image.width,
        height: image.height,
        size: image.full.length,
        sha256: image.sha256,
        createdAt: Date.now(),
        animated: image.animated
      }
      await ctx.profileMedia.save(media.id, image)
      let result
      try {
        result = await ctx.repo.replaceProfileMedia(user.id, kind, media)
      } catch (err) {
        await ctx.profileMedia.remove(media.id)
        throw err
      }
      await ctx.profileMedia.remove(result.previousId)
      const updated = result.user ?? user
      request.log.info({ op: `${kind}_upload`, bytes: media.size }, 'profile image updated')
      await publishProfileChange(ctx, updated)
      return toApiMe(ctx, updated)
    })

    app.delete(`/api/users/me/${kind}`, async (request) => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.profileMediaPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const { previousId, user: updated } = await ctx.repo.replaceProfileMedia(user.id, kind, null)
      await ctx.profileMedia.remove(previousId)
      if (previousId && updated) await publishProfileChange(ctx, updated)
      return toApiMe(ctx, updated ?? user)
    })
  }

  // ---- Moderation: an instance administrator removes someone's image ----
  app.delete<{ Params: { userId: string; kind: string } }>(
    '/api/admin/accounts/:userId/profile-media/:kind',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string', maxLength: 64 },
            kind: { type: 'string', enum: [...KINDS] }
          }
        }
      }
    },
    async (request, reply) => {
      const admin = await requireInstanceAdmin(ctx, request)
      const target = await ctx.repo.getUser(request.params.userId)
      if (!target) throw notFound('Account not found')
      const kind = request.params.kind as ProfileImageKind
      const { previousId, user: updated } = await ctx.repo.replaceProfileMedia(target.id, kind, null)
      await ctx.profileMedia.remove(previousId)
      if (previousId && updated) {
        await ctx.audit.record({
          action: 'admin.profile_media_removed',
          actorId: admin.id,
          targetUserId: target.id,
          request,
          detail: { kind }
        })
        await publishProfileChange(ctx, updated)
      }
      reply.code(204)
    }
  )

  // ---- Profile image download (authenticated; only for people who can see the owner) ----
  app.get<{ Params: { mediaId: string }; Querystring: { size?: ProfileImageSize } }>(
    '/api/profile-media/:mediaId',
    {
      schema: {
        params: { type: 'object', properties: { mediaId: { type: 'string', maxLength: 64 } } },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { size: { type: 'string', enum: ['full', 'small', 'still'] } }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.profileReadsPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const id = request.params.mediaId
      // The id shape is checked before it is ever used in a path (no traversal).
      if (!isProfileMediaId(id)) throw notFound('Image not found')
      const media = await ctx.repo.getProfileMedia(id)
      if (!media || !(await ctx.repo.isUserVisibleTo(user.id, media.userId))) {
        throw notFound('Image not found')
      }
      const size = request.query.size ?? 'full'
      let file
      try {
        // 'still' exists only for animated images; a still image is its own still frame.
        file = await ctx.profileMedia
          .open(id, size)
          .catch((err: unknown) => (size === 'still' ? ctx.profileMedia.open(id, 'full') : Promise.reject(err)))
      } catch {
        request.log.error({ media: id }, 'profile image missing on disk')
        throw notFound('Image file is missing')
      }
      reply
        .header('Content-Type', 'image/webp')
        .header('Content-Length', file.size)
        .header('Content-Disposition', `inline; filename="${media.kind}.webp"`)
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cross-Origin-Resource-Policy', 'same-site')
        // Ids are never reused: a new picture gets a new id, so this can be cached forever.
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('ETag', `"${media.sha256.slice(0, 32)}-${size}"`)
      return reply.send(file.stream)
    }
  )

  // ---- Full profile (profile modal) ----
  app.get<{ Params: { userId: string } }>(
    '/api/users/:userId/profile',
    {
      schema: {
        params: { type: 'object', properties: { userId: { type: 'string', maxLength: 64 } } }
      }
    },
    async (request): Promise<ApiProfile> => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.profileReadsPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const target = await ctx.repo.getUser(request.params.userId)
      if (!target || !(await ctx.repo.isUserVisibleTo(user.id, target.id))) {
        throw notFound('User not found')
      }
      const self = target.id === user.id
      const blocked = self ? new Set<string>() : await ctx.repo.blockedEither(user.id)
      // Only your own block is reported; being blocked looks like having no relationship.
      const relationship = self
        ? null
        : ((await ctx.repo.listRelationships(user.id)).find((r) => r.userId === target.id)?.type ?? null)
      return {
        user: ctx.hub.apiUserFor(target, blocked),
        mutualServerIds: self ? [] : await ctx.repo.mutualServerIds(user.id, target.id),
        relationship
      }
    }
  )
}

/** Removes processed image files that no longer have a database row (after a grace period). */
export async function cleanupProfileMedia(
  ctx: AppContext,
  log: FastifyBaseLogger,
  now = Date.now()
): Promise<number> {
  const referenced = await ctx.repo.listProfileMediaIds()
  const removed = await ctx.profileMedia.sweep(referenced, 60 * 60_000, now)
  if (removed) log.info({ removed }, 'profile media cleanup')
  return removed
}
