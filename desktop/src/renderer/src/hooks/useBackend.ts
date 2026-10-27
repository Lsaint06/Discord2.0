import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Message, SelectableStatus } from '../types'
import { ApiClient, ApiError, type SearchParams } from '../net/api'
import { GatewayClient, type GatewayStatus } from '../net/gateway'
import {
  LIMITS,
  type ApiAttachment,
  type ApiServer,
  type ApiUser,
  type ApiVoiceToken
} from '../net/protocol'
import {
  applyDelete,
  applyEdit,
  applyPin,
  applyReaction,
  firstConfirmedId,
  isLocal,
  lastConfirmedId,
  mergeMessages,
  reconcileWindow,
  toMessage,
  toggleReactionLocally
} from '../chat/messageState'
import { applyIncoming, applyReadPosition, type ReadState } from '../chat/unread'
import { AttachmentCache } from '../chat/attachmentCache'

export interface ChannelState {
  messages: Message[]
  loaded: boolean
  /** Older history exists on the server. */
  hasMore: boolean
  /** The loaded window doesn't reach the newest message (after jumping to old history). */
  hasNewer: boolean
  loadingOlder: boolean
  loadingNewer: boolean
  error?: string
}

export interface BackendSession {
  token: string
  httpUrl: string
  gatewayUrl: string
}

interface Options {
  initialStatus: SelectableStatus
  onSessionInvalid: () => void
  /** Called for every new message from the gateway (notifications). */
  onIncomingMessage?: (message: Message) => void
}

export interface SendInput {
  content: string
  replyTo?: Message | null
  attachments?: ApiAttachment[]
}

const PAGE = LIMITS.messagesPageDefault
const EMPTY_CHANNEL: ChannelState = {
  messages: [],
  loaded: false,
  hasMore: false,
  hasNewer: false,
  loadingOlder: false,
  loadingNewer: false
}

function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'rate_limited' && err.retryAfterMs) {
      return `Slow down — try again in ${Math.ceil(err.retryAfterMs / 1000)}s.`
    }
    return err.message
  }
  return 'Something went wrong.'
}

export interface Backend {
  phase: 'loading' | 'ready' | 'error'
  loadError?: string
  me: ApiUser | null
  users: Record<string, ApiUser>
  servers: ApiServer[]
  channels: Record<string, ChannelState>
  readStates: Record<string, ReadState>
  /** Channels with unread messages from others. */
  unread: Set<string>
  /** Bumped when a channel's pins change (pinned-messages view refreshes). */
  pinsRevision: Record<string, number>
  /** userId → voice channelId, from the backend (LiveKit webhooks). */
  voiceStates: Record<string, string>
  /** userIds currently screen sharing (LIVE), from the backend. */
  voiceStreaming: Record<string, true>
  gateway: { status: GatewayStatus; retryInMs?: number }
  attachments: AttachmentCache
  focusChannel: (channelId: string) => void
  markRead: (channelId: string) => void
  ackRead: (channelId: string, messageId: string) => void
  loadOlder: (channelId: string) => Promise<void>
  loadNewer: (channelId: string) => Promise<void>
  /** Loads history around a message if needed; resolves false if it no longer exists. */
  loadAround: (channelId: string, messageId: string) => Promise<boolean>
  jumpToPresent: (channelId: string) => void
  reloadChannel: (channelId: string) => void
  sendMessage: (channelId: string, input: SendInput) => void
  retryMessage: (channelId: string, nonce: string) => void
  discardMessage: (channelId: string, nonce: string) => void
  editMessage: (message: Message, content: string) => Promise<string | null>
  deleteMessage: (message: Message) => Promise<string | null>
  toggleReaction: (message: Message, emoji: string) => void
  setPinned: (message: Message, pinned: boolean) => Promise<string | null>
  fetchPins: (channelId: string) => Promise<Message[]>
  search: (params: SearchParams) => Promise<{ messages: Message[]; nextBefore: string | null }>
  uploadAttachment: (
    channelId: string,
    file: Blob,
    filename: string,
    onProgress: (fraction: number) => void,
    signal: AbortSignal
  ) => Promise<ApiAttachment>
  deleteAttachment: (attachmentId: string) => void
  createServer: (name: string, color: string) => Promise<{ server?: ApiServer; error?: string }>
  updateDisplayName: (displayName: string) => Promise<string | null>
  setPresence: (status: SelectableStatus) => void
  fetchVoiceToken: (channelId: string) => Promise<ApiVoiceToken>
  retryInitialLoad: () => void
}

