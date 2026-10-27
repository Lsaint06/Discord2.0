import { describe, expect, it } from 'vitest'
import type { Message } from '../types'
import type { ApiMessage } from '../net/protocol'
import {
  applyDelete,
  applyEdit,
  applyPin,
  applyReaction,
  mergeMessages,
  reconcileWindow,
  toMessage,
  toggleReactionLocally
} from './messageState'

const msg = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  channelId: 'c1',
  authorId: 'alice',
  content: `m${id}`,
  timestamp: Number(id) * 1000,
  editedAt: null,
  replyTo: null,
  attachments: [],
  reactions: [],
  pinned: false,
  ...extra
})

describe('toMessage', () => {
  it('fills defaults for fields older servers omit', () => {
    const api = {
      id: '5',
      channelId: 'c1',
      authorId: 'bob',
      content: 'hi',
      createdAt: 123
    } as ApiMessage
    const m = toMessage(api)
    expect(m).toMatchObject({
      id: '5',
      timestamp: 123,
      editedAt: null,
      replyTo: null,
      pinned: false
    })
    expect(m.attachments).toEqual([])
    expect(m.reactions).toEqual([])
  })
})

describe('mergeMessages', () => {
  it('returns the same array when nothing arrives', () => {
    const list = [msg('1')]
    expect(mergeMessages(list, [])).toBe(list)
  })

  it('replaces the optimistic copy by nonce and keeps order by id', () => {
    const pending = msg('local-x', { nonce: 'n1', pending: true })
    const merged = mergeMessages([msg('1'), pending], [msg('3', { nonce: 'n1' }), msg('2')])
    expect(merged.map((m) => m.id)).toEqual(['1', '2', '3'])
    expect(merged.some((m) => m.pending)).toBe(false)
  })

  it('lets the server copy win for known ids and keeps local messages last', () => {
    const failed = msg('local-y', { nonce: 'n2', failed: 'rate limited' })
    const merged = mergeMessages([msg('1'), failed], [msg('1', { content: 'fresh' })])
    expect(merged[0].content).toBe('fresh')
    expect(merged[1]).toBe(failed)
  })
})

describe('applyEdit', () => {
  it('applies newer edits and updates reply previews', () => {
    const list = [
      msg('1'),
      msg('2', { replyTo: { id: '1', authorId: 'alice', content: 'm1', deleted: false } })
    ]
    const next = applyEdit(list, { id: '1', content: 'changed', editedAt: 10 })
    expect(next[0]).toMatchObject({ content: 'changed', editedAt: 10 })
    expect(next[1].replyTo).toMatchObject({ content: 'changed' })
  })

  it('ignores stale or duplicate edits (out-of-order events)', () => {
    const list = [msg('1', { content: 'new', editedAt: 20 })]
    expect(applyEdit(list, { id: '1', content: 'old', editedAt: 10 })).toBe(list)
    expect(applyEdit(list, { id: '1', content: 'new', editedAt: 20 })).toBe(list)
  })
})

describe('applyDelete', () => {
  it('removes the message and marks replies as pointing to a deleted original', () => {
    const list = [
      msg('1'),
      msg('2', { replyTo: { id: '1', authorId: 'alice', content: 'm1', deleted: false } })
    ]
    const next = applyDelete(list, '1')
    expect(next.map((m) => m.id)).toEqual(['2'])
    expect(next[0].replyTo).toEqual({ id: '1', deleted: true })
  })

  it('is a no-op for unknown ids', () => {
    const list = [msg('1')]
    expect(applyDelete(list, '9')).toBe(list)
  })
})

describe('reactions', () => {
  it('uses the authoritative count; `me` only changes for our own events', () => {
    let list = [msg('1')]
    list = applyReaction(
      list,
      { messageId: '1', emoji: '👍', count: 1, userId: 'bob', added: true },
      'me'
    )
    expect(list[0].reactions).toEqual([{ emoji: '👍', count: 1, me: false }])
    list = applyReaction(
      list,
      { messageId: '1', emoji: '👍', count: 2, userId: 'me', added: true },
      'me'
    )
    expect(list[0].reactions).toEqual([{ emoji: '👍', count: 2, me: true }])
    list = applyReaction(
      list,
      { messageId: '1', emoji: '👍', count: 1, userId: 'bob', added: false },
      'me'
    )
    expect(list[0].reactions).toEqual([{ emoji: '👍', count: 1, me: true }])
    list = applyReaction(
      list,
      { messageId: '1', emoji: '👍', count: 0, userId: 'me', added: false },
      'me'
    )
    expect(list[0].reactions).toEqual([])
  })

  it('is idempotent so replays and optimistic updates converge', () => {
    const optimistic = toggleReactionLocally([msg('1')], '1', '🔥', true, 'me')
    expect(optimistic[0].reactions).toEqual([{ emoji: '🔥', count: 1, me: true }])
    const confirmed = applyReaction(
      optimistic,
      { messageId: '1', emoji: '🔥', count: 1, userId: 'me', added: true },
      'me'
    )
    expect(confirmed).toBe(optimistic)
    // Toggling to the current state is a no-op.
    expect(toggleReactionLocally(optimistic, '1', '🔥', true, 'me')).toBe(optimistic)
    expect(toggleReactionLocally(optimistic, '1', '🔥', false, 'me')[0].reactions).toEqual([])
  })
})

describe('applyPin', () => {
  it('sets the flag and skips no-op updates', () => {
    const list = [msg('1')]
    const pinned = applyPin(list, '1', true)
    expect(pinned[0].pinned).toBe(true)
    expect(applyPin(pinned, '1', true)).toBe(pinned)
  })
})

describe('reconcileWindow', () => {
  it('drops messages deleted while offline inside the reloaded window, keeps older ones', () => {
    const existing = [msg('1'), msg('5'), msg('6'), msg('local', { nonce: 'n', pending: true })]
    const latest = [msg('5', { content: 'edited' }), msg('7')]
    const next = reconcileWindow(existing, latest)
    expect(next.map((m) => m.id)).toEqual(['1', '5', '7', 'local'])
    expect(next[1].content).toBe('edited')
  })

  it('keeps only local messages when the channel is now empty', () => {
    const local = msg('local', { nonce: 'n', failed: 'x' })
    expect(reconcileWindow([msg('1'), local], [])).toEqual([local])
  })
})
