/**
 * GIF picker providers (Milestone 13). The server talks to the provider with its own API key
 * (never sent to clients) and hands out provider-independent results. Media is streamed
 * through /api/gifs/media/:id, so the desktop app's CSP stays strict and members' IP addresses
 * are not shared with the provider.
 */
import type { GifConfig, GifRating } from '../config.js'

export interface GifRendition {
  url: string
  width: number
  height: number
  /** Bytes, when the provider says. */
  size?: number
}

export interface GifItem {
  /** Provider id (letters, digits, '-' and '_'). */
  id: string
  title: string
  /** Small animated version for the picker grid. */
  preview: GifRendition
  /** First frame (reduced motion). */
  still: GifRendition
  /** What a message shows. */
  full: GifRendition
}

export interface GifPage {
  items: GifItem[]
  /** Offset of the next page, or null at the end. */
  next: number | null
}

export interface GifQuery {
  limit: number
  offset: number
  rating: GifRating
  locale: string
  country: string | null
  /** Stable, anonymous per-user id (some providers personalise or rate-limit with it). */
  customerId: string
}

export interface GifProvider {
  readonly name: 'giphy' | 'mock'
  /** Shown in the picker, as the provider's terms require. */
  readonly attribution: { text: string; url: string }
  trending(query: GifQuery): Promise<GifPage>
  search(term: string, query: GifQuery): Promise<GifPage>
  /** One GIF by id (null if it doesn't exist or isn't allowed by the rating). */
  get(id: string, query: Omit<GifQuery, 'limit' | 'offset'>): Promise<GifItem | null>
  /** Whether `url` may be fetched for this provider's media (SSRF guard). */
  isMediaUrl(url: string): boolean
  /** Fetches media bytes (the mock serves generated images; real providers use HTTPS). */
  fetchMedia(url: string, maxBytes: number): Promise<{ data: Buffer; contentType: string }>
}

export const GIF_ID = /^[A-Za-z0-9_-]{1,64}$/

export class GifProviderError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'rate_limited' | 'bad_response' | 'too_large',
    message: string
  ) {
    super(message)
  }
}

const MEDIA_TYPES = new Set(['image/gif', 'image/webp'])

/** Downloads one media file with a size cap and a strict content type (no redirects). */
export async function fetchMediaOverHttps(
  url: string,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch
): Promise<{ data: Buffer; contentType: string }> {
  let res: Response
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
  } catch {
    throw new GifProviderError('unavailable', 'The GIF could not be downloaded.')
  }
  if (!res.ok || !res.body) throw new GifProviderError('unavailable', `The GIF host answered ${res.status}.`)
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!MEDIA_TYPES.has(contentType)) throw new GifProviderError('bad_response', 'Unexpected GIF media type.')
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel().catch(() => undefined)
    throw new GifProviderError('too_large', 'This GIF is too large.')
  }
  const chunks: Buffer[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new GifProviderError('too_large', 'This GIF is too large.')
    }
    chunks.push(Buffer.from(value))
  }
  return { data: Buffer.concat(chunks), contentType }
}

export async function createGifProvider(config: GifConfig): Promise<GifProvider | null> {
  if (config.provider === 'giphy') {
    const { GiphyProvider } = await import('./giphy.js')
    return new GiphyProvider(config.apiKey!)
  }
  if (config.provider === 'mock') {
    const { MockGifProvider } = await import('./mock.js')
    return new MockGifProvider()
  }
  return null
}
