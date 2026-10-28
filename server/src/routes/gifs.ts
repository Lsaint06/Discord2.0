/**
 * GIF picker proxy (Milestone 13): search and trending through the configured provider, and the
 * media itself streamed back from the provider's CDN. The provider API key stays on the server;
 * clients never contact the provider. Results and media are cached briefly to save the
 * provider's (small) request budget, and a global limiter stops the server from exceeding it.
 */
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { GIF_ID, GifProviderError, type GifItem, type GifPage, type GifProvider, type GifQuery } from '../gifs/provider.js'
import { requireUser } from '../lib/auth.js'
import { ApiError, badRequest, notFound, tooManyRequests } from '../lib/errors.js'
import { TokenBucketLimiter } from '../lib/rateLimit.js'
import type { ApiGif, ApiGifPage } from '../protocol.js'

const PAGE_SIZE = 24
const RESULT_TTL_MS = 10 * 60_000
const ITEM_TTL_MS = 6 * 60 * 60_000
const MAX_ITEMS = 5000
const MEDIA_MAX_BYTES = 8 * 1024 * 1024
const MEDIA_CACHE_BYTES = 64 * 1024 * 1024
/** Downloads from the provider's media hosts at once, server-wide (each is held in memory). */
const MAX_MEDIA_FETCHES = 6
/** Media responses one person can have open at once. */
const MAX_OPEN_MEDIA_PER_USER = 12
/** Bytes of media responses still being sent, server-wide: slow readers can't pile up memory. */
const MAX_OPEN_MEDIA_BYTES = 96 * 1024 * 1024
/** A media response that makes no progress for this long is dropped. */
const MEDIA_STALL_MS = 20_000
/** GIF ids the provider doesn't know are remembered this long (no repeated provider calls). */
const MISS_TTL_MS = 10 * 60_000

const busy = (): ApiError =>
  new ApiError(503, 'gifs_busy', 'GIFs are busy right now. Try again in a moment.', 2_000)

/**
 * Media responses still being sent: how many per person, and how many bytes in total. A
 * reader that stops reading keeps its response (and buffer) alive; these bounds cap that.
 */
export class OpenMediaGate {
  private bytes = 0
  private readonly perUser = new Map<string, number>()
  constructor(
    private readonly maxBytes: number,
    private readonly maxPerUser: number
  ) {}

  /** A release function (safe to call twice), or null if a limit would be exceeded. */
  open(userId: string, size: number): (() => void) | null {
    const mine = this.perUser.get(userId) ?? 0
    if (mine >= this.maxPerUser || this.bytes + size > this.maxBytes) return null
    this.bytes += size
    this.perUser.set(userId, mine + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.bytes -= size
      const left = (this.perUser.get(userId) ?? 1) - 1
      if (left > 0) this.perUser.set(userId, left)
      else this.perUser.delete(userId)
    }
  }

  get openBytes(): number {
    return this.bytes
  }

  get openResponses(): number {
    let n = 0
    for (const count of this.perUser.values()) n += count
    return n
  }
}

/** Small expiring map with a size bound (oldest first out). */
class TtlCache<V> {
  private readonly map = new Map<string, { value: V; until: number }>()
  constructor(
    private readonly ttlMs: number,
    private readonly max: number
  ) {}
  get(key: string, now = Date.now()): V | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (hit.until <= now) {
      this.map.delete(key)
      return undefined
    }
    return hit.value
  }
  set(key: string, value: V, now = Date.now()): void {
    this.map.delete(key)
    this.map.set(key, { value, until: now + this.ttlMs })
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!)
  }
  get size(): number {
    return this.map.size
  }
}

/** Media bytes, bounded by total size (least recently used out). */
class MediaCache {
  private readonly map = new Map<string, { data: Buffer; contentType: string }>()
  private bytes = 0
  constructor(private readonly maxBytes: number) {}
  get(key: string): { data: Buffer; contentType: string } | undefined {
    const hit = this.map.get(key)
    if (hit) {
      this.map.delete(key)
      this.map.set(key, hit)
    }
    return hit
  }
  set(key: string, value: { data: Buffer; contentType: string }): void {
    if (value.data.length > this.maxBytes) return
    const old = this.map.get(key)
    if (old) this.bytes -= old.data.length
    this.map.delete(key)
    this.map.set(key, value)
    this.bytes += value.data.length
    while (this.bytes > this.maxBytes) {
      const [oldest, entry] = this.map.entries().next().value!
      this.map.delete(oldest)
      this.bytes -= entry.data.length
    }
  }
}

