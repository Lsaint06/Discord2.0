import { describe, expect, it } from 'vitest'
import { applySaved } from './saved'

describe('saved message ids', () => {
  it('nothing is shown or changed until the server has said it keeps saved messages', () => {
    expect(applySaved(null, '42', true, 1000)).toBeNull()
    expect(applySaved(null, '42', false, null)).toBeNull()
  })

  it('saving adds the message with the server’s time (or now, while the request is in flight)', () => {
    expect(applySaved({}, '42', true, 1000)).toEqual({ '42': 1000 })
    expect(applySaved({}, '42', true, null, 5)).toEqual({ '42': 5 })
  })

  it('saving again keeps the original time and the same object (no re-render)', () => {
    const prev = { '42': 1000 }
    expect(applySaved(prev, '42', true, 2000)).toBe(prev)
  })

  it('unsaving removes only that message; unknown ids change nothing', () => {
    const prev = { '1': 10, '2': 20 }
    expect(applySaved(prev, '1', false, null)).toEqual({ '2': 20 })
    expect(prev).toEqual({ '1': 10, '2': 20 })
    expect(applySaved(prev, '3', false, null)).toBe(prev)
  })
})
