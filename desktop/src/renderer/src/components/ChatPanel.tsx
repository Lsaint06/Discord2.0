import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { Channel, Message, User } from '../types'
import { ALL_PERMISSIONS, Permissions, type ApiAttachment } from '../net/protocol'
import { hasPermission } from '../lib/permissions'
import type { Backend, ChannelState } from '../hooks/useBackend'
import { describeError } from '../hooks/useBackend'
import { formatDayDivider, formatTimestamp, isSameDay } from '../lib/format'
import { lastConfirmedId } from '../chat/messageState'
import {
  anchoredScrollTop,
  firstUnreadId,
  isNearBottom,
  listChange,
  shouldAcknowledge,
  type ReadState
} from '../chat/unread'
import { filesFromTransfer } from '../chat/uploads'
import { messageLink } from '../chat/markdown'
import { createMentionDetector } from '../chat/mentions'
import type { Drafts } from '../chat/drafts'
import { DeleteGuard, canDeleteMessage } from '../chat/messageDelete'
import { gifMessageContent } from '../chat/gifs'
import { GifContext } from '../chat/gifContext'
import type { LargeFileSupport } from '../net/api'
import { anyDialogOpen } from '../lib/focusTrap'
import { useDialog } from '../hooks/useDialog'
import { AtIcon, BellIcon, FriendsIcon, HashIcon, MembersIcon, PinIcon, SearchIcon } from './Icons'
import Avatar from './Avatar'
import MessageItem, { type MessageActions } from './chat/MessageItem'
import Composer, { type ComposerHandle } from './chat/Composer'
import ContextMenu, { type MenuItem } from './chat/ContextMenu'
import EmojiPicker from './chat/EmojiPicker'
import Lightbox from './chat/Lightbox'
import SearchPanel from './chat/SearchPanel'
import PinsPanel from './chat/PinsPanel'

const GROUP_WINDOW_MS = 7 * 60_000
const EDGE_PX = 300

export interface JumpTarget {
  channelId: string
  messageId: string
  /** Changes for every request, so jumping to the same message twice works. */
  seq: number
}

/** Set when the chat panel shows a direct or group conversation instead of a server channel. */
export interface ConversationInfo {
  kind: 'dm' | 'group'
  /** Partner's name, or the group's name. */
  title: string
  /** "@Ana" or the group name — used in placeholders, pins and search. */
  label: string
  /** The other person in a one-to-one conversation. */
  partner?: User
  /** Why you can't send here (shown in the composer), if you can't. */
  readOnlyReason?: string
}

interface ChatPanelProps {
  channel: Channel
  /** null for conversations. */
  serverId: string | null
  conversation?: ConversationInfo
  state: ChannelState | undefined
  readState: ReadState | undefined
  meId: string
  selfName: string
  /** Your permanent username (mentions match it as well as your display name). */
  selfUsername: string
  banner?: ReactNode
  showMembers: boolean
  compactMode: boolean
  showTimestamps: boolean
  notificationsMuted: boolean
  pinsRevision: number
  recentEmoji: string[]
  jumpTarget: JumpTarget | null
  users: User[]
  backend: Backend
  resolveUser: (id: string) => User
  roleColor: (userId: string) => string | undefined
  channelName: (channelId: string) => string
  onToggleMembers: () => void
  onToggleNotificationsMuted: () => void
  onEmojiUsed: (emoji: string) => void
  /** Navigate to a message in any channel (switches channel if needed). */
  onJumpTo: (channelId: string, messageId: string) => void
  /** Open a user's profile popout (stable callback). */
  onOpenProfile: (userId: string, anchor: DOMRect) => void
  /** Unsent text per channel (kept by the workspace across views and restarts). */
  drafts: Drafts
  onDraftChange: (channelId: string, text: string) => void
  /** Why you can't send in this server channel right now (e.g. a timeout). */
  readOnlyReason?: string
  /** The server accepts large files (chunked uploads); null = normal limits only. */
  largeFiles?: LargeFileSupport | null
}

function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    const on = (): void => setFocused(true)
    const off = (): void => setFocused(false)
    window.addEventListener('focus', on)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', off)
    }
  }, [])
  return focused
}

const EMPTY: Message[] = []

