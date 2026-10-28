/**
 * GIPHY adapter (https://developers.giphy.com/docs/api/endpoint/). Requests carry the server's
 * API key, the configured content rating and — because requests are proxied through this
 * server — the users' country, as GIPHY's documentation asks. Only media URLs on GIPHY's own
 * hosts are ever fetched.
 */
import {
  GifProviderError,
  fetchMediaOverHttps,
  type GifItem,
  type GifPage,
  type GifProvider,
  type GifQuery,
  type GifRendition
} from './provider.js'

const API = 'https://api.giphy.com/v1/gifs'
const TIMEOUT_MS = 8000

interface GiphyImage {
  url?: string
  webp?: string
  width?: string
  height?: string
  size?: string
}

interface GiphyGif {
  id?: string
  title?: string
  images?: Record<string, GiphyImage | undefined>
}

function rendition(image: GiphyImage | undefined, prefer: 'webp' | 'gif'): GifRendition | null {
  if (!image) return null
  const url = prefer === 'webp' ? (image.webp ?? image.url) : (image.url ?? image.webp)
  const width = Number(image.width)
  const height = Number(image.height)
  if (!url || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const size = Number(image.size)
  return { url, width, height, ...(Number.isFinite(size) && size > 0 ? { size } : {}) }
}

/** Maps a GIPHY GIF object; anything incomplete or pointing off GIPHY's hosts is dropped. */
export function toGifItem(gif: GiphyGif, isMediaUrl: (url: string) => boolean): GifItem | null {
  const id = gif.id
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !gif.images) return null
  const preview =
    rendition(gif.images.fixed_width, 'webp') ?? rendition(gif.images.fixed_width_downsampled, 'webp')
  const still = rendition(gif.images.fixed_width_still, 'gif')
  const full = rendition(gif.images.downsized_medium, 'gif') ?? rendition(gif.images.original, 'gif')
  if (!preview || !still || !full) return null
  if (![preview, still, full].every((r) => isMediaUrl(r.url))) return null
  return { id, title: (gif.title ?? '').slice(0, 140), preview, still, full }
}

export class GiphyProvider implements GifProvider {
  readonly name = 'giphy' as const
  readonly attribution = { text: 'Powered by GIPHY', url: 'https://giphy.com' }

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  isMediaUrl(url: string): boolean {
    try {
      const u = new URL(url)
      return (
        u.protocol === 'https:' &&
        /^(media\d*|i)\.giphy\.com$/.test(u.hostname) &&
        !u.username &&
        !u.password &&
        (u.port === '' || u.port === '443')
      )
    } catch {
      return false
    }
  }

  fetchMedia(url: string, maxBytes: number): Promise<{ data: Buffer; contentType: string }> {
    if (!this.isMediaUrl(url)) return Promise.reject(new GifProviderError('bad_response', 'Not a GIPHY media URL.'))
    return fetchMediaOverHttps(url, maxBytes, this.fetchImpl)
  }

  private async call(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${API}${path}`)
    for (const [k, v] of Object.entries({ ...params, api_key: this.apiKey })) url.searchParams.set(k, v)
    let res: Response
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
    } catch {
      throw new GifProviderError('unavailable', 'GIPHY could not be reached.')
    }
    if (res.status === 429) throw new GifProviderError('rate_limited', 'GIPHY is rate limiting this server.')
    if (res.status === 404) return null
    if (!res.ok) throw new GifProviderError('unavailable', `GIPHY answered ${res.status}.`)
    try {
      return await res.json()
    } catch {
      throw new GifProviderError('bad_response', 'GIPHY sent an unreadable answer.')
    }
  }

  private common(query: Omit<GifQuery, 'limit' | 'offset'>): Record<string, string> {
    return {
      rating: query.rating,
      customer_id: query.customerId,
      ...(query.country ? { country_code: query.country } : {}),
      bundle: 'messaging_non_clips'
    }
  }

  private page(body: unknown, query: GifQuery): GifPage {
    const data = (body as { data?: unknown } | null)?.data
    if (!Array.isArray(data)) throw new GifProviderError('bad_response', 'GIPHY sent an unexpected answer.')
    const items = data
      .map((g) => toGifItem(g as GiphyGif, (u) => this.isMediaUrl(u)))
      .filter((g): g is GifItem => g !== null)
    const pagination = (body as { pagination?: { total_count?: number } }).pagination
    const next = query.offset + data.length
    const total = Number(pagination?.total_count)
    const more = data.length >= query.limit && (!Number.isFinite(total) || next < total) && next < 499
    return { items, next: more ? next : null }
  }

  async trending(query: GifQuery): Promise<GifPage> {
    const body = await this.call('/trending', {
      ...this.common(query),
      limit: String(query.limit),
      offset: String(query.offset)
    })
    return this.page(body, query)
  }

  async search(term: string, query: GifQuery): Promise<GifPage> {
    const body = await this.call('/search', {
      ...this.common(query),
      q: term.slice(0, 50),
      lang: query.locale,
      limit: String(query.limit),
      offset: String(query.offset)
    })
    return this.page(body, query)
  }

  async get(id: string, query: Omit<GifQuery, 'limit' | 'offset'>): Promise<GifItem | null> {
    const body = await this.call(`/${encodeURIComponent(id)}`, this.common(query))
    const data = (body as { data?: unknown } | null)?.data
    if (!data || typeof data !== 'object') return null
    return toGifItem(data as GiphyGif, (u) => this.isMediaUrl(u))
  }
}
