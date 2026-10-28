import { describe, expect, it } from 'vitest'
import type { Message } from '../types'
import {
  anchoredScrollTop,
  applyIncoming,
  applyReadPosition,
  dropMention,
  effectiveNotificationLevel,
  firstUnreadId,
  isNearBottom,
  listChange,
  mentionCount,
  notificationText,
  shouldAcknowledge,
  shouldNotify,
  withMentions,
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

describe('mention counts', () => {
  it('counts live mentions only while unread and from others', () => {
    let s = applyIncoming(undefined, { id: '10', authorId: 'bob' }, 'me', true)
    s = applyIncoming(s, { id: '11', authorId: 'bob' }, 'me', false)
    s = applyIncoming(s, { id: '12', authorId: 'ann' }, 'me', true)
    expect(mentionCount(s)).toBe(2)
    expect(s.unreadCount).toBe(3)
    // Reading up to 10 leaves one unread mention.
    s = applyReadPosition(s, '10')
    expect(s.mentionIds).toEqual(['12'])
    // Your own message reads everything.
    s = applyIncoming(s, { id: '13', authorId: 'me' }, 'me', true)
    expect(mentionCount(s)).toBe(0)
  })

  it('never counts already-read or duplicate mentions', () => {
    const read = { lastReadId: '20', unreadCount: 0, lastMessageId: '20' }
    expect(mentionCount(applyIncoming(read, { id: '19', authorId: 'bob' }, 'me', true))).toBe(0)
    const s = withMentions(read, ['18', '21', '21', '22'])
    expect(s.mentionIds).toEqual(['21', '22'])
    expect(withMentions(s, ['21'])).toBe(s)
  })

  it('drops deleted (or edited-away) mentions', () => {
    const s = withMentions({ lastReadId: '1', unreadCount: 2, lastMessageId: '3' }, ['2', '3'])
    expect(dropMention(s, '2')?.mentionIds).toEqual(['3'])
    expect(dropMention(s, '9')).toBe(s)
    expect(dropMention(undefined, '2')).toBeUndefined()
  })

  it('keeps the newest ids when there are very many', () => {
    const ids = Array.from({ length: 150 }, (_, i) => String(i + 1))
    const s = withMentions(undefined, ids)
    expect(mentionCount(s)).toBe(100)
    expect(s.mentionIds?.[0]).toBe('51')
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

  it('in an "only @mentions" server, notifies only for mentions', () => {
    expect(shouldNotify(m, { ...ctx, mentionsOnly: true, mentionsMe: false })).toBe(false)
    expect(shouldNotify(m, { ...ctx, mentionsOnly: true, mentionsMe: true })).toBe(true)
    expect(shouldNotify(m, { ...ctx, mentionsOnly: false, mentionsMe: false })).toBe(true)
  })

  it('your per-server choice wins over the server default', () => {
    expect(effectiveNotificationLevel(undefined, undefined)).toBe('all')
    expect(effectiveNotificationLevel(undefined, 'mentions')).toBe('mentions')
    expect(effectiveNotificationLevel('default', 'mentions')).toBe('mentions')
    expect(effectiveNotificationLevel('all', 'mentions')).toBe('all')
    expect(effectiveNotificationLevel('mentions', 'all')).toBe('mentions')
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
