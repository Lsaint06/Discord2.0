/**
 * Offline GIF provider for development and tests (GIF_PROVIDER=mock; refused in production).
 * Results are generated locally — coloured WebP images — so nothing leaves the machine.
 */
import sharp from 'sharp'
import { GifProviderError, type GifItem, type GifPage, type GifProvider, type GifQuery } from './provider.js'

const WORDS = ['cat', 'dog', 'party', 'wave', 'yes', 'no', 'wow', 'thanks', 'lol', 'hello', 'dance', 'coffee']
const COLORS = ['#e0607e', '#3ba776', '#4aa3df', '#f0a43a', '#9b6ad6', '#56b3a6']
const TOTAL = 60

function item(n: number): GifItem {
  const word = WORDS[n % WORDS.length]!
  const id = `mock-${word}-${n}`
  const media = (size: string, w: number, h: number) => ({ url: `mock://gif/${id}/${size}`, width: w, height: h })
  return {
    id,
    title: `${word} ${n}`,
    preview: media('preview', 200, 150),
    still: media('still', 200, 150),
    full: media('full', 400, 300)
  }
}

export class MockGifProvider implements GifProvider {
  readonly name = 'mock' as const
  readonly attribution = { text: 'Test GIFs (offline)', url: 'https://example.invalid/' }
  /** Counts provider calls (tests check caching and rate limiting). */
  calls = 0

  isMediaUrl(url: string): boolean {
    return /^mock:\/\/gif\/mock-[a-z]+-\d+\/(preview|still|full)$/.test(url)
  }

  async fetchMedia(url: string, maxBytes: number): Promise<{ data: Buffer; contentType: string }> {
    if (!this.isMediaUrl(url)) throw new GifProviderError('bad_response', 'Not a mock media URL.')
    const n = Number(/-(\d+)\//.exec(url)?.[1] ?? 0)
    const full = url.endsWith('/full')
    const data = await sharp({
      create: { width: full ? 400 : 200, height: full ? 300 : 150, channels: 3, background: COLORS[n % COLORS.length]! }
    })
      .webp({ quality: 60 })
      .toBuffer()
    if (data.length > maxBytes) throw new GifProviderError('too_large', 'This GIF is too large.')
    return { data, contentType: 'image/webp' }
  }

  private slice(list: GifItem[], query: GifQuery): GifPage {
    const items = list.slice(query.offset, query.offset + query.limit)
    const next = query.offset + items.length
    return { items, next: next < list.length ? next : null }
  }

  async trending(query: GifQuery): Promise<GifPage> {
    this.calls++
    return this.slice(
      Array.from({ length: TOTAL }, (_, i) => item(i)),
      query
    )
  }

  async search(term: string, query: GifQuery): Promise<GifPage> {
    this.calls++
    const q = term.trim().toLowerCase()
    const all = Array.from({ length: TOTAL }, (_, i) => item(i)).filter((g) => g.title.includes(q))
    return this.slice(all, query)
  }

  async get(id: string): Promise<GifItem | null> {
    this.calls++
    const n = Number(/^mock-[a-z]+-(\d+)$/.exec(id)?.[1] ?? NaN)
    if (!Number.isInteger(n) || n < 0 || n >= TOTAL) return null
    const found = item(n)
    return found.id === id ? found : null
  }
}
