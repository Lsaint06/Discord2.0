/**
 * Unread tracking, notification and scroll decisions as pure functions (unit tested).
 */
import type { Message } from '../types'

export interface ReadState {
  /** Last message this user has read (server-authoritative, moves forward only). */
  lastReadId: string | null
  /** Unread messages from others (server count, then kept live from gateway events). */
  unreadCount: number
  lastMessageId: string | null
  /**
   * Unread messages that mention you (ids newer than lastReadId, oldest first). Found in real
   * messages only: live ones, and the unread page fetched at start-up (see useBackend).
   */
  mentionIds?: string[]
}

/** Mention badges show "99+" beyond this; tracking more ids adds nothing. */
export const MAX_TRACKED_MENTIONS = 100

const newer = (a: string | null | undefined, b: string | null | undefined): boolean =>
  a != null && (b == null || Number(a) > Number(b))

const keepNewer = (ids: string[] | undefined, lastReadId: string): string[] | undefined =>
  ids && ids.filter((id) => newer(id, lastReadId))

/** Unread mentions of you in this channel. */
export function mentionCount(state: ReadState | undefined): number {
  return state?.mentionIds?.length ?? 0
}

/** Adds mentions found by scanning unread messages (ignores read or duplicate ids). */
export function withMentions(state: ReadState | undefined, ids: string[]): ReadState {
  const base: ReadState = state ?? { lastReadId: null, unreadCount: 0, lastMessageId: null }
  const merged = new Set(base.mentionIds ?? [])
  for (const id of ids) if (newer(id, base.lastReadId)) merged.add(id)
  if (merged.size === (base.mentionIds?.length ?? 0)) return base
  const mentionIds = [...merged].sort((a, b) => Number(a) - Number(b)).slice(-MAX_TRACKED_MENTIONS)
  return { ...base, mentionIds }
}

/** A mentioning message was deleted or edited so it no longer mentions you. */
export function dropMention(state: ReadState | undefined, id: string): ReadState | undefined {
  if (!state?.mentionIds?.includes(id)) return state
  return { ...state, mentionIds: state.mentionIds.filter((m) => m !== id) }
}

/** Applies a read position (from our own ack or another session); never moves backwards. */
export function applyReadPosition(
  state: ReadState | undefined,
  lastReadId: string,
  /** Messages from others we have loaded for this channel, if any, to recount precisely. */
  loaded?: { messages: Message[]; meId: string | undefined }
): ReadState {
  const base: ReadState = state ?? { lastReadId: null, unreadCount: 0, lastMessageId: lastReadId }
  if (!newer(lastReadId, base.lastReadId)) return base
  let unreadCount = 0
  if (newer(base.lastMessageId, lastReadId)) {
    // Something newer than the read position exists; count what we can see, else keep 1.
    unreadCount = loaded
      ? loaded.messages.filter(
          (m) => !m.pending && !m.failed && m.authorId !== loaded.meId && newer(m.id, lastReadId)
        ).length
      : Math.max(1, base.unreadCount)
  }
  return { ...base, lastReadId, unreadCount, mentionIds: keepNewer(base.mentionIds, lastReadId) }
}

/** A new message arrived over the gateway. `mentioned`: it mentions you (chat/mentions.ts). */
export function applyIncoming(
  state: ReadState | undefined,
  message: { id: string; authorId: string },
  meId: string | undefined,
  mentioned = false
): ReadState {
  const base: ReadState = state ?? { lastReadId: null, unreadCount: 0, lastMessageId: null }
  const lastMessageId = newer(message.id, base.lastMessageId) ? message.id : base.lastMessageId
  if (message.authorId === meId) {
    // Our own message means we've read up to it (the server advances it too).
    return { lastReadId: message.id, unreadCount: 0, lastMessageId }
  }
  if (!newer(message.id, base.lastReadId)) return { ...base, lastMessageId }
  const next = { ...base, lastMessageId, unreadCount: base.unreadCount + 1 }
  return mentioned ? withMentions(next, [message.id]) : next
}

/**
 * Whether the channel on screen should be marked read now. Being open isn't enough: the window
 * must have focus and the user must actually be looking at the newest messages.
 */
