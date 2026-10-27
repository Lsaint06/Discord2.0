import { describe, expect, it } from 'vitest'
import { AttachmentCache, type BlobUrlApi } from './attachmentCache'
import { ALL_EMOJI, pushRecent, searchEmoji } from './emoji'
import { fitBox } from './layout'

function fakeUrls(): BlobUrlApi & { revoked: string[] } {
  let n = 0
  const revoked: string[] = []
  return {
    revoked,
    createObjectURL: () => `blob:${n++}`,
    revokeObjectURL: (url) => void revoked.push(url)
  }
}
const blob = (size: number): Blob => ({ size }) as Blob

describe('AttachmentCache', () => {
  it('de-duplicates concurrent loads and caches results', async () => {
    let loads = 0
    const cache = new AttachmentCache(
      async () => {
        loads++
        return blob(10)
      },
      100,
      fakeUrls()
    )
    const [a, b] = await Promise.all([cache.get('x'), cache.get('x')])
    expect(a).toBe(b)
    expect(await cache.get('x')).toBe(a)
    expect(cache.peek('x')).toBe(a)
    expect(loads).toBe(1)
  })

  it('evicts least recently used entries over the byte budget and revokes their URLs', async () => {
    const urls = fakeUrls()
    const cache = new AttachmentCache(async () => blob(40), 100, urls)
    const a = await cache.get('a')
    await cache.get('b')
    await cache.get('a') // refresh a
    await cache.get('c') // 120 bytes > 100: evict b (least recent)
    expect(cache.peek('b')).toBeUndefined()
    expect(cache.peek('a')).toBe(a)
    expect(cache.size).toBe(80)
    expect(urls.revoked).toHaveLength(1)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(urls.revoked).toHaveLength(3)
  })

  it('does not cache failures', async () => {
    let fail = true
    const cache = new AttachmentCache(
      async () => {
        if (fail) throw new Error('offline')
        return blob(1)
      },
      100,
      fakeUrls()
    )
    await expect(cache.get('x')).rejects.toThrow('offline')
    fail = false
    await expect(cache.get('x')).resolves.toMatch(/^blob:/)
  })
})

describe('emoji', () => {
  it('searches by keyword and returns everything for an empty query', () => {
    expect(searchEmoji('')).toBe(ALL_EMOJI)
    expect(searchEmoji('thumbs').some((e) => e.emoji === '👍')).toBe(true)
    expect(searchEmoji('zzzz-nothing')).toEqual([])
  })

  it('keeps recent emoji unique, most recent first, capped', () => {
    expect(pushRecent(['😀', '👍'], '👍')).toEqual(['👍', '😀'])
    expect(pushRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b'])
  })
})

describe('fitBox', () => {
  it('scales down to fit without upscaling', () => {
    expect(fitBox(1600, 900, 400, 300)).toEqual({ width: 400, height: 225 })
    expect(fitBox(600, 1200, 400, 300)).toEqual({ width: 150, height: 300 })
    expect(fitBox(100, 50, 400, 300)).toEqual({ width: 100, height: 50 })
  })

  it('reserves a 16:9 box when dimensions are unknown', () => {
    expect(fitBox(undefined, undefined, 400, 300)).toEqual({ width: 400, height: 225 })
  })
})
