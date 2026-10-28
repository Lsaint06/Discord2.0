import { describe, expect, it } from 'vitest'
import { DeleteGuard, canDeleteMessage, deleteMode } from './messageDelete'

describe('message delete rules', () => {
  it('allows own messages and moderators, never unsent ones', () => {
    expect(canDeleteMessage({ own: true, manageMessages: false, local: false })).toBe(true)
    expect(canDeleteMessage({ own: false, manageMessages: true, local: false })).toBe(true)
    expect(canDeleteMessage({ own: false, manageMessages: false, local: false })).toBe(false)
    expect(canDeleteMessage({ own: true, manageMessages: true, local: true })).toBe(false)
  })

  it('skips confirmation only with Shift and no text selection', () => {
    expect(deleteMode({ shiftKey: true, hasTextSelection: false })).toBe('quick')
    expect(deleteMode({ shiftKey: false, hasTextSelection: false })).toBe('confirm')
    expect(deleteMode({ shiftKey: true, hasTextSelection: true })).toBe('confirm')
    expect(deleteMode({ shiftKey: false, hasTextSelection: true })).toBe('confirm')
  })

  it('sends one request per message while one is in flight', () => {
    const guard = new DeleteGuard()
    expect(guard.begin('m1')).toBe(true)
    expect(guard.begin('m1')).toBe(false)
    expect(guard.begin('m1')).toBe(false)
    expect(guard.begin('m2')).toBe(true) // other messages are independent
    expect(guard.has('m1')).toBe(true)
    guard.end('m1')
    expect(guard.has('m1')).toBe(false)
    expect(guard.begin('m1')).toBe(true) // e.g. retry after a failure
  })

  it('handles rapid deletion of many messages', async () => {
    const guard = new DeleteGuard()
    const sent: string[] = []
    const del = async (id: string): Promise<void> => {
      if (!guard.begin(id)) return
      try {
        sent.push(id)
        await Promise.resolve()
      } finally {
        guard.end(id)
      }
    }
    const ids = Array.from({ length: 20 }, (_, i) => `m${i}`)
    // Each message clicked three times in quick succession.
    await Promise.all(ids.flatMap((id) => [del(id), del(id), del(id)]))
    expect(sent).toEqual(ids)
    expect(ids.some((id) => guard.has(id))).toBe(false)
  })
})
