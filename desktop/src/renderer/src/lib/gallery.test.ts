import { describe, expect, it } from 'vitest'
import { galleryGrid, galleryOrder, galleryPageSize, pageFor } from './gallery'

describe('gallery grid', () => {
  it('one camera: one big tile', () => {
    expect(galleryGrid(1, 1200, 700)).toMatchObject({ columns: 1, rows: 1 })
    expect(galleryGrid(1, 1200, 700).tileWidth).toBeGreaterThan(1100)
  })

  it('two cameras: side by side in a wide window, stacked in a tall one', () => {
    expect(galleryGrid(2, 1200, 600)).toMatchObject({ columns: 2, rows: 1 })
    expect(galleryGrid(2, 500, 900)).toMatchObject({ columns: 1, rows: 2 })
  })

  it('three or four: a balanced 2×2 grid', () => {
    expect(galleryGrid(3, 1200, 700)).toMatchObject({ columns: 2, rows: 2 })
    expect(galleryGrid(4, 1200, 700)).toMatchObject({ columns: 2, rows: 2 })
  })

  it('eight cameras fit without overflowing and keep 16:9', () => {
    const g = galleryGrid(8, 1200, 700)
    expect(g.columns * g.rows).toBeGreaterThanOrEqual(8)
    expect(g.columns * g.tileWidth + (g.columns - 1) * 8).toBeLessThanOrEqual(1200)
    expect(g.rows * g.tileHeight + (g.rows - 1) * 8).toBeLessThanOrEqual(700)
    expect(g.tileWidth / g.tileHeight).toBeCloseTo(16 / 9, 1)
  })

  it('degenerate sizes do not throw', () => {
    expect(galleryGrid(0, 100, 100).tileWidth).toBe(0)
    expect(galleryGrid(3, 0, 0).tileWidth).toBe(0)
  })
})

describe('gallery pages', () => {
  it('a narrow window shows fewer tiles per page, a wide one more', () => {
    expect(galleryPageSize(1600, 900)).toBeGreaterThan(galleryPageSize(600, 500))
    expect(galleryPageSize(300, 200)).toBe(1)
  })

  it('the focused person is always on the page shown', () => {
    const order = ['a', 'b', 'c', 'd', 'e'].map((identity) => ({ identity }))
    expect(pageFor(order, 2, 0, 'e')).toBe(2)
    expect(pageFor(order, 2, 9)).toBe(2)
    expect(pageFor(order, 2, -1)).toBe(0)
  })
})

describe('gallery order', () => {
  const people = [
    { identity: 'ana', isLocal: false, cameraOn: true },
    { identity: 'me', isLocal: true, cameraOn: true },
    { identity: 'bob', isLocal: false, cameraOn: false },
    { identity: 'cy', isLocal: false, cameraOn: true }
  ]
  it('your self-view first, then others in join order; cameras that are off get no video tile', () => {
    expect(galleryOrder(people, { hideSelf: false }).map((p) => p.identity)).toEqual([
      'me',
      'ana',
      'cy'
    ])
  })
  it('hiding your self-view does not change anything else', () => {
    expect(galleryOrder(people, { hideSelf: true }).map((p) => p.identity)).toEqual(['ana', 'cy'])
  })
})
