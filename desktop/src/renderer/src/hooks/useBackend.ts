import { useCallback, useEffect, useRef, useState } from 'react'
import type { Message, SelectableStatus } from '../types'
import { ApiClient, ApiError } from '../net/api'
import { GatewayClient, type GatewayStatus } from '../net/gateway'
import {
  LIMITS,
  type ApiMessage,
  type ApiServer,
  type ApiUser,
  type ApiVoiceToken
} from '../net/protocol'

export interface ChannelState {
  messages: Message[]
  loaded: boolean
  hasMore: boolean
  loadingOlder: boolean
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
}

const PAGE = LIMITS.messagesPageDefault
const EMPTY_CHANNEL: ChannelState = {
  messages: [],
  loaded: false,
  hasMore: false,
  loadingOlder: false
}

function toMessage(m: ApiMessage): Message {
  return {
    id: m.id,
    channelId: m.channelId,
    authorId: m.authorId,
    content: m.content,
    timestamp: m.createdAt,
    nonce: m.nonce
  }
}

const isLocal = (m: Message): boolean => Boolean(m.pending || m.failed)

/** Merge server messages into a list, replacing optimistic copies by nonce and skipping duplicates. */
function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const ids = new Set(existing.map((m) => m.id))
  const result = [...existing]
  for (const m of incoming) {
    if (ids.has(m.id)) continue
    const localIndex = m.nonce ? result.findIndex((x) => isLocal(x) && x.nonce === m.nonce) : -1
    if (localIndex >= 0) result[localIndex] = m
    else result.push(m)
    ids.add(m.id)
  }
  const confirmed = result.filter((m) => !isLocal(m)).sort((a, b) => Number(a.id) - Number(b.id))
  return [...confirmed, ...result.filter(isLocal)]
}

function lastConfirmedId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isLocal(messages[i])) return messages[i].id
  }
  return undefined
}

function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function describeError(err: unknown): string {
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
  unread: Set<string>
  /** userId → voice channelId, from the backend (LiveKit webhooks). */
  voiceStates: Record<string, string>
  gateway: { status: GatewayStatus; retryInMs?: number }
  focusChannel: (channelId: string) => void
  markRead: (channelId: string) => void
  loadOlder: (channelId: string) => Promise<void>
  reloadChannel: (channelId: string) => void
  sendMessage: (channelId: string, content: string) => void
  retryMessage: (channelId: string, nonce: string) => void
  discardMessage: (channelId: string, nonce: string) => void
  createServer: (name: string, color: string) => Promise<{ server?: ApiServer; error?: string }>
  updateDisplayName: (displayName: string) => Promise<string | null>
  setPresence: (status: SelectableStatus) => void
  fetchVoiceToken: (channelId: string) => Promise<ApiVoiceToken>
  retryInitialLoad: () => void
}