function ChatPanel(props: ChatPanelProps): React.JSX.Element {
  const { channel, backend, meId, conversation } = props
  const gifs = useContext(GifContext)
  const label = conversation ? conversation.label : `#${channel.name}`
  const noun = conversation ? 'conversation' : 'channel'
  // What this user may do here (the server enforces it; this only hides controls).
  const perms = channel.permissions ?? ALL_PERMISSIONS
  const can = {
    send: hasPermission(perms, Permissions.sendMessages),
    attach:
      hasPermission(perms, Permissions.sendMessages) &&
      hasPermission(perms, Permissions.attachFiles),
    react: hasPermission(perms, Permissions.addReactions),
    pin:
      hasPermission(perms, Permissions.pinMessages) ||
      hasPermission(perms, Permissions.manageMessages),
    manageMessages: hasPermission(perms, Permissions.manageMessages),
    // Own messages, except while timed out in the server (readOnlyReason explains that).
    edit: !props.readOnlyReason
  }
  const messages = props.state?.messages ?? EMPTY
  const loaded = props.state?.loaded ?? false
  const hasMore = props.state?.hasMore ?? false
  const hasNewer = props.state?.hasNewer ?? false
  const loadingOlder = props.state?.loadingOlder ?? false

  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [picker, setPicker] = useState<{ message: Message; rect: DOMRect } | null>(null)
  const [lightbox, setLightbox] = useState<ApiAttachment | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Message | null>(null)
  // Deletes in flight: one request per message however often it's clicked.
  const deleteGuard = useRef(new DeleteGuard())
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set())
  const [searchOpen, setSearchOpen] = useState(false)
  const [pinsOpen, setPinsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [newBelow, setNewBelow] = useState(0)
  const [nearBottom, setNearBottom] = useState(true)
  // Read position when the channel was opened: where the "New" divider goes.
  const [marker, setMarker] = useState<{
    channelId: string
    lastReadId: string | null
    count: number
  }>({
    channelId: '',
    lastReadId: null,
    count: 0
  })
  const [pendingJump, setPendingJump] = useState<string | null>(null)

  const scrollerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<ComposerHandle>(null)
  const stickRef = useRef(true)
  const metricsRef = useRef({
    channelId: '',
    firstId: undefined as string | undefined,
    lastId: undefined as string | undefined,
    count: 0,
    scrollTop: 0,
    scrollHeight: 0
  })
  const dragDepth = useRef(0)
  const windowFocused = useWindowFocus()

  const latestId = lastConfirmedId(messages)

  // ---- Channel switch: reset per-channel UI and remember where "New" starts ----
  if (marker.channelId !== channel.id && (props.readState || loaded)) {
    setMarker({
      channelId: channel.id,
      lastReadId: props.readState?.lastReadId ?? null,
      count: props.readState?.unreadCount ?? 0
    })
    setReplyTo(null)
    setEditingId(null)
    setNewBelow(0)
    setPinsOpen(false)
  }

  const showToast = useCallback((text: string) => {
    setToast(text)
    setTimeout(() => setToast((t) => (t === text ? null : t)), 4000)
  }, [])

  // ---- Scrolling ----

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickRef.current = true
    setNearBottom(true)
    setNewBelow(0)
  }, [])

  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const prev = metricsRef.current
    const firstId = messages[0]?.id
    const lastId = messages[messages.length - 1]?.id
    const next = { firstId, lastId, count: messages.length }
    const sameChannel = prev.channelId === channel.id
    const change = sameChannel ? listChange(prev, next) : 'replaced'

    if (change === 'prepended') {
      el.scrollTop = anchoredScrollTop(prev, el.scrollHeight)
    } else if (change === 'appended') {
      if (stickRef.current) el.scrollTop = el.scrollHeight
      else {
        const added = messages.filter(
          (m) => Number(m.id) > Number(prev.lastId ?? 0) && m.authorId !== meId
        ).length
        if (added) setNewBelow((n) => n + added)
        // Our own new message always brings us to the bottom.
        if (messages[messages.length - 1]?.authorId === meId) {
          el.scrollTop = el.scrollHeight
          stickRef.current = true
        }
      }
    } else if (change === 'replaced' && !pendingJump) {
      el.scrollTop = el.scrollHeight
      stickRef.current = true
    }
    metricsRef.current = {
      channelId: channel.id,
      ...next,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight
    }
  }, [messages, channel.id, meId, pendingJump])

  // Content that grows after render (images decoding, code blocks) keeps the bottom pinned.
  useEffect(() => {
    const list = listRef.current
    const el = scrollerRef.current
    if (!list || !el) return
    const observer = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight
      metricsRef.current = {
        ...metricsRef.current,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight
      }
    })
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  const onScroll = (): void => {
    const el = scrollerRef.current
    if (!el) return
    const near = isNearBottom(el)
    stickRef.current = near && !hasNewer
    if (near !== nearBottom) setNearBottom(near)
    if (near && newBelow) setNewBelow(0)
    metricsRef.current = {
      ...metricsRef.current,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight
    }
    if (el.scrollTop < EDGE_PX && hasMore && !loadingOlder) void backend.loadOlder(channel.id)
    if (hasNewer && el.scrollHeight - el.scrollTop - el.clientHeight < EDGE_PX) {
      void backend.loadNewer(channel.id)
    }
  }

  // ---- Read acknowledgement: only when actually looking at the newest messages ----
  useEffect(() => {
    if (
      shouldAcknowledge({
        latestId,
        lastReadId: props.readState?.lastReadId,
        windowFocused,
        nearBottom,
        hasNewer
      })
    ) {
      backend.ackRead(channel.id, latestId!)
    }
  }, [
    backend,
    channel.id,
    latestId,
    props.readState?.lastReadId,
    windowFocused,
    nearBottom,
    hasNewer
  ])

  // ---- Jumping to a message ----
  const jump = useCallback(
    (channelId: string, messageId: string) => {
      if (channelId !== channel.id) {
        props.onJumpTo(channelId, messageId)
        return
      }
      setPendingJump(messageId)
      if (!messages.some((m) => m.id === messageId)) {
        void backend.loadAround(channel.id, messageId).then((found) => {
          if (!found) {
            setPendingJump(null)
            showToast('That message no longer exists.')
          }
        })
      }
    },
    // props.onJumpTo is stable (useCallback in Workspace).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend, channel.id, messages, showToast]
  )

  const { jumpTarget } = props
  const handledJump = useRef(0)
  useEffect(() => {
    if (
      jumpTarget &&
      jumpTarget.channelId === channel.id &&
      handledJump.current !== jumpTarget.seq
    ) {
      handledJump.current = jumpTarget.seq
      jump(jumpTarget.channelId, jumpTarget.messageId)
    }
  }, [jumpTarget, channel.id, jump])

  useLayoutEffect(() => {
    if (!pendingJump) return
    const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-message-id="${pendingJump}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    stickRef.current = false
    setFlashId(pendingJump)
    setPendingJump(null)
    const t = setTimeout(() => setFlashId(null), 2000)
    return () => clearTimeout(t)
  }, [pendingJump, messages])

  // ---- Actions (stable object so memoized messages don't re-render) ----
  const { users, selfName, selfUsername } = props
  // Keyed by the names only, so presence updates don't re-render every message.
  const nameKey = users
    .flatMap((u) => [u.username, u.name])
    .filter(Boolean)
    .sort()
    .join('\n')
  const mentionDetector = useMemo(
    () =>
      createMentionDetector(
        { username: selfUsername, displayName: selfName },
        nameKey ? nameKey.split('\n') : []
      ),
    [nameKey, selfName, selfUsername]
  )
  const deleteDialogRef = useDialog<HTMLDivElement>({
    open: confirmDelete !== null,
    onClose: () => setConfirmDelete(null)
  })
  const actions: MessageActions = useMemo(
    () => ({
      reply: (m) => {
        setReplyTo(m)
        setEditingId(null)
      },
      startEdit: (m) => {
        setEditingId(m.id)
        setReplyTo(null)
      },
      cancelEdit: () => setEditingId(null),
      saveEdit: (m, content) => backend.editMessage(m, content),
      requestDelete: (m) => setConfirmDelete(m),
      quickDelete: (m) => void deleteNowRef.current(m),
      react: (m, emoji) => {
        backend.toggleReaction(m, emoji)
        props.onEmojiUsed(emoji)
      },
      openReactionPicker: (m, rect) => setPicker({ message: m, rect }),
      openMenu: (m, x, y) => openMenuRef.current(m, x, y),
      openImage: (a) => setLightbox(a),
      jump: (c, id) => jumpRef.current(c, id),
      retry: (nonce) => backend.retryMessage(channel.id, nonce),
      discard: (nonce) => backend.discardMessage(channel.id, nonce),
      openProfile: (userId, anchor) => props.onOpenProfile(userId, anchor)
    }),
    // props.onEmojiUsed and props.onOpenProfile are stable (useCallback in Workspace).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend, channel.id]
  )
  const jumpRef = useRef(jump)
  useEffect(() => {
    jumpRef.current = jump
  }, [jump])

  const deleteNow = async (m: Message): Promise<void> => {
    setConfirmDelete(null)
    const guard = deleteGuard.current
    if (!guard.begin(m.id)) return
    setDeletingIds((s) => new Set(s).add(m.id))
    try {
      const failure = await backend.deleteMessage(m)
      if (failure) showToast(`Couldn’t delete: ${failure}`)
    } finally {
      guard.end(m.id)
      setDeletingIds((s) => {
        const next = new Set(s)
        next.delete(m.id)
        return next
      })
    }
  }
  const deleteNowRef = useRef(deleteNow)
  useEffect(() => {
    deleteNowRef.current = deleteNow
  })
  // While Shift is held, delete buttons turn red: a click deletes without asking.
  const [shiftHeld, setShiftHeld] = useState(false)
  useEffect(() => {
    const update = (e: KeyboardEvent): void => setShiftHeld(e.shiftKey)
    const release = (): void => setShiftHeld(false)
    window.addEventListener('keydown', update)
    window.addEventListener('keyup', update)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', update)
      window.removeEventListener('keyup', update)
      window.removeEventListener('blur', release)
    }
  }, [])

  const menuItems = (m: Message, x: number, y: number): MenuItem[] => {
    const own = m.authorId === meId
    const items: MenuItem[] = []
    if (can.react) {
      items.push({
        label: 'Add Reaction',
        onSelect: () => setPicker({ message: m, rect: new DOMRect(x, y, 0, 0) })
      })
    }
    if (can.send) items.push({ label: 'Reply', onSelect: () => actions.reply(m) })
    if (own && can.edit) items.push({ label: 'Edit Message', onSelect: () => actions.startEdit(m) })
    if (can.pin) {
      items.push({
        label: m.pinned ? 'Unpin Message' : 'Pin Message',
        onSelect: () =>
          void backend
            .setPinned(m, !m.pinned)
            .then((f) => f && showToast(`Couldn’t update pin: ${f}`))
      })
    }
    if (m.content)
      items.push({
        label: 'Copy Text',
        onSelect: () => void navigator.clipboard.writeText(m.content)
      })
    items.push({
      label: 'Copy Message Link',
      onSelect: () => void navigator.clipboard.writeText(messageLink(m.channelId, m.id))
    })
    if (own || can.manageMessages)
      items.push({
        label: own ? 'Delete Message' : 'Delete Message (moderator)',
        danger: true,
        onSelect: () => setConfirmDelete(m)
      })
    return items
  }
  // Menu items are built when the menu opens (event time), not during render.
  const openMenuRef = useRef<(m: Message, x: number, y: number) => void>(() => undefined)
  useEffect(() => {
    openMenuRef.current = (m, x, y) => setMenu({ x, y, items: menuItems(m, x, y) })
  })

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A modal is open: background shortcuts do nothing.
      if (anyDialogOpen()) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        const target = e.target as HTMLElement | null
        if (
          target?.closest(
            '.settings-overlay, .modal, .lightbox, .context-menu, .emoji-picker-panel'
          )
        )
          return
        // Esc in the chat: leave history / mark as read, like other chat apps.
        if (props.state?.hasNewer) backend.jumpToPresent(channel.id)
        else backend.markRead(channel.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [backend, channel.id, props.state?.hasNewer])

  // ---- Render helpers ----
  const unreadStart =
    marker.channelId === channel.id ? firstUnreadId(messages, marker.lastReadId, meId) : undefined
  const mentionsSelf = (m: Message): boolean => mentionDetector.mentions(m.content)
  const lastOwn = [...messages]
    .reverse()
    .find((m) => m.authorId === meId && !m.pending && !m.failed)

  const isFile = (e: React.DragEvent): boolean =>
    can.attach && Array.from(e.dataTransfer.types).includes('Files')

  return (
    <main
      className={`chat-panel${shiftHeld ? ' shift-held' : ''}`}
      onDragEnter={(e) => {
        if (!isFile(e)) return
        dragDepth.current++
        setDragging(true)
      }}
      onDragOver={(e) => {
        if (isFile(e)) e.preventDefault()
      }}
      onDragLeave={(e) => {
        if (!isFile(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={(e) => {
        if (!isFile(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        composerRef.current?.addFiles(filesFromTransfer(e.dataTransfer))
      }}
    >
      <header className="chat-header">
        <div className="chat-header-title">
          {conversation?.kind === 'dm' ? (
            <AtIcon size={22} className="chat-header-hash" />
          ) : conversation ? (
            <FriendsIcon size={22} className="chat-header-hash" />
          ) : (
            <HashIcon size={22} className="chat-header-hash" />
          )}
          <h2 title={conversation ? conversation.title : channel.name}>
            {conversation ? conversation.title : channel.name}
          </h2>
          {conversation?.partner && (
            <>
              <span className="chat-header-divider" />
              <span className="chat-header-topic">@{conversation.partner.username}</span>
            </>
          )}
          {!conversation && channel.topic && (
            <>
              <span className="chat-header-divider" />
              <span className="chat-header-topic" title={channel.topic}>
                {channel.topic}
              </span>
            </>
          )}
        </div>

        <div className="chat-header-actions">
          <button
            type="button"
            className={`icon-button header-button${props.notificationsMuted ? ' selected' : ''}`}
            onClick={props.onToggleNotificationsMuted}
            aria-pressed={props.notificationsMuted}
            aria-label={
              props.notificationsMuted
                ? `Unmute ${noun} notifications`
                : `Mute ${noun} notifications`
            }
            title={
              props.notificationsMuted
                ? `Notifications muted for this ${noun}`
                : `Mute notifications for this ${noun}`
            }
          >
            <BellIcon size={22} />
          </button>
          <div className="pins-anchor">
            <button
              type="button"
              className={`icon-button header-button${pinsOpen ? ' selected' : ''}`}
              onClick={() => setPinsOpen((o) => !o)}
              aria-expanded={pinsOpen}
              aria-label="Pinned messages"
              title="Pinned messages"
            >
              <PinIcon size={22} />
            </button>
            {pinsOpen && (
              <PinsPanel
                label={label}
                revision={props.pinsRevision}
                load={() => backend.fetchPins(channel.id)}
                resolveUser={props.resolveUser}
                describeError={describeError}
                onJump={(m) => {
                  setPinsOpen(false)
                  jump(m.channelId, m.id)
                }}
                onUnpin={(m) => void backend.setPinned(m, false)}
                onClose={() => setPinsOpen(false)}
              />
            )}
          </div>
          <button
            type="button"
            className={`icon-button header-button${props.showMembers ? ' selected' : ''}`}
            onClick={props.onToggleMembers}
            aria-pressed={props.showMembers}
            aria-label={props.showMembers ? 'Hide Member List' : 'Show Member List'}
            title={props.showMembers ? 'Hide Member List' : 'Show Member List'}
          >
            <MembersIcon size={22} />
          </button>
          <button
            type="button"
            className={`chat-search-button${searchOpen ? ' active' : ''}`}
            onClick={() => setSearchOpen(true)}
            aria-label={`Search ${label} (Ctrl+F)`}
            title="Search (Ctrl+F)"
          >
            <span>Search</span>
            <SearchIcon size={16} />
          </button>
        </div>
      </header>

      {props.banner}

      <div className="chat-body">
        <div className="chat-column">
          {marker.channelId === channel.id &&
          marker.count > 0 &&
          unreadStart &&
          props.readState?.unreadCount ? (
            <div className="unread-bar" role="status">
              <span>
                {marker.count >= 99 ? '99+' : marker.count} new message
                {marker.count === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                className="link-button"
                onClick={() => jump(channel.id, unreadStart)}
              >
                Jump
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => backend.markRead(channel.id)}
              >
                Mark as read
              </button>
            </div>
          ) : null}

          <div className="message-scroller" ref={scrollerRef} onScroll={onScroll}>
            <div className="message-list" ref={listRef}>
              {!loaded && !props.state?.error && (
                <div className="channel-status">Loading messages…</div>
              )}

              {props.state?.error && (
                <div className="channel-status error">
                  <span>Couldn&rsquo;t load messages: {props.state.error}</span>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => backend.reloadChannel(channel.id)}
                  >
                    Try again
                  </button>
                </div>
              )}

              {loaded && hasMore && (
                <div className="load-older">
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => void backend.loadOlder(channel.id)}
                    disabled={loadingOlder}
                  >
                    {loadingOlder ? 'Loading…' : 'Load older messages'}
                  </button>
                </div>
              )}

              {loaded && !hasMore && conversation && (
                <div className="channel-welcome">
                  {conversation.partner ? (
                    <Avatar
                      name={conversation.partner.name}
                      color={conversation.partner.avatarColor}
                      imageId={conversation.partner.avatarId}
                      size={72}
                    />
                  ) : (
                    <div className="channel-welcome-icon">
                      <FriendsIcon size={42} />
                    </div>
                  )}
                  <h3>{conversation.title}</h3>
                  <p>
                    {conversation.kind === 'dm'
                      ? `This is the beginning of your direct message history with ${conversation.title}.`
                      : `This is the beginning of the ${conversation.title} group. You see messages sent since you joined.`}
                  </p>
                  {messages.length === 0 && (
                    <p className="channel-welcome-hint">No messages yet — say hi.</p>
                  )}
                </div>
              )}

              {loaded && !hasMore && !conversation && (
                <div className="channel-welcome">
                  <div className="channel-welcome-icon">
                    <HashIcon size={42} />
                  </div>
                  <h3>Welcome to #{channel.name}!</h3>
                  <p>
                    This is the start of the #{channel.name} channel. {channel.topic}
                  </p>
                  {messages.length === 0 && (
                    <p className="channel-welcome-hint">
                      No messages yet — say hi, or drop a screenshot in.
                    </p>
                  )}
                </div>
              )}

              {messages.map((message, index) => {
                const prev = messages[index - 1]
                const newDay = !prev || !isSameDay(prev.timestamp, message.timestamp)
                const isUnreadStart = message.id === unreadStart
                const grouped =
                  !props.compactMode &&
                  !newDay &&
                  !isUnreadStart &&
                  !!prev &&
                  prev.authorId === message.authorId &&
                  !prev.failed &&
                  message.timestamp - prev.timestamp < GROUP_WINDOW_MS
                const replyAuthorId =
                  message.replyTo && !message.replyTo.deleted ? message.replyTo.authorId : undefined
                return (
                  <Fragment
                    key={message.nonce && message.pending ? `local-${message.nonce}` : message.id}
                  >
                    {newDay && (
                      <div className="day-divider" role="separator">
                        <span>{formatDayDivider(message.timestamp)}</span>
                      </div>
                    )}
                    {isUnreadStart && (
                      <div className="unread-divider" role="separator" aria-label="New messages">
                        <span>New</span>
                      </div>
                    )}
                    <MessageItem
                      message={message}
                      author={props.resolveUser(message.authorId)}
                      replyAuthor={replyAuthorId ? props.resolveUser(replyAuthorId) : undefined}
                      nameColor={props.roleColor(message.authorId)}
                      grouped={grouped}
                      compact={props.compactMode}
                      showTimestamps={props.showTimestamps}
                      isSelf={message.authorId === meId}
                      canDelete={canDeleteMessage({
                        own: message.authorId === meId,
                        manageMessages: can.manageMessages,
                        local: Boolean(message.pending || message.failed)
                      })}
                      canReact={can.react}
                      canReply={can.send}
                      canEdit={message.authorId === meId && can.edit}
                      deleting={deletingIds.has(message.id)}
                      mentioned={mentionsSelf(message)}
                      flash={flashId === message.id}
                      editing={editingId === message.id}
                      mentionNames={mentionDetector.candidates}
                      selfMentionNames={mentionDetector.selfNames}
                      cache={backend.attachments}
                      actions={actions}
                    />
                  </Fragment>
                )
              })}

              {hasNewer && (
                <div className="load-older">
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => void backend.loadNewer(channel.id)}
                  >
                    Load newer messages
                  </button>
                </div>
              )}
            </div>
          </div>

          {(newBelow > 0 || hasNewer || (!nearBottom && loaded && messages.length > 0)) && (
            <button
              type="button"
              className="jump-present"
              onClick={() => (hasNewer ? backend.jumpToPresent(channel.id) : scrollToBottom())}
            >
              {newBelow > 0
                ? `${newBelow} new message${newBelow === 1 ? '' : 's'} ↓`
                : hasNewer
                  ? 'You’re viewing older messages — Jump to present ↓'
                  : 'Jump to present ↓'}
            </button>
          )}

          {toast && (
            <div className="chat-toast" role="alert">
              {toast}
            </div>
          )}

          <Composer
            key={channel.id}
            channel={channel}
            draft={props.drafts[channel.id]?.text ?? ''}
            onDraftChange={(value) => props.onDraftChange(channel.id, value)}
            replyTo={replyTo}
            replyAuthorName={replyTo ? props.resolveUser(replyTo.authorId).name : undefined}
            onCancelReply={() => setReplyTo(null)}
            onSend={({ content, attachments }) => {
              backend.sendMessage(channel.id, { content, attachments, replyTo })
              setReplyTo(null)
              scrollToBottom()
            }}
            largeFiles={props.largeFiles ?? null}
            recentEmoji={props.recentEmoji}
            onEmojiUsed={props.onEmojiUsed}
            onEditLast={() => lastOwn && setEditingId(lastOwn.id)}
            disabled={!can.send}
            disabledReason={conversation?.readOnlyReason ?? props.readOnlyReason}
            canAttach={can.attach}
            targetLabel={label}
            gifApi={gifs ? backend.api : undefined}
            onSendGif={(gif) => {
              if (!gifs) return
              backend.sendMessage(channel.id, {
                content: gifMessageContent(gifs.provider, gif.id),
                attachments: [],
                replyTo
              })
              setReplyTo(null)
              scrollToBottom()
            }}
            ref={composerRef}
          />

          {dragging && (
            <div className="drop-overlay" aria-hidden="true">
              <div>
                <strong>Drop to upload</strong>
                <span>to {label} · up to 5 files</span>
              </div>
            </div>
          )}
        </div>

        {searchOpen && (
          <SearchPanel
            channel={channel}
            serverId={props.serverId}
            label={label}
            initialQuery=""
            users={props.users}
            resolveUser={props.resolveUser}
            channelName={props.channelName}
            search={backend.search}
            describeError={describeError}
            onJump={(m) => jump(m.channelId, m.id)}
            onClose={() => setSearchOpen(false)}
          />
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {picker && (
        <div
          className="reaction-picker-anchor"
          style={{
            top: Math.max(8, Math.min(picker.rect.top - 360, window.innerHeight - 380)),
            left: Math.max(8, Math.min(picker.rect.left - 300, window.innerWidth - 360))
          }}
        >
          <EmojiPicker
            placement="message"
            label="Add reaction"
            recent={props.recentEmoji}
            onPick={(emoji) => {
              actions.react(picker.message, emoji)
              setPicker(null)
            }}
            onClose={() => setPicker(null)}
          />
        </div>
      )}

      {lightbox && (
        <Lightbox
          attachment={lightbox}
          gallery={messages.flatMap((m) =>
            m.pending || m.failed ? [] : (m.attachments ?? []).filter((a) => a.kind === 'image')
          )}
          cache={backend.attachments}
          onNavigate={setLightbox}
          onClose={() => setLightbox(null)}
        />
      )}

      {confirmDelete && (
        <div className="modal-backdrop" onMouseDown={() => setConfirmDelete(null)}>
          <div
            ref={deleteDialogRef}
            className="modal confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 id="delete-title">Delete message</h2>
            <p>
              Are you sure you want to delete this message? Its attachments are deleted too. This
              can&rsquo;t be undone.
            </p>
            <blockquote className="confirm-preview">
              {confirmDelete.content || `${confirmDelete.attachments?.length ?? 0} attachment(s)`}
              <small>{formatTimestamp(confirmDelete.timestamp)}</small>
            </blockquote>
            <div className="modal-footer">
              <button
                type="button"
                className="button secondary"
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button danger"
                autoFocus
                onClick={() => void deleteNow(confirmDelete)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default ChatPanel