export function useBackend(session: BackendSession, options: Options): Backend {
  const { initialStatus, onSessionInvalid, onIncomingMessage } = options

  const [api] = useState(() => new ApiClient(session.httpUrl, session.token))
  const [attachments] = useState(() => new AttachmentCache((id) => api.fetchAttachment(id)))
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string>()
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [me, setMe] = useState<ApiUser | null>(null)
  const [users, setUsers] = useState<Record<string, ApiUser>>({})
  const [servers, setServers] = useState<ApiServer[]>([])
  const [channels, setChannels] = useState<Record<string, ChannelState>>({})
  const [readStates, setReadStates] = useState<Record<string, ReadState>>({})
  const [pinsRevision, setPinsRevision] = useState<Record<string, number>>({})
  const [voiceStates, setVoiceStates] = useState<Record<string, string>>({})
  const [voiceStreaming, setVoiceStreaming] = useState<Record<string, true>>({})
  const [gateway, setGateway] = useState<{ status: GatewayStatus; retryInMs?: number }>({
    status: 'connecting'
  })

  const gatewayRef = useRef<GatewayClient | null>(null)
  const channelsRef = useRef(channels)
  const readStatesRef = useRef(readStates)
  const meIdRef = useRef<string | undefined>(undefined)
  const inflightRef = useRef(new Set<string>())
  // Realtime events that arrive while a channel's first page is loading: new messages are kept
  // and merged in afterwards; any other change marks the page stale so it's re-fetched once.
  const loadBufferRef = useRef(new Map<string, { messages: Message[]; stale: boolean }>())
  const onSessionInvalidRef = useRef(onSessionInvalid)
  const onIncomingRef = useRef(onIncomingMessage)
  const ackTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    channelsRef.current = channels
  }, [channels])
  useEffect(() => {
    readStatesRef.current = readStates
  }, [readStates])
  useEffect(() => {
    meIdRef.current = me?.id
  }, [me])
  useEffect(() => {
    onSessionInvalidRef.current = onSessionInvalid
    onIncomingRef.current = onIncomingMessage
  }, [onSessionInvalid, onIncomingMessage])
  useEffect(() => () => attachments.clear(), [attachments])

  const handleAuthError = useCallback((err: unknown): boolean => {
    if (err instanceof ApiError && err.isUnauthorized) {
      onSessionInvalidRef.current()
      return true
    }
    return false
  }, [])

  /** Applies a pure update to one channel's messages (no-op if the channel isn't loaded). */
  const updateMessages = useCallback(
    (channelId: string, fn: (messages: Message[]) => Message[]) => {
      setChannels((prev) => {
        const ch = prev[channelId]
        if (!ch?.loaded) return prev
        const messages = fn(ch.messages)
        return messages === ch.messages ? prev : { ...prev, [channelId]: { ...ch, messages } }
      })
    },
    []
  )

  const applyMessages = useCallback(
    (channelId: string, incoming: Message[]) =>
      updateMessages(channelId, (messages) => mergeMessages(messages, incoming)),
    [updateMessages]
  )

  const loadReadStates = useCallback(async () => {
    try {
      const list = await api.readStates()
      setReadStates(
        Object.fromEntries(
          list.map((r) => [
            r.channelId,
            { lastReadId: r.lastReadId, unreadCount: r.unreadCount, lastMessageId: r.lastMessageId }
          ])
        )
      )
    } catch (err) {
      handleAuthError(err)
    }
  }, [api, handleAuthError])

  // Initial load (REST) and the realtime gateway.
  useEffect(() => {
    let cancelled = false
    const markLoadStale = (channelId: string): void => {
      const buffer = loadBufferRef.current.get(channelId)
      if (buffer) buffer.stale = true
    }

    Promise.all([api.me(), api.servers(), api.users()])
      .then(([meUser, serverList, userList]) => {
        if (cancelled) return
        setMe(meUser)
        setServers(serverList)
        setUsers(Object.fromEntries(userList.map((u) => [u.id, u])))
        setPhase('ready')
        void loadReadStates()
      })
      .catch((err: unknown) => {
        if (cancelled || handleAuthError(err)) return
        setLoadError(describeError(err))
        setPhase('error')
      })

    // After a reconnect, re-fetch what may have changed while we were offline: new messages,
    // and edits / deletions / reactions within the latest page of each open channel.
    const resync = async (): Promise<void> => {
      try {
        const serverList = await api.servers()
        if (cancelled) return
        setServers(serverList)
        void loadReadStates()
        for (const [channelId, ch] of Object.entries(channelsRef.current)) {
          if (!ch.loaded || ch.hasNewer) continue
          const latest = (await api.messages(channelId, { limit: PAGE })).map(toMessage)
          if (cancelled) return
          const known = lastConfirmedId(ch.messages)
          const gap =
            latest.length === PAGE && known !== undefined && Number(latest[0].id) > Number(known)
          setChannels((prev) => {
            const cur = prev[channelId]
            if (!cur) return prev
            return {
              ...prev,
              [channelId]: gap
                ? {
                    ...cur,
                    hasMore: true,
                    messages: mergeMessages(cur.messages.filter(isLocal), latest)
                  }
                : { ...cur, messages: reconcileWindow(cur.messages, latest) }
            }
          })
        }
      } catch (err) {
        handleAuthError(err)
      }
    }

    const client = new GatewayClient(session.gatewayUrl, session.token, {
      onStatus: (status, retryInMs) => {
        setGateway({ status, retryInMs })
        if (status === 'auth_failed') onSessionInvalidRef.current()
      },
      onReady: (data, isReconnect) => {
        setMe(data.user)
        setUsers(Object.fromEntries(data.users.map((u) => [u.id, u])))
        setVoiceStates(Object.fromEntries(data.voiceStates.map((v) => [v.userId, v.channelId])))
        setVoiceStreaming(
          Object.fromEntries(
            data.voiceStates.filter((v) => v.streaming).map((v) => [v.userId, true as const])
          )
        )
        if (isReconnect) void resync()
      },
      onVoiceStateUpdate: ({ userId, channelId, streaming }) => {
        setVoiceStates((prev) => {
          if (prev[userId] === (channelId ?? undefined)) return prev
          const next = { ...prev }
          if (channelId) next[userId] = channelId
          else delete next[userId]
          return next
        })
        const live = Boolean(channelId && streaming)
        setVoiceStreaming((prev) => {
          if (Boolean(prev[userId]) === live) return prev
          const next = { ...prev }
          if (live) next[userId] = true
          else delete next[userId]
          return next
        })
      },
      onMessage: (m) => {
        const message = toMessage(m)
        loadBufferRef.current.get(m.channelId)?.messages.push(message)
        // When the user is reading old history, don't splice the live message into that window.
        if (!channelsRef.current[m.channelId]?.hasNewer) applyMessages(m.channelId, [message])
        setReadStates((prev) => ({
          ...prev,
          [m.channelId]: applyIncoming(prev[m.channelId], m, meIdRef.current)
        }))
        onIncomingRef.current?.(message)
      },
      onMessageUpdate: (edit) => {
        markLoadStale(edit.channelId)
        updateMessages(edit.channelId, (ms) => applyEdit(ms, edit))
      },
      onMessageDelete: ({ id, channelId }) => {
        markLoadStale(channelId)
        const removed = channelsRef.current[channelId]?.messages.find((m) => m.id === id)
        for (const a of removed?.attachments ?? []) attachments.forget(a.id)
        updateMessages(channelId, (ms) => applyDelete(ms, id))
      },
      onReactionUpdate: (event) => {
        markLoadStale(event.channelId)
        updateMessages(event.channelId, (ms) => applyReaction(ms, event, meIdRef.current))
      },
      onPinUpdate: ({ channelId, messageId, pinned }) => {
        markLoadStale(channelId)
        updateMessages(channelId, (ms) => applyPin(ms, messageId, pinned))
        setPinsRevision((prev) => ({ ...prev, [channelId]: (prev[channelId] ?? 0) + 1 }))
      },
      onReadStateUpdate: ({ channelId, lastReadId }) => {
        setReadStates((prev) => ({
          ...prev,
          [channelId]: applyReadPosition(prev[channelId], lastReadId, {
            messages: channelsRef.current[channelId]?.messages ?? [],
            meId: meIdRef.current
          })
        }))
      },
      onUserUpdate: (u) => {
        setUsers((prev) => ({ ...prev, [u.id]: u }))
        if (u.id === meIdRef.current) setMe(u)
      },
      onServerCreate: (s) => {
        setServers((prev) => (prev.some((x) => x.id === s.id) ? prev : [...prev, s]))
      }
    })
    client.setStatus(initialStatus)
    client.connect()
    gatewayRef.current = client

    return () => {
      cancelled = true
      client.disconnect()
      gatewayRef.current = null
    }
    // initialStatus is only needed once per connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    api,
    session.gatewayUrl,
    session.token,
    loadAttempt,
    applyMessages,
    updateMessages,
    loadReadStates,
    handleAuthError,
    attachments
  ])

  const ensureLoaded = useCallback(
    async (channelId: string) => {
      if (channelsRef.current[channelId]?.loaded || inflightRef.current.has(channelId)) return
      inflightRef.current.add(channelId)
      const buffer = { messages: [] as Message[], stale: false }
      loadBufferRef.current.set(channelId, buffer)
      try {
        const page = await api.messages(channelId, { limit: PAGE })
        loadBufferRef.current.delete(channelId)
        setChannels((prev) => ({
          ...prev,
          [channelId]: {
            ...EMPTY_CHANNEL,
            loaded: true,
            hasMore: page.length === PAGE,
            messages: mergeMessages(
              mergeMessages(prev[channelId]?.messages ?? [], page.map(toMessage)),
              buffer.messages
            )
          }
        }))
        if (buffer.stale) {
          // An edit/delete/reaction/pin raced the page; fetch once more to pick it up.
          const latest = (await api.messages(channelId, { limit: PAGE })).map(toMessage)
          setChannels((prev) => {
            const cur = prev[channelId]
            return cur
              ? {
                  ...prev,
                  [channelId]: { ...cur, messages: reconcileWindow(cur.messages, latest) }
                }
              : prev
          })
        }
      } catch (err) {
        loadBufferRef.current.delete(channelId)
        if (handleAuthError(err)) return
        setChannels((prev) => ({
          ...prev,
          [channelId]: { ...EMPTY_CHANNEL, error: describeError(err) }
        }))
      } finally {
        inflightRef.current.delete(channelId)
      }
    },
    [api, handleAuthError]
  )

  /** Loads a channel's history once (the active channel). */
  const focusChannel = useCallback(
    (channelId: string) => {
      void ensureLoaded(channelId)
    },
    [ensureLoaded]
  )

  const reloadChannel = useCallback(
    (channelId: string) => {
      setChannels((prev) => {
        const next = { ...prev }
        delete next[channelId]
        return next
      })
      channelsRef.current = { ...channelsRef.current, [channelId]: EMPTY_CHANNEL }
      void ensureLoaded(channelId)
    },
    [ensureLoaded]
  )

  const loadOlder = useCallback(
    async (channelId: string) => {
      const ch = channelsRef.current[channelId]
      if (!ch?.loaded || ch.loadingOlder || !ch.hasMore) return
      const oldest = firstConfirmedId(ch.messages)
      if (!oldest) return
      setChannels((prev) => ({ ...prev, [channelId]: { ...prev[channelId], loadingOlder: true } }))
      try {
        const page = await api.messages(channelId, { before: oldest, limit: PAGE })
        setChannels((prev) => {
          const cur = prev[channelId]
          return {
            ...prev,
            [channelId]: {
              ...cur,
              loadingOlder: false,
              hasMore: page.length === PAGE,
              messages: mergeMessages(cur.messages, page.map(toMessage))
            }
          }
        })
      } catch (err) {
        if (handleAuthError(err)) return
        setChannels((prev) => ({
          ...prev,
          [channelId]: { ...prev[channelId], loadingOlder: false }
        }))
      }
    },
    [api, handleAuthError]
  )

  const loadNewer = useCallback(
    async (channelId: string) => {
      const ch = channelsRef.current[channelId]
      if (!ch?.loaded || ch.loadingNewer || !ch.hasNewer) return
      const newest = lastConfirmedId(ch.messages)
      if (!newest) return
      setChannels((prev) => ({ ...prev, [channelId]: { ...prev[channelId], loadingNewer: true } }))
      try {
        const page = await api.messages(channelId, { after: newest, limit: PAGE })
        setChannels((prev) => {
          const cur = prev[channelId]
          return {
            ...prev,
            [channelId]: {
              ...cur,
              loadingNewer: false,
              hasNewer: page.length === PAGE,
              messages: mergeMessages(cur.messages, page.map(toMessage))
            }
          }
        })
      } catch (err) {
        if (handleAuthError(err)) return
        setChannels((prev) => ({
          ...prev,
          [channelId]: { ...prev[channelId], loadingNewer: false }
        }))
      }
    },
    [api, handleAuthError]
  )

  const loadAround = useCallback(
    async (channelId: string, messageId: string): Promise<boolean> => {
      if (channelsRef.current[channelId]?.messages.some((m) => m.id === messageId)) return true
      try {
        const page = (await api.messages(channelId, { around: messageId, limit: PAGE })).map(
          toMessage
        )
        if (!page.some((m) => m.id === messageId)) return false
        const newest = readStatesRef.current[channelId]?.lastMessageId
        const reachesPresent =
          page.length < PAGE || (newest != null && page[page.length - 1].id === newest)
        setChannels((prev) => ({
          ...prev,
          [channelId]: {
            ...EMPTY_CHANNEL,
            loaded: true,
            hasMore: true,
            hasNewer: !reachesPresent,
            messages: page
          }
        }))
        return true
      } catch (err) {
        handleAuthError(err)
        return false
      }
    },
    [api, handleAuthError]
  )

  const jumpToPresent = useCallback(
    (channelId: string) => {
      if (channelsRef.current[channelId]?.hasNewer) reloadChannel(channelId)
    },
    [reloadChannel]
  )

  // ---- Read state ----

  const ackRead = useCallback(
    (channelId: string, messageId: string) => {
      const state = readStatesRef.current[channelId]
      if (state?.lastReadId && Number(state.lastReadId) >= Number(messageId)) return
      setReadStates((prev) => ({
        ...prev,
        [channelId]: applyReadPosition(prev[channelId], messageId, {
          messages: channelsRef.current[channelId]?.messages ?? [],
          meId: meIdRef.current
        })
      }))
      // Coalesce rapid acks into one request per channel.
      const timers = ackTimers.current
      const existing = timers.get(channelId)
      if (existing) clearTimeout(existing)
      timers.set(
        channelId,
        setTimeout(() => {
          timers.delete(channelId)
          const latest = readStatesRef.current[channelId]?.lastReadId ?? messageId
          api.markRead(channelId, latest).catch((err: unknown) => handleAuthError(err))
        }, 400)
      )
    },
    [api, handleAuthError]
  )

  const markRead = useCallback(
    (channelId: string) => {
      const latest = readStatesRef.current[channelId]?.lastMessageId
      if (latest) ackRead(channelId, latest)
    },
    [ackRead]
  )

  useEffect(() => {
    const timers = ackTimers.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  // ---- Sending ----

  const markFailed = useCallback((channelId: string, nonce: string, failed: string) => {
    setChannels((prev) => {
      const ch = prev[channelId]
      if (!ch) return prev
      return {
        ...prev,
        [channelId]: {
          ...ch,
          messages: ch.messages.map((m) =>
            m.nonce === nonce && isLocal(m) ? { ...m, pending: false, failed } : m
          )
        }
      }
    })
  }, [])

  const deliver = useCallback(
    async (channelId: string, message: Message) => {
      try {
        const saved = await api.sendMessage(channelId, {
          content: message.content,
          nonce: message.nonce!,
          replyToId: message.replyTo?.id,
          attachmentIds: message.attachments?.map((a) => a.id)
        })
        applyMessages(channelId, [toMessage(saved)])
      } catch (err) {
        if (handleAuthError(err)) return
        markFailed(channelId, message.nonce!, describeError(err))
      }
    },
    [api, applyMessages, handleAuthError, markFailed]
  )

  const sendMessage = useCallback(
    (channelId: string, input: SendInput) => {
      const authorId = meIdRef.current
      if (!authorId) return
      const nonce = makeNonce()
      const parent = input.replyTo
      const local: Message = {
        id: `local-${nonce}`,
        channelId,
        authorId,
        content: input.content,
        timestamp: Date.now(),
        nonce,
        pending: true,
        replyTo: parent
          ? {
              id: parent.id,
              deleted: false,
              authorId: parent.authorId,
              content: parent.content.slice(0, LIMITS.replyPreviewLength),
              attachmentCount: parent.attachments?.length ?? 0
            }
          : null,
        attachments: input.attachments ?? [],
        reactions: []
      }
      // Sending always shows the present.
      if (channelsRef.current[channelId]?.hasNewer) reloadChannel(channelId)
      setChannels((prev) => {
        const ch = prev[channelId] ?? { ...EMPTY_CHANNEL, loaded: true }
        return { ...prev, [channelId]: { ...ch, messages: [...ch.messages, local] } }
      })
      void deliver(channelId, local)
    },
    [deliver, reloadChannel]
  )

  const retryMessage = useCallback(
    (channelId: string, nonce: string) => {
      const msg = channelsRef.current[channelId]?.messages.find(
        (m) => m.nonce === nonce && m.failed
      )
      if (!msg) return
      setChannels((prev) => {
        const ch = prev[channelId]
        return {
          ...prev,
          [channelId]: {
            ...ch,
            messages: ch.messages.map((m) =>
              m.nonce === nonce && m.failed ? { ...m, failed: undefined, pending: true } : m
            )
          }
        }
      })
      void deliver(channelId, { ...msg, failed: undefined })
    },
    [deliver]
  )

  const discardMessage = useCallback(
    (channelId: string, nonce: string) => {
      const msg = channelsRef.current[channelId]?.messages.find(
        (m) => m.nonce === nonce && m.failed
      )
      // Uploaded-but-unsent files would otherwise wait for the server's cleanup job.
      for (const a of msg?.attachments ?? []) api.deleteAttachment(a.id).catch(() => undefined)
      setChannels((prev) => {
        const ch = prev[channelId]
        if (!ch) return prev
        return {
          ...prev,
          [channelId]: {
            ...ch,
            messages: ch.messages.filter((m) => !(m.nonce === nonce && m.failed))
          }
        }
      })
    },
    [api]
  )

  // ---- Edit / delete / react / pin ----

  const editMessage = useCallback(
    async (message: Message, content: string): Promise<string | null> => {
      try {
        const saved = await api.editMessage(
          message.channelId,
          message.id,
          content,
          message.editedAt ?? null
        )
        updateMessages(message.channelId, (ms) =>
          applyEdit(ms, {
            id: saved.id,
            content: saved.content,
            editedAt: saved.editedAt ?? Date.now()
          })
        )
        return null
      } catch (err) {
        if (handleAuthError(err)) return 'Signed out'
        return describeError(err)
      }
    },
    [api, handleAuthError, updateMessages]
  )

  const deleteMessage = useCallback(
    async (message: Message): Promise<string | null> => {
      try {
        await api.deleteMessage(message.channelId, message.id)
        for (const a of message.attachments ?? []) attachments.forget(a.id)
        updateMessages(message.channelId, (ms) => applyDelete(ms, message.id))
        return null
      } catch (err) {
        if (handleAuthError(err)) return 'Signed out'
        return describeError(err)
      }
    },
    [api, attachments, handleAuthError, updateMessages]
  )

  const toggleReaction = useCallback(
    (message: Message, emoji: string) => {
      const meId = meIdRef.current
      if (!meId) return
      const current = channelsRef.current[message.channelId]?.messages
        .find((m) => m.id === message.id)
        ?.reactions?.find((r) => r.emoji === emoji)
      const add = !current?.me
      // Optimistic; the server's reaction_update (an absolute count) corrects any drift.
      updateMessages(message.channelId, (ms) =>
        toggleReactionLocally(ms, message.id, emoji, add, meId)
      )
      api.setReaction(message.channelId, message.id, emoji, add).catch((err: unknown) => {
        if (handleAuthError(err)) return
        updateMessages(message.channelId, (ms) =>
          toggleReactionLocally(ms, message.id, emoji, !add, meId)
        )
      })
    },
    [api, handleAuthError, updateMessages]
  )

  const setPinned = useCallback(
    async (message: Message, pinned: boolean): Promise<string | null> => {
      try {
        await api.setPinned(message.channelId, message.id, pinned)
        updateMessages(message.channelId, (ms) => applyPin(ms, message.id, pinned))
        return null
      } catch (err) {
        if (handleAuthError(err)) return 'Signed out'
        return describeError(err)
      }
    },
    [api, handleAuthError, updateMessages]
  )

  const fetchPins = useCallback(
    async (channelId: string) => (await api.pins(channelId)).map(toMessage),
    [api]
  )

  const search = useCallback(
    async (params: SearchParams) => {
      const result = await api.search(params)
      return { messages: result.messages.map(toMessage), nextBefore: result.nextBefore }
    },
    [api]
  )

  const uploadAttachment = useCallback(
    (
      channelId: string,
      file: Blob,
      filename: string,
      onProgress: (fraction: number) => void,
      signal: AbortSignal
    ) => api.uploadAttachment(channelId, file, filename, { onProgress, signal }),
    [api]
  )

  const deleteAttachment = useCallback(
    (attachmentId: string) => {
      api.deleteAttachment(attachmentId).catch(() => undefined)
    },
    [api]
  )

  // ---- Profile, servers, presence, voice ----

  const createServer = useCallback(
    async (name: string, color: string): Promise<{ server?: ApiServer; error?: string }> => {
      try {
        const server = await api.createServer(name, color)
        setServers((prev) => (prev.some((x) => x.id === server.id) ? prev : [...prev, server]))
        return { server }
      } catch (err) {
        if (handleAuthError(err)) return { error: 'Signed out' }
        return { error: describeError(err) }
      }
    },
    [api, handleAuthError]
  )

  const updateDisplayName = useCallback(
    async (displayName: string): Promise<string | null> => {
      try {
        const updated = await api.updateMe({ displayName })
        setMe(updated)
        setUsers((prev) => ({ ...prev, [updated.id]: updated }))
        return null
      } catch (err) {
        if (handleAuthError(err)) return 'Signed out'
        return describeError(err)
      }
    },
    [api, handleAuthError]
  )

  const setPresence = useCallback((status: SelectableStatus) => {
    gatewayRef.current?.setStatus(status)
  }, [])

  const fetchVoiceToken = useCallback(
    async (channelId: string): Promise<ApiVoiceToken> => {
      try {
        return await api.voiceToken(channelId)
      } catch (err) {
        handleAuthError(err)
        throw err
      }
    },
    [api, handleAuthError]
  )

  const retryInitialLoad = useCallback(() => {
    setPhase('loading')
    setLoadError(undefined)
    setLoadAttempt((n) => n + 1)
  }, [])

  const unread = useMemo(
    () =>
      new Set(
        Object.entries(readStates)
          .filter(([, r]) => r.unreadCount > 0)
          .map(([id]) => id)
      ),
    [readStates]
  )

  return {
    phase,
    loadError,
    me,
    users,
    servers,
    channels,
    readStates,
    unread,
    pinsRevision,
    voiceStates,
    voiceStreaming,
    gateway,
    attachments,
    focusChannel,
    markRead,
    ackRead,
    loadOlder,
    loadNewer,
    loadAround,
    jumpToPresent,
    reloadChannel,
    sendMessage,
    retryMessage,
    discardMessage,
    editMessage,
    deleteMessage,
    toggleReaction,
    setPinned,
    fetchPins,
    search,
    uploadAttachment,
    deleteAttachment,
    createServer,
    updateDisplayName,
    setPresence,
    fetchVoiceToken,
    retryInitialLoad
  }
}