export interface GifService {
  provider: GifProvider
  /** Provider requests made (tests). */
  readonly stats: { providerCalls: number }
  /** Media responses still being sent (tests). */
  readonly openMedia: OpenMediaGate
}

const toApiGif = (g: GifItem): ApiGif => ({
  id: g.id,
  title: g.title,
  width: g.preview.width,
  height: g.preview.height,
  fullWidth: g.full.width,
  fullHeight: g.full.height
})

function providerError(err: unknown): ApiError {
  if (err instanceof GifProviderError) {
    if (err.kind === 'rate_limited') return new ApiError(503, 'gifs_busy', 'GIF search is resting for a moment. Try again soon.', 60_000)
    if (err.kind === 'too_large') return new ApiError(413, 'gif_too_large', err.message)
    return new ApiError(502, 'gifs_unavailable', 'The GIF service isn’t answering right now.')
  }
  return err instanceof ApiError ? err : new ApiError(502, 'gifs_unavailable', 'The GIF service isn’t answering right now.')
}

export function registerGifRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  provider: GifProvider | null,
  options: { providerCallsPerHour?: number } = {}
): GifService | null {
  const disabled = (): ApiError => new ApiError(404, 'gifs_disabled', 'GIFs aren’t set up on this server.')
  if (!provider) {
    for (const path of ['/api/gifs/trending', '/api/gifs/search', '/api/gifs/media/:id']) {
      app.get(path, async (request) => {
        await requireUser(ctx, request)
        throw disabled()
      })
    }
    return null
  }

  const stats = { providerCalls: 0 }
  const results = new TtlCache<GifPage>(RESULT_TTL_MS, 500)
  const items = new TtlCache<GifItem>(ITEM_TTL_MS, MAX_ITEMS)
  const misses = new TtlCache<true>(MISS_TTL_MS, MAX_ITEMS)
  const media = new MediaCache(MEDIA_CACHE_BYTES)
  const openMedia = new OpenMediaGate(MAX_OPEN_MEDIA_BYTES, MAX_OPEN_MEDIA_PER_USER)
  const inflight = new Map<string, Promise<unknown>>()
  let fetching = 0
  // The whole server shares the provider's request budget (GIPHY beta keys: 100 per hour), and
  // each person may use a third of it, so nobody can use it all up for everyone else.
  const perHour = options.providerCallsPerHour ?? 90
  const budget = new TokenBucketLimiter(perHour, perHour / 3600)
  const perPerson = Math.max(1, Math.ceil(perHour / 3))
  const share = new TokenBucketLimiter(perPerson, perPerson / 3600)
  app.addHook('onClose', async () => {
    budget.dispose()
    share.dispose()
  })

  const customerId = (userId: string): string =>
    createHash('sha256').update(`d2-gif-customer:${userId}`).digest('hex').slice(0, 32)
  const query = (userId: string, offset: number): GifQuery => ({
    limit: PAGE_SIZE,
    offset,
    rating: ctx.config.gifs.rating,
    locale: ctx.config.gifs.locale,
    country: ctx.config.gifs.country,
    customerId: customerId(userId)
  })

  /** One provider request per key at a time; counts against the person's share and the budget. */
  async function viaProvider<T>(key: string, userId: string, run: () => Promise<T>): Promise<T> {
    const running = inflight.get(key)
    if (running) return running as Promise<T>
    const mine = share.take(userId)
    if (!mine.ok) throw tooManyRequests(mine.retryAfterMs)
    if (!budget.take('all').ok) {
      throw new ApiError(503, 'gifs_busy', 'GIF search is resting for a moment. Try again soon.', 60_000)
    }
    stats.providerCalls++
    const promise = run().finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }

  const pageResponse = (page: GifPage): ApiGifPage => {
    for (const g of page.items) items.set(g.id, g)
    return {
      provider: provider.name,
      attribution: provider.attribution,
      items: page.items.map(toApiGif),
      next: page.next
    }
  }

  const offsetSchema = { type: 'string', pattern: '^[0-9]{1,4}$' } as const

  app.get<{ Querystring: { offset?: string } }>(
    '/api/gifs/trending',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { offset: offsetSchema } } } },
    async (request): Promise<ApiGifPage> => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.gifSearchPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const offset = Number(request.query.offset ?? 0)
      // Trending is the same for everyone: one cache entry per page.
      const key = `trending:${offset}`
      let page = results.get(key)
      if (!page) {
        try {
          page = await viaProvider(key, user.id, () => provider.trending(query(user.id, offset)))
        } catch (err) {
          throw providerError(err)
        }
        results.set(key, page)
      }
      return pageResponse(page)
    }
  )

  app.get<{ Querystring: { q: string; offset?: string } }>(
    '/api/gifs/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          additionalProperties: false,
          properties: { q: { type: 'string', minLength: 1, maxLength: 50 }, offset: offsetSchema }
        }
      }
    },
    async (request): Promise<ApiGifPage> => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.gifSearchPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const term = request.query.q.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
      if (!term) throw badRequest('Type something to search for', 'empty_query')
      const offset = Number(request.query.offset ?? 0)
      const key = `search:${term.toLowerCase()}:${offset}`
      let page = results.get(key)
      if (!page) {
        try {
          page = await viaProvider(key, user.id, () => provider.search(term, query(user.id, offset)))
        } catch (err) {
          throw providerError(err)
        }
        results.set(key, page)
      }
      return pageResponse(page)
    }
  )

  app.get<{ Params: { id: string }; Querystring: { size?: 'preview' | 'still' | 'full' } }>(
    '/api/gifs/media/:id',
    {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } } },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { size: { type: 'string', enum: ['preview', 'still', 'full'] } }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.gifMediaPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const id = request.params.id
      if (!GIF_ID.test(id)) throw notFound('GIF not found')
      const size = request.query.size ?? 'full'
      const mediaKey = `${id}:${size}`
      let file = media.get(mediaKey)
      if (!file) {
        try {
          let item = items.get(id)
          if (!item) {
            if (misses.get(id)) throw notFound('GIF not found')
            const found = await viaProvider(`get:${id}`, user.id, () =>
              provider.get(id, { rating: ctx.config.gifs.rating, locale: ctx.config.gifs.locale, country: ctx.config.gifs.country, customerId: customerId(user.id) })
            )
            if (!found) {
              misses.set(id, true)
              throw notFound('GIF not found')
            }
            item = found
            items.set(id, item)
          }
          const url = item[size].url
          // Never fetch anything but the provider's own media hosts (no SSRF via ids).
          if (!provider.isMediaUrl(url)) throw notFound('GIF not found')
          const key = `media:${mediaKey}`
          let download = inflight.get(key) as Promise<{ data: Buffer; contentType: string }> | undefined
          if (!download) {
            if (fetching >= MAX_MEDIA_FETCHES) throw busy()
            fetching++
            download = provider.fetchMedia(url, MEDIA_MAX_BYTES).finally(() => {
              fetching--
              inflight.delete(key)
            })
            inflight.set(key, download)
          }
          file = await download
          media.set(mediaKey, file)
        } catch (err) {
          if (err instanceof ApiError && (err.statusCode === 404 || err.statusCode === 429 || err.code === 'gifs_busy')) throw err
          throw providerError(err)
        }
      }
      // Counted until the response is fully sent or the connection drops.
      const release = openMedia.open(user.id, file.data.length)
      if (!release) throw busy()
      // A reader that stops reading doesn't get to pin the bytes indefinitely. The connection
      // can carry other requests afterwards (keep-alive, the proxy's pool): its timeout is put
      // back as it was when this response ends.
      const socket = reply.raw.socket
      const previousTimeout = socket?.timeout ?? 0
      reply.raw.setTimeout(MEDIA_STALL_MS, () => reply.raw.destroy())
      reply.raw.once('close', () => {
        release()
        if (socket && !socket.destroyed) socket.setTimeout(previousTimeout)
      })
      reply
        .header('Content-Type', file.contentType)
        .header('Content-Length', file.data.length)
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cross-Origin-Resource-Policy', 'same-site')
        .header('Cache-Control', 'private, max-age=86400')
      return reply.send(file.data)
    }
  )

  return { provider, stats, openMedia }
}