export function shouldAcknowledge(input: {
  latestId: string | undefined
  lastReadId: string | null | undefined
  windowFocused: boolean
  nearBottom: boolean
  /** The loaded window doesn't reach the newest message (viewing old history). */
  hasNewer: boolean
}): boolean {
  return (
    input.latestId !== undefined &&
    input.windowFocused &&
    input.nearBottom &&
    !input.hasNewer &&
    newer(input.latestId, input.lastReadId)
  )
}

/** The first message from someone else after the read position (where "New" is drawn). */
export function firstUnreadId(
  messages: Message[],
  lastReadId: string | null | undefined,
  meId: string | undefined
): string | undefined {
  if (lastReadId == null) return undefined
  return messages.find(
    (m) => !m.pending && !m.failed && m.authorId !== meId && newer(m.id, lastReadId)
  )?.id
}

// ---- Notifications ----

export interface NotifyContext {
  enabled: boolean
  permission: NotificationPermission | 'unsupported'
  meId: string | undefined
  mutedChannels: Record<string, boolean>
  activeChannelId: string | undefined
  windowFocused: boolean
  /** Only @mentions notify in this server (its default or your choice)… */
  mentionsOnly?: boolean
  /** …and this message mentions you (or is a DM). */
  mentionsMe?: boolean
}

export function shouldNotify(
  message: { authorId: string; channelId: string },
  ctx: NotifyContext
): boolean {
  if (!ctx.enabled || ctx.permission !== 'granted') return false
  if (message.authorId === ctx.meId) return false
  if (ctx.mutedChannels[message.channelId]) return false
  if (ctx.mentionsOnly && !ctx.mentionsMe) return false
  // Already looking at that conversation.
  if (ctx.windowFocused && ctx.activeChannelId === message.channelId) return false
  return true
}

export type ServerNotificationChoice = 'default' | 'all' | 'mentions'

/** The level that applies in a server: your choice, else the server's default, else all. */
export function effectiveNotificationLevel(
  choice: ServerNotificationChoice | undefined,
  serverDefault: 'all' | 'mentions' | undefined
): 'all' | 'mentions' {
  if (choice === 'all' || choice === 'mentions') return choice
  return serverDefault ?? 'all'
}

/** Notification text. Message content is only included when the user opted in. */
export function notificationText(input: {
  authorName: string
  channelName: string
  content: string
  attachmentCount: number
  showPreview: boolean
  /** The message mentions you (see chat/mentions.ts). */
  mention?: boolean
  /** Set for direct (one-to-one) and group conversations instead of a server channel. */
  conversation?: { kind: 'dm' } | { kind: 'group'; title: string }
}): { title: string; body: string } {
  const title =
    input.conversation?.kind === 'dm'
      ? input.authorName
      : input.conversation?.kind === 'group'
        ? `${input.authorName} in ${input.conversation.title}`
        : input.mention
          ? `${input.authorName} mentioned you in #${input.channelName}`
          : `${input.authorName} in #${input.channelName}`
  if (!input.showPreview) return { title, body: 'New message' }
  const text = input.content.trim()
  const body =
    text.length > 0
      ? text.length > 120
        ? `${text.slice(0, 119)}…`
        : text
      : input.attachmentCount > 0
        ? `Sent ${input.attachmentCount === 1 ? 'an attachment' : `${input.attachmentCount} attachments`}`
        : 'New message'
  return { title, body }
}

// ---- Scrolling ----

export const NEAR_BOTTOM_PX = 80

export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = NEAR_BOTTOM_PX
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

/** Keeps the same content under the viewport after older messages are inserted above it. */
export function anchoredScrollTop(
  prev: { scrollTop: number; scrollHeight: number },
  nextScrollHeight: number
): number {
  return Math.max(0, prev.scrollTop + (nextScrollHeight - prev.scrollHeight))
}

/** How the list changed between renders, to decide how to scroll. */
export function listChange(
  prev: { firstId?: string; lastId?: string; count: number },
  next: { firstId?: string; lastId?: string; count: number }
): 'none' | 'prepended' | 'appended' | 'replaced' {
  if (prev.count === 0) return next.count === 0 ? 'none' : 'replaced'
  if (prev.firstId === next.firstId && prev.lastId === next.lastId) return 'none'
  if (prev.lastId === next.lastId && prev.firstId !== next.firstId) return 'prepended'
  if (prev.firstId === next.firstId && prev.lastId !== next.lastId) return 'appended'
  return 'replaced'
}
