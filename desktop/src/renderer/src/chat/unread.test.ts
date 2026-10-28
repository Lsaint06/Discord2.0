import { describe, expect, it } from 'vitest'
import type { Message } from '../types'
import {
  anchoredScrollTop,
  applyIncoming,
  applyReadPosition,
  firstUnreadId,
  isNearBottom,
  listChange,
  notificationText,
  shouldAcknowledge,
  shouldNotify,
  type NotifyContext
} from './unread'

const msg = (id: string, authorId = 'bob', extra: Partial<Message> = {}): Message => ({
  id,
  channelId: 'c1',
  authorId,
  content: '',
  timestamp: 0,
  ...extra
})

describe('read state', () => {
  it('counts incoming messages from others, not our own', () => {
    let s = applyIncoming(undefined, { id: '10', authorId: 'bob' }, 'me')
    s = applyIncoming({ ...s, lastReadId: '9' }, { id: '11', authorId: 'bob' }, 'me')
    expect(s.unreadCount).toBe(2)
    s = applyIncoming(s, { id: '12', authorId: 'me' }, 'me')
    expect(s).toEqual({ lastReadId: '12', unreadCount: 0, lastMessageId: '12' })
  })

  it('does not count messages at or before the read position', () => {
    const s = applyIncoming(
      { lastReadId: '20', unreadCount: 0, lastMessageId: '20' },
      { id: '15', authorId: 'bob' },
      'me'
    )
    expect(s.unreadCount).toBe(0)
    expect(s.lastMessageId).toBe('20')
  })

  it('read position only moves forward', () => {
    const base = { lastReadId: '10', unreadCount: 3, lastMessageId: '13' }
    expect(applyReadPosition(base, '9')).toBe(base)
    expect(applyReadPosition(base, '13')).toMatchObject({ lastReadId: '13', unreadCount: 0 })
  })

  it('recounts precisely from loaded messages on a partial read', () => {
    const base = { lastReadId: '10', unreadCount: 3, lastMessageId: '13' }
    const messages = [msg('11'), msg('12', 'me'), msg('13')]
    expect(applyReadPosition(base, '11', { messages, meId: 'me' }).unreadCount).toBe(1)
    expect(applyReadPosition(base, '11').unreadCount).toBe(3)
  })

  it('finds the first unread message from someone else', () => {
    const messages = [msg('1'), msg('2', 'me'), msg('3'), msg('4', 'bob', { pending: true })]
    expect(firstUnreadId(messages, '1', 'me')).toBe('3')
    expect(firstUnreadId(messages, null, 'me')).toBeUndefined()
    expect(firstUnreadId(messages, '3', 'me')).toBeUndefined()
  })

  it('acknowledges only when focused, at the bottom and viewing the latest', () => {
    const ok = {
      latestId: '5',
      lastReadId: '4',
      windowFocused: true,
      nearBottom: true,
      hasNewer: false
    }
    expect(shouldAcknowledge(ok)).toBe(true)
    expect(shouldAcknowledge({ ...ok, windowFocused: false })).toBe(false)
    expect(shouldAcknowledge({ ...ok, nearBottom: false })).toBe(false)
    expect(shouldAcknowledge({ ...ok, hasNewer: true })).toBe(false)
    expect(shouldAcknowledge({ ...ok, lastReadId: '5' })).toBe(false)
    expect(shouldAcknowledge({ ...ok, latestId: undefined })).toBe(false)
  })
})

describe('notifications', () => {
  const ctx: NotifyContext = {
    enabled: true,
    permission: 'granted',
    meId: 'me',
    mutedChannels: {},
    activeChannelId: 'c2',
    windowFocused: true
  }
  const m = { authorId: 'bob', channelId: 'c1' }

  it('notifies for other channels and when the window is unfocused', () => {
    expect(shouldNotify(m, ctx)).toBe(true)
    expect(shouldNotify(m, { ...ctx, activeChannelId: 'c1', windowFocused: false })).toBe(true)
  })

  it('stays quiet when disabled, denied, muted, own or already visible', () => {
    expect(shouldNotify(m, { ...ctx, enabled: false })).toBe(false)
    expect(shouldNotify(m, { ...ctx, permission: 'denied' })).toBe(false)
    expect(shouldNotify(m, { ...ctx, mutedChannels: { c1: true } })).toBe(false)
    expect(shouldNotify({ ...m, authorId: 'me' }, ctx)).toBe(false)
    expect(shouldNotify(m, { ...ctx, activeChannelId: 'c1' })).toBe(false)
  })

  it('hides message content unless previews are enabled', () => {
    const input = {
      authorName: 'Bob',
      channelName: 'general',
      content: 'secret plans',
      attachmentCount: 0,
      showPreview: false
    }
    expect(notificationText(input)).toEqual({ title: 'Bob in #general', body: 'New message' })
    expect(notificationText({ ...input, showPreview: true }).body).toBe('secret plans')
    expect(
      notificationText({ ...input, content: '', attachmentCount: 2, showPreview: true }).body
    ).toBe('Sent 2 attachments')
    expect(
      notificationText({ ...input, content: 'x'.repeat(300), showPreview: true }).body
    ).toHaveLength(120)
  })

  it('says when the notification is a mention (content still hidden by default)', () => {
    expect(
      notificationText({
        authorName: 'Bob',
        channelName: 'general',
        content: '@me secret',
        attachmentCount: 0,
        showPreview: false,
        mention: true
      })
    ).toEqual({ title: 'Bob mentioned you in #general', body: 'New message' })
  })

  it('titles direct and group conversations without a channel name', () => {
    const base = {
      authorName: 'Bob',
      channelName: 'direct-message',
      content: 'hi',
      attachmentCount: 0,
      showPreview: false,
      mention: true
    }
    expect(notificationText({ ...base, conversation: { kind: 'dm' } })).toEqual({
      title: 'Bob',
      body: 'New message'
    })
    expect(
      notificationText({ ...base, conversation: { kind: 'group', title: 'Road trip' } }).title
    ).toBe('Bob in Road trip')
    // Content stays hidden unless previews are on, as for channels.
    expect(
      notificationText({ ...base, showPreview: true, conversation: { kind: 'dm' } }).body
    ).toBe('hi')
  })
})

describe('scrolling', () => {
  it('detects being near the bottom', () => {
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1500, clientHeight: 550 })).toBe(true)
    expect(isNearBottom({ scrollTop: 100, scrollHeight: 1500, clientHeight: 550 })).toBe(false)
  })

  it('anchors the viewport after prepending older messages', () => {
    expect(anchoredScrollTop({ scrollTop: 10, scrollHeight: 1000 }, 1600)).toBe(610)
    expect(anchoredScrollTop({ scrollTop: 10, scrollHeight: 1000 }, 500)).toBe(0)
  })

  it('classifies list changes', () => {
    const prev = { firstId: '5', lastId: '9', count: 5 }
    expect(listChange({ count: 0 }, prev)).toBe('replaced')
    expect(listChange(prev, prev)).toBe('none')
    expect(listChange(prev, { firstId: '1', lastId: '9', count: 9 })).toBe('prepended')
    expect(listChange(prev, { firstId: '5', lastId: '10', count: 6 })).toBe('appended')
    expect(listChange(prev, { firstId: '50', lastId: '60', count: 10 })).toBe('replaced')
  })
})