export function useBackend(session: BackendSession, options: Options): Backend {
  const { initialStatus, onSessionInvalid } = options

  const [api] = useState(() => new ApiClient(session.httpUrl, session.token))
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string>()
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [me, setMe] = useState<ApiUser | null>(null)
  const [users, setUsers] = useState<Record<string, ApiUser>>({})
  const [servers, setServers] = useState<ApiServer[]>([])
  const [channels, setChannels] = useState<Record<string, ChannelState>>({})
  const [unread, setUnread] = useState<Set<string>>(() => new Set())
  const [voiceStates, setVoiceStates] = useState<Record<string, string>>({})
  const [gateway, setGateway] = useState<{ status: GatewayStatus; retryInMs?: number }>({
    status: 'connecting'
  })

  const gatewayRef = useRef<GatewayClient | null>(null)
  const channelsRef = useRef(channels)
  const activeChannelRef = useRef<string | undefined>(undefined)
  const meIdRef = useRef<string | undefined>(undefined)
  const inflightRef = useRef(new Set<string>())
  const onSessionInvalidRef = useRef(onSessionInvalid)

  useEffect(() => {
    channelsRef.current = channels
  }, [channels])
  useEffect(() => {
    meIdRef.current = me?.id
  }, [me])
  useEffect(() => {
    onSessionInvalidRef.current = onSessionInvalid
  }, [onSessionInvalid])

  const handleAuthError = useCallback((err: unknown): boolean => {
    if (err instanceof ApiError && err.isUnauthorized) {
      onSessionInvalidRef.current()
      return true
    }
    return false
  }, [])

  const markUnread = useCallback((channelId: string) => {
    setUnread((prev) => (prev.has(channelId) ? prev : new Set(prev).add(channelId)))
  }, [])

  const markRead = useCallback((channelId: string) => {
    setUnread((prev) => {
      if (!prev.has(channelId)) return prev
      const next = new Set(prev)
      next.delete(channelId)
      return next
    })
  }, [])

  const applyMessages = useCallback((channelId: string, incoming: Message[]) => {
    setChannels((prev) => {
      const ch = prev[channelId]
      if (!ch?.loaded) return prev
      return { ...prev, [channelId]: { ...ch, messages: mergeMessages(ch.messages, incoming) } }
    })
  }, [])

  // Initial load (REST) and the realtime gateway.
  useEffect(() => {
    let cancelled = false

    Promise.all([api.me(), api.servers(), api.users()])
      .then(([meUser, serverList, userList]) => {
        if (cancelled) return
        setMe(meUser)
        setServers(serverList)
        setUsers(Object.fromEntries(userList.map((u) => [u.id, u])))
        setPhase('ready')
      })
      .catch((err: unknown) => {
        if (cancelled || handleAuthError(err)) return
        setLoadError(describeError(err))
        setPhase('error')
      })

    // After a reconnect, re-fetch anything that may have happened while we were offline.
    const resync = async (): Promise<void> => {
      try {
        const serverList = await api.servers()
        if (cancelled) return
        setServers(serverList)
        for (const [channelId, ch] of Object.entries(channelsRef.current)) {
          if (!ch.loaded) continue
          const after = lastConfirmedId(ch.messages)
          const fresh = await api.messages(
            channelId,
            after ? { after, limit: LIMITS.messagesPageMax } : { limit: PAGE }
          )
          if (cancelled) return
          if (fresh.length === LIMITS.messagesPageMax) {
            // Too far behind to stitch together: reload the latest page.
            const latest = await api.messages(channelId, { limit: PAGE })
            setChannels((prev) => ({
              ...prev,
              [channelId]: {
                ...EMPTY_CHANNEL,
                loaded: true,
                hasMore: true,
                messages: mergeMessages(
                  (prev[channelId]?.messages ?? []).filter(isLocal),
                  latest.map(toMessage)
                )
              }
            }))
          } else if (fresh.length > 0) {
            applyMessages(channelId, fresh.map(toMessage))
          }
          if (
            channelId !== activeChannelRef.current &&
            fresh.some((m) => m.authorId !== meIdRef.current)
          ) {
            markUnread(channelId)
          }
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
        if (isReconnect) void resync()
      },
      onVoiceStateUpdate: ({ userId, channelId }) => {
        setVoiceStates((prev) => {
          if (prev[userId] === (channelId ?? undefined)) return prev
          const next = { ...prev }
          if (channelId) next[userId] = channelId
          else delete next[userId]
          return next
        })
      },
      onMessage: (m) => {
        applyMessages(m.channelId, [toMessage(m)])
        if (m.channelId !== activeChannelRef.current && m.authorId !== meIdRef.current) {
          markUnread(m.channelId)
        }
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
    markUnread,
    handleAuthError
  ])

  const ensureLoaded = useCallback(
    async (channelId: string) => {
      if (channelsRef.current[channelId]?.loaded || inflightRef.current.has(channelId)) return
      inflightRef.current.add(channelId)
      try {
        const page = await api.messages(channelId, { limit: PAGE })
        setChannels((prev) => ({
          ...prev,
          [channelId]: {
            ...EMPTY_CHANNEL,
            loaded: true,
            hasMore: page.length === PAGE,
            messages: mergeMessages(prev[channelId]?.messages ?? [], page.map(toMessage))
          }
        }))
      } catch (err) {
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

  /** Marks a channel as the one on screen (suppresses unread) and loads its history once. */
  const focusChannel = useCallback(
    (channelId: string) => {
      activeChannelRef.current = channelId
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
      const oldest = ch.messages.find((m) => !isLocal(m))?.id
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

  const deliver = useCallback(
    async (channelId: string, content: string, nonce: string) => {
      try {
        const saved = await api.sendMessage(channelId, content, nonce)
        applyMessages(channelId, [toMessage(saved)])
      } catch (err) {
        if (handleAuthError(err)) return
        const failed = describeError(err)
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
      }
    },
    [api, applyMessages, handleAuthError]
  )

  const sendMessage = useCallback(
    (channelId: string, content: string) => {
      const authorId = meIdRef.current
      if (!authorId) return
      const nonce = makeNonce()
      const local: Message = {
        id: `local-${nonce}`,
        channelId,
        authorId,
        content,
        timestamp: Date.now(),
        nonce,
        pending: true
      }
      setChannels((prev) => {
        const ch = prev[channelId] ?? { ...EMPTY_CHANNEL, loaded: true }
        return { ...prev, [channelId]: { ...ch, messages: [...ch.messages, local] } }
      })
      void deliver(channelId, content, nonce)
    },
    [deliver]
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
      void deliver(channelId, msg.content, nonce)
    },
    [deliver]
  )

  const discardMessage = useCallback((channelId: string, nonce: string) => {
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
  }, [])

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

  return {
    phase,
    loadError,
    me,
    users,
    servers,
    channels,
    unread,
    voiceStates,
    gateway,
    focusChannel,
    markRead,
    loadOlder,
    reloadChannel,
    sendMessage,
    retryMessage,
    discardMessage,
    createServer,
    updateDisplayName,
    setPresence,
    fetchVoiceToken,
    retryInitialLoad
  }
}
