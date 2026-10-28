import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Channel,
  ChannelCategory,
  Message,
  SelectableStatus,
  Server,
  User,
  UserSettings
} from './types'
import { presenceFromSetting } from './lib/format'
import {
  clearLegacyAppearance,
  loadSettings,
  readLegacyAppearance,
  saveSettings
} from './net/session'
import { legacyAppearanceFrom } from './lib/appearance'
import { ProfileMediaContext } from './lib/profileMedia'
import { DEFAULT_ACCENT } from './data/defaults'
import { useAppearance } from './hooks/useAppearance'
import { useIdleDetection } from './hooks/useIdleDetection'
import { createMentionDetector } from './chat/mentions'
import { SoundService } from './sound/SoundService'
import { messageSound, SeenMessages, type SoundPreferences } from './sound/soundPolicy'
import { useVoiceSounds } from './sound/useVoiceSounds'
import SoundProvider from './sound/SoundProvider'
import type {
  ApiConversation,
  ApiMember,
  ApiServer,
  ApiUser,
  RelationshipType,
  ServerRole
} from './net/protocol'
import {
  HOME_ID,
  canSend,
  conversationTitle,
  dmPartnerId,
  pendingRequestCount
} from './chat/conversations'
import HomeSidebar from './components/home/HomeSidebar'
import FriendsPage from './components/home/FriendsPage'
import GroupDialog from './components/home/GroupDialog'
import ConversationMembers from './components/home/ConversationMembers'
import { Permissions } from './net/protocol'
import { ROLE_COLORS, ROLE_LABELS, hasPermission } from './lib/permissions'
import { useBackend, type BackendSession } from './hooks/useBackend'
import { useVoice } from './hooks/useVoice'
import { usePushToTalk } from './hooks/usePushToTalk'
import { describeKey } from './media/voiceLogic'
import { notificationText, shouldNotify } from './chat/unread'
import { pushRecent } from './chat/emoji'
import ServerSidebar from './components/ServerSidebar'
import ChannelSidebar, { type VoiceUserDetails } from './components/ChannelSidebar'
import ChatPanel, { type ConversationInfo, type JumpTarget } from './components/ChatPanel'
import MemberList from './components/MemberList'
import UserPanel, { type VoiceConnection } from './components/UserPanel'
import SettingsPanel, { type SectionId } from './components/SettingsPanel'
import ProfilePopout from './components/profile/ProfilePopout'
import ProfileModal from './components/profile/ProfileModal'
import type { RelationshipHandlers } from './components/profile/RelationshipActions'
import CustomStatusModal from './components/profile/CustomStatusModal'
import CreateServerModal from './components/CreateServerModal'
import ServerSettingsModal from './components/manage/ServerSettingsModal'
import { InviteModal } from './components/manage/InviteModal'
import ConnectionBanner from './components/ConnectionBanner'
import ScreenSharePicker from './components/ScreenSharePicker'
import StreamViewer, { type ViewerMode } from './components/StreamViewer'
import ShareHealthNote from './components/ShareHealthNote'
import type { ScreenShareOptions, ScreenSource } from './media/ScreenShareController'

const STAFF_ROLES: ServerRole[] = ['owner', 'admin', 'moderator']

function toUiServer(
  server: ApiServer,
  members: ApiMember[] | undefined,
  allUserIds: string[]
): Server {
  const categories: ChannelCategory[] = []
  for (const ch of [...server.channels].sort((a, b) => a.position - b.position)) {
    let category = categories.find((c) => c.name === ch.category)
    if (!category) {
      category = { id: `${server.id}:${ch.category}`, name: ch.category, channels: [] }
      categories.push(category)
    }
    category.channels.push({
      id: ch.id,
      name: ch.name,
      type: ch.type,
      topic: ch.topic ?? undefined,
      permissions: ch.permissions
    })
  }
  return {
    id: server.id,
    name: server.name,
    color: server.color,
    categories,
    // Staff roles are shown as groups in the member list (and color names).
    roles: STAFF_ROLES.map((role) => ({
      id: role,
      name: ROLE_LABELS[role],
      color: ROLE_COLORS[role] ?? ''
    })),
    members: members
      ? members.map((m) => ({ userId: m.userId, roleId: m.role === 'member' ? undefined : m.role }))
      : allUserIds.map((userId) => ({ userId })),
    role: server.role,
    permissions: server.permissions,
    ownerId: server.ownerId
  }
}

function defaultChannel(server: Server): Channel | undefined {
  const text = server.categories.flatMap((c) => c.channels).filter((c) => c.type === 'text')
  return text.find((c) => c.name === 'general') ?? text[0]
}

function findVoiceConnection(
  servers: Server[],
  channelId: string | null
): { channelName: string; serverName: string } | null {
  if (!channelId) return null
  for (const server of servers) {
    for (const category of server.categories) {
      const channel = category.channels.find((ch) => ch.id === channelId)
      if (channel) return { channelName: channel.name, serverName: server.name }
    }
  }
  return null
}

interface WorkspaceProps {
  session: BackendSession & { username: string }
  onSignOut: (notice?: string) => void
}

function Workspace({ session, onSignOut }: WorkspaceProps): React.JSX.Element {
  const [settings, setSettings] = useState<UserSettings>(loadSettings)
  const [activeServerId, setActiveServerId] = useState<string | null>(null)
  const [activeChannelByServer, setActiveChannelByServer] = useState<Record<string, string>>({})
  const [muted, setMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  const [showMembers, setShowMembers] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SectionId>('account')
  const [popout, setPopout] = useState<{ userId: string; anchor: DOMRect } | null>(null)
  const [profileFor, setProfileFor] = useState<string | null>(null)
  const [customStatusOpen, setCustomStatusOpen] = useState(false)
  const popoutClosedRef = useRef<{ userId: string; at: number } | null>(null)
  const [createServerOpen, setCreateServerOpen] = useState(false)
  const [serverSettingsFor, setServerSettingsFor] = useState<string | null>(null)
  const [inviteFor, setInviteFor] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [viewerMode, setViewerMode] = useState<ViewerMode>('focus')
  /** Home view: the open conversation (null = the Friends page). */
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [groupDialog, setGroupDialog] = useState<
    { mode: 'create' } | { mode: 'add'; channelId: string } | null
  >(null)

  const handleSessionInvalid = useCallback(
    () =>
      onSignOut(
        'Your session ended (expired, signed out elsewhere, or revoked). Please sign in again.'
      ),
    [onSignOut]
  )
  const notifyRef = useRef<(m: Message) => void>(() => undefined)
  const onIncomingMessage = useCallback((m: Message) => notifyRef.current(m), [])
  const serverRemovedRef = useRef<(serverId: string, reason: 'left' | 'kicked' | 'banned') => void>(
    () => undefined
  )
  const onServerRemoved = useCallback(
    (serverId: string, reason: 'left' | 'kicked' | 'banned') =>
      serverRemovedRef.current(serverId, reason),
    []
  )
  const relationshipChangedRef = useRef<
    (userId: string, type: RelationshipType | null, previous: RelationshipType | null) => void
  >(() => undefined)
  const onRelationshipChanged = useCallback(
    (userId: string, type: RelationshipType | null, previous: RelationshipType | null) =>
      relationshipChangedRef.current(userId, type, previous),
    []
  )
  const conversationRemovedRef = useRef<
    (channelId: string, reason: 'left' | 'removed' | 'closed') => void
  >(() => undefined)
  const onConversationRemoved = useCallback(
    (channelId: string, reason: 'left' | 'removed' | 'closed') =>
      conversationRemovedRef.current(channelId, reason),
    []
  )
  const backend = useBackend(session, {
    onSessionInvalid: handleSessionInvalid,
    onIncomingMessage,
    onServerRemoved,
    onRelationshipChanged,
    onConversationRemoved
  })

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  // ---- Sound effects (one service for the whole workspace; see sound/) ----
  const [sound] = useState(() => new SoundService())
  const [seenMessages] = useState(() => new SeenMessages())
  const soundPrefs = useMemo<SoundPreferences>(
    () => ({
      enabled: settings.soundEffects,
      volume: settings.soundVolume,
      events: settings.soundEvents
    }),
    [settings.soundEffects, settings.soundVolume, settings.soundEvents]
  )

  // ---- Appearance (synced preferences + this device's font size) and automatic idle ----
  useAppearance(backend.preferences, settings.fontSize)
  useIdleDetection(backend.preferences.idleTimeoutMinutes, backend.setIdle)

  // One-time: copy pre-Milestone-8 local appearance/status settings to the account.
  const legacySeededRef = useRef(false)
  const { preferencesLoaded, preferences, me: meForSeed } = backend
  useEffect(() => {
    if (legacySeededRef.current || !preferencesLoaded || !meForSeed) return
    legacySeededRef.current = true
    const legacy = legacyAppearanceFrom(readLegacyAppearance(), DEFAULT_ACCENT)
    if (!legacy || preferences.updatedAt !== null) {
      // Nothing to copy, or this account already has preferences (e.g. set on another PC).
      clearLegacyAppearance()
      return
    }
    const tasks: Promise<string | null>[] = []
    if (Object.keys(legacy.preferences).length > 0) {
      tasks.push(backend.updatePreferences(legacy.preferences))
    }
    if (legacy.status && meForSeed.statusPreference === 'online') {
      tasks.push(backend.setPresence(legacy.status))
    }
    if (legacy.customStatus && !meForSeed.ownCustomStatus) {
      tasks.push(
        backend.setCustomStatus({ text: legacy.customStatus, emoji: null, expiresInMs: null })
      )
    }
    void Promise.all(tasks).then((errors) => {
      if (errors.every((e) => e === null)) clearLegacyAppearance()
    })
    // Runs once per sign-in when preferences first arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferencesLoaded, meForSeed])

  // ---- Voice ----
  const voice = useVoice({ fetchToken: backend.fetchVoiceToken, settings })
  useVoiceSounds(sound, voice.state)
  const voiceStatus = voice.state.status
  const voiceActive =
    voiceStatus === 'connecting' || voiceStatus === 'connected' || voiceStatus === 'reconnecting'
  const voiceChannelId = voiceStatus === 'idle' ? null : voice.state.channelId
  const pushToTalkMode = settings.inputMode === 'push-to-talk'
  const ptt = usePushToTalk({
    enabled: pushToTalkMode && voiceActive,
    code: settings.pushToTalkKey,
    global: settings.pushToTalkGlobal
  })
  // Permissions in the voice channel we're in (from the server's channel list).
  const voicePerms = useMemo(() => {
    if (!voiceChannelId) return undefined
    for (const s of backend.servers) {
      const ch = s.channels.find((c) => c.id === voiceChannelId)
      if (ch) return ch.permissions
    }
    return undefined
  }, [backend.servers, voiceChannelId])
  const canSpeak = hasPermission(voicePerms, Permissions.speak)
  const canStream = hasPermission(voicePerms, Permissions.stream)
  useEffect(() => {
    voice.session.setMicState({
      // No Speak permission in this voice channel: the mic stays off (LiveKit would refuse it too).
      muted: muted || !canSpeak,
      deafened,
      pushToTalk: pushToTalkMode,
      pushToTalkActive: ptt.active
    })
  }, [voice.session, muted, deafened, pushToTalkMode, ptt.active, canSpeak])

  const selfId = backend.me?.id ?? ''
  const displayName = backend.me?.displayName ?? session.username
  const statusPreference: SelectableStatus = backend.me?.statusPreference ?? 'online'
  const selfCustomStatus = backend.me?.ownCustomStatus ?? null
  const selfStatus = presenceFromSetting(statusPreference)

  const resolveUser = useCallback(
    (id: string): User => {
      const u: ApiUser | undefined = backend.users[id]
      if (!u) {
        return { id, name: 'Unknown User', username: '', avatarColor: '#5c5f66', status: 'offline' }
      }
      const isSelf = id === selfId
      return {
        id: u.id,
        name: u.displayName,
        username: u.username,
        avatarColor: u.avatarColor,
        bot: u.bot,
        // You see your own chosen status (others see 'offline' while you are invisible).
        status: isSelf ? selfStatus : u.status,
        avatarId: u.avatarId,
        bannerId: u.bannerId,
        accentColor: u.accentColor,
        bio: u.bio,
        pronouns: u.pronouns,
        createdAt: u.createdAt,
        customStatus: isSelf ? selfCustomStatus : u.customStatus
      }
    },
    [backend.users, selfId, selfStatus, selfCustomStatus]
  )

  // ---- Profiles ----
  const openProfile = useCallback((userId: string, anchor: DOMRect) => {
    // A click on the same person right after the popout closed (outside click) just closes it.
    const closed = popoutClosedRef.current
    if (closed && closed.userId === userId && Date.now() - closed.at < 300) return
    setPopout({ userId, anchor })
  }, [])
  const closePopout = useCallback(() => {
    setPopout((current) => {
      if (current) popoutClosedRef.current = { userId: current.userId, at: Date.now() }
      return null
    })
  }, [])
  const openSettings = useCallback((section: SectionId = 'account') => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])

  const servers = useMemo(() => {
    const userIds = Object.keys(backend.users)
    return backend.servers.map((s) => toUiServer(s, backend.members[s.id], userIds))
  }, [backend.servers, backend.users, backend.members])

  // Home (friends and conversations) is shown when chosen, or when you aren't in any server.
  const homeActive = activeServerId === HOME_ID || servers.length === 0
  const activeServer = homeActive
    ? undefined
    : (servers.find((s) => s.id === activeServerId) ?? servers[0])
  const activeConversation: ApiConversation | undefined =
    homeActive && activeConversationId ? backend.conversations[activeConversationId] : undefined

  // Real membership (with roles) for the member list of the server on screen.
  const { loadMembers } = backend
  const activeServerKey = activeServer?.id
  useEffect(() => {
    if (backend.phase === 'ready' && activeServerKey) loadMembers(activeServerKey)
  }, [backend.phase, activeServerKey, loadMembers])
  const activeChannel = activeServer
    ? (activeServer.categories
        .flatMap((c) => c.channels)
        .find((c) => c.id === activeChannelByServer[activeServer.id] && c.type === 'text') ??
      defaultChannel(activeServer))
    : undefined
  const activeChannelId = activeChannel?.id

  // The text channel or conversation on screen (notifications and sounds skip it while focused).
  const viewChannelId = homeActive ? activeConversation?.id : activeChannelId
  const { focusChannel } = backend
  useEffect(() => {
    if (backend.phase === 'ready' && viewChannelId) focusChannel(viewChannelId)
  }, [backend.phase, viewChannelId, focusChannel])

  const roleColor = useCallback(
    (userId: string): string | undefined => {
      if (!activeServer) return undefined
      const roleId = activeServer.members.find((m) => m.userId === userId)?.roleId
      return activeServer.roles.find((r) => r.id === roleId)?.color
    },
    [activeServer]
  )

  const unreadServerIds = useMemo(
    () =>
      new Set(
        servers
          .filter((s) =>
            s.categories.some((c) => c.channels.some((ch) => backend.unread.has(ch.id)))
          )
          .map((s) => s.id)
      ),
    [servers, backend.unread]
  )

  const voiceNames = findVoiceConnection(servers, voiceChannelId)
  const voiceConnection: VoiceConnection | null = voiceNames
    ? {
        ...voiceNames,
        status: voiceStatus,
        error: voice.state.error,
        micError: voice.state.micError,
        deviceNotice: voice.state.deviceNotice,
        retryInMs: voice.state.retryInMs,
        quality: voice.state.connectionQuality,
        audioBlocked: voice.state.audioBlocked,
        screenShare: voice.state.screenShare,
        pushToTalk: pushToTalkMode
          ? {
              keyLabel: describeKey(settings.pushToTalkKey),
              active: ptt.active,
              global: settings.pushToTalkGlobal && Boolean(window.d2),
              error: ptt.globalError
            }
          : undefined
      }
    : null

  const voiceMembers = useCallback(
    (channelId: string): string[] => {
      const members = Object.entries(backend.voiceStates)
        .filter(([userId, ch]) => ch === channelId && !(voiceActive && userId === selfId))
        .map(([userId]) => userId)
      // Show ourselves immediately (and only) in the channel we're actually in.
      if (voiceActive && voiceChannelId === channelId && selfId) members.unshift(selfId)
      return members
    },
    [backend.voiceStates, voiceActive, voiceChannelId, selfId]
  )

  const voiceDetails = useCallback(
    (userId: string): VoiceUserDetails | undefined => {
      const p = voice.state.participants.find((x) => x.identity === userId)
      if (!p) return undefined
      if (p.isLocal) return { speaking: p.speaking, muted: muted || deafened, deafened }
      return { speaking: p.speaking, muted: !p.micEnabled, deafened: p.deafened }
    },
    [voice.state.participants, muted, deafened]
  )

  // ---- Screen sharing ----
  const selfSharing = voice.state.screenShare.status === 'live'
  const isStreaming = useCallback(
    (userId: string): boolean => {
      if (userId === selfId && voiceActive) return selfSharing
      // In our room LiveKit is authoritative (and instant); elsewhere use the backend's view.
      const p = voice.state.participants.find((x) => x.identity === userId)
      return p ? p.sharingScreen : Boolean(backend.voiceStreaming[userId])
    },
    [selfId, voiceActive, selfSharing, voice.state.participants, backend.voiceStreaming]
  )

  const watching = voice.state.watching
  const watchingSelf = watching !== null && watching === selfId
  const watchedParticipant = watching
    ? voice.state.participants.find((p) => p.identity === watching)
    : undefined
  const watchedLive = watchingSelf ? selfSharing : Boolean(watchedParticipant?.sharingScreen)

  const watchStream = (userId: string, channel: Channel): void => {
    setViewerMode('focus')
    if (channel.id !== voiceChannelId || !voiceActive) {
      void voice.session.join(channel.id, { watch: userId })
    } else {
      voice.session.watch(userId)
    }
  }

  const stopWatching = (): void => {
    voice.session.watch(null)
    setViewerMode('focus')
  }

  const shareDefaults: ScreenShareOptions = {
    profileId: settings.screenShareProfile,
    audio: settings.screenShareAudio,
    hint: settings.screenShareHint,
    codec: settings.screenShareCodec,
    layering: settings.screenShareLayering,
    backupLayer: settings.screenShareBackupLayer
  }

  const goLive = (source: ScreenSource, options: ScreenShareOptions): void => {
    setPickerOpen(false)
    updateSettings({
      screenShareProfile: options.profileId,
      screenShareAudio: options.audio,
      screenShareHint: options.hint,
      screenShareCodec: options.codec
    })
    void voice.session.startScreenShare(source, options)
  }

  const closePicker = useCallback((): void => {
    setPickerOpen(false)
    void window.d2?.screen.cancel()
  }, [])

  const selectServer = (serverId: string): void => {
    setActiveServerId(serverId)
  }

  const selectHome = (): void => {
    setActiveServerId(HOME_ID)
  }

  const openConversation = useCallback((channelId: string) => {
    setActiveServerId(HOME_ID)
    setActiveConversationId(channelId)
    setViewerMode((mode) => (mode === 'focus' ? 'mini' : mode))
  }, [])

  /** Opens (or creates) the DM with someone and shows it. */
  const messageUser = useCallback(
    (userId: string) => {
      void backend.openDm(userId).then((result) => {
        if (result.conversation) openConversation(result.conversation.id)
        else if (result.error) setNotice(result.error)
      })
    },
    [backend, openConversation]
  )

  const selectChannel = (channel: Channel): void => {
    if (!activeServer) return
    if (channel.type === 'voice') {
      if (!hasPermission(channel.permissions, Permissions.connect)) {
        setNotice(`You don’t have permission to join ${channel.name}.`)
        return
      }
      void voice.session.join(channel.id)
      return
    }
    // Opening a channel doesn't mark it read; the chat panel does that once the newest
    // messages are actually on screen in a focused window.
    setActiveChannelByServer((prev) => ({ ...prev, [activeServer.id]: channel.id }))
    // Keep watching in a mini player while reading chat.
    if (watching) setViewerMode('mini')
  }

  // ---- Jump to a message anywhere (search results, links, notifications) ----
  const [jumpTarget, setJumpTarget] = useState<JumpTarget | null>(null)
  const serversRef = useRef(servers)
  useEffect(() => {
    serversRef.current = servers
  }, [servers])
  const conversationsRef = useRef(backend.conversations)
  useEffect(() => {
    conversationsRef.current = backend.conversations
  }, [backend.conversations])
  const jumpTo = useCallback((channelId: string, messageId: string) => {
    const server = serversRef.current.find((s) =>
      s.categories.some((c) => c.channels.some((ch) => ch.id === channelId))
    )
    if (server) {
      setActiveServerId(server.id)
      setActiveChannelByServer((prev) => ({ ...prev, [server.id]: channelId }))
    } else if (conversationsRef.current[channelId]) {
      setActiveServerId(HOME_ID)
      setActiveConversationId(channelId)
    } else {
      return
    }
    setViewerMode((mode) => (mode === 'focus' ? 'mini' : mode))
    setJumpTarget((prev) => ({ channelId, messageId, seq: (prev?.seq ?? 0) + 1 }))
  }, [])

  const channelName = useCallback(
    (channelId: string): string => {
      for (const s of servers) {
        for (const c of s.categories) {
          const ch = c.channels.find((x) => x.id === channelId)
          if (ch) return ch.name
        }
      }
      return 'unknown'
    },
    [servers]
  )

  const userList = useMemo(
    () =>
      Object.keys(backend.users)
        .map(resolveUser)
        .filter((u) => !u.bot),
    [backend.users, resolveUser]
  )
  const meUsername = backend.me?.username ?? session.username
  // Keyed by names only, so presence updates don't rebuild it.
  const mentionNameKey = userList
    .flatMap((u) => [u.username, u.name])
    .filter(Boolean)
    .sort()
    .join('\n')
  const mentionDetector = useMemo(
    () =>
      createMentionDetector(
        { username: meUsername, displayName },
        mentionNameKey ? mentionNameKey.split('\n') : []
      ),
    [mentionNameKey, meUsername, displayName]
  )
  // ---- Desktop notifications (content hidden unless the user opts in) ----
  useEffect(() => {
    notifyRef.current = (m: Message) => {
      // Each message sounds/notifies at most once, however often it's delivered.
      if (!seenMessages.firstTime(m.id)) return
      const windowFocused = document.hasFocus()
      const conversation = backend.conversations[m.channelId]
      // A direct message is addressed to you, so it alerts like a mention.
      const mentionsMe = mentionDetector.mentions(m.content) || conversation?.kind === 'dm'
      const wantedSound = messageSound(
        m,
        {
          meId: backend.me?.id,
          doNotDisturb: statusPreference === 'dnd',
          mutedChannels: settings.mutedChannels,
          activeChannelId: viewChannelId,
          windowFocused,
          mentionsMe
        },
        soundPrefs
      )
      const played = wantedSound ? sound.play(wantedSound) : 'skipped'

      const permission =
        typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
      if (
        !shouldNotify(m, {
          // Do Not Disturb silences desktop notifications.
          enabled: settings.desktopNotifications && statusPreference !== 'dnd',
          permission,
          meId: backend.me?.id,
          mutedChannels: settings.mutedChannels,
          activeChannelId: viewChannelId,
          windowFocused
        })
      ) {
        return
      }
      const { title, body } = notificationText({
        authorName: resolveUser(m.authorId).name,
        channelName: channelName(m.channelId),
        content: m.content,
        attachmentCount: m.attachments?.length ?? 0,
        showPreview: settings.notificationPreview,
        mention: mentionsMe,
        conversation: conversation
          ? conversation.kind === 'dm'
            ? { kind: 'dm' }
            : {
                kind: 'group',
                title: conversationTitle(conversation, backend.users, backend.me?.id)
              }
          : undefined
      })
      const n = new Notification(title, {
        body,
        // The app plays its own sound; Windows' chime is only a fallback when that couldn't play.
        silent: !(wantedSound && played === 'unavailable'),
        tag: m.channelId
      })
      n.onclick = () => {
        window.focus()
        jumpTo(m.channelId, m.id)
      }
    }
  })

  const toggleChannelMute = (channelId: string): void => {
    const next = { ...settings.mutedChannels }
    if (next[channelId]) delete next[channelId]
    else next[channelId] = true
    updateSettings({ mutedChannels: next })
  }

  const useEmoji = useCallback(
    (emoji: string) =>
      setSettings((prev) => ({ ...prev, recentEmoji: pushRecent(prev.recentEmoji, emoji) })),
    []
  )

  const unreadCounts = useMemo(
    () =>
      Object.fromEntries(Object.entries(backend.readStates).map(([id, r]) => [id, r.unreadCount])),
    [backend.readStates]
  )

  // Mute/deafen sounds come only from your own actions (buttons, settings), never from state sync.
  const toggleMute = (): void => {
    // Unmuting while deafened also undeafens, matching common voice-chat behavior.
    if (deafened) {
      setDeafened(false)
      setMuted(false)
      sound.play('undeafen')
    } else {
      sound.play(muted ? 'unmute' : 'mute')
      setMuted(!muted)
    }
  }

  const toggleDeafen = (): void => {
    sound.play(deafened ? 'undeafen' : 'deafen')
    setDeafened(!deafened)
  }

  const createServer = async (name: string, color: string): Promise<string | null> => {
    const result = await backend.createServer(name, color)
    if (result.error || !result.server) return result.error ?? 'Could not create server.'
    setActiveServerId(result.server.id)
    setCreateServerOpen(false)
    return null
  }

  const joinedServer = (server: ApiServer): void => {
    void backend.refreshServers()
    setActiveServerId(server.id)
    setCreateServerOpen(false)
  }

  // Friend requests: a sound (and a desktop notification while the app isn't focused).
  useEffect(() => {
    relationshipChangedRef.current = (userId, type, previous) => {
      const name = resolveUser(userId).name
      if (type === 'incoming' && previous !== 'incoming') {
        if (statusPreference === 'dnd') return
        sound.play('friendRequest')
        const permission =
          typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
        if (settings.desktopNotifications && permission === 'granted' && !document.hasFocus()) {
          const n = new Notification('Friend request', {
            body: settings.notificationPreview
              ? `${name} sent you a friend request.`
              : 'You have a new friend request.',
            silent: true,
            tag: `friend-${userId}`
          })
          n.onclick = () => {
            window.focus()
            setActiveServerId(HOME_ID)
            setActiveConversationId(null)
          }
        }
      } else if (type === 'friend' && previous === 'outgoing') {
        setNotice(`${name} accepted your friend request.`)
      }
    }
  })

  // You left, were removed from, or closed a conversation (maybe on another device).
  useEffect(() => {
    conversationRemovedRef.current = (channelId, reason) => {
      if (activeConversationId === channelId) setActiveConversationId(null)
      if (reason === 'removed') setNotice('You were removed from a group.')
    }
  })

  // Removed from a server (left, kicked, banned): leave its voice channel and say why.
  useEffect(() => {
    serverRemovedRef.current = (serverId, reason) => {
      const server = serversRef.current.find((s) => s.id === serverId)
      const inVoice = server?.categories.some((c) =>
        c.channels.some((ch) => ch.id === voiceChannelId)
      )
      if (inVoice) void voice.session.leave()
      if (serverSettingsFor === serverId) setServerSettingsFor(null)
      if (reason !== 'left') {
        setNotice(
          `You were ${reason === 'banned' ? 'banned' : 'removed'} from ${server?.name ?? 'a server'}.`
        )
      }
    }
  })

  /** Explicit sign-out: leave voice, revoke this session on the server, then forget it locally. */
  const signOut = (): void => {
    void voice.session.leave()
    void backend.api
      .logout()
      .catch(() => undefined)
      .finally(() => onSignOut())
  }

  const leaveServer = (server: Server): void => {
    if (!window.confirm(`Leave ${server.name}? You'll need a new invite to come back.`)) return
    void backend.api.leaveServer(server.id).catch((err: unknown) => {
      setNotice(err instanceof Error ? err.message : 'Could not leave the server.')
    })
  }

  const serverActions = (
    server: Server
  ): { label: string; onSelect: () => void; danger?: boolean }[] => {
    const perms = server.permissions ?? 0
    const actions: { label: string; onSelect: () => void; danger?: boolean }[] = []
    if (hasPermission(perms, Permissions.createInvites)) {
      actions.push({ label: 'Invite People', onSelect: () => setInviteFor(server.id) })
    }
    actions.push({ label: 'Server Settings', onSelect: () => setServerSettingsFor(server.id) })
    if (server.role !== 'owner') {
      actions.push({ label: 'Leave Server', danger: true, onSelect: () => leaveServer(server) })
    }
    return actions
  }

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  const updateSettings = useCallback((patch: Partial<UserSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }, [])
  const setStatus = useCallback(
    (status: SelectableStatus) => {
      void backend.setPresence(status).then((error) => {
        if (error) setNotice(`Couldn’t change your status: ${error}`)
      })
    },
    [backend]
  )
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const closeProfileModal = useCallback(() => setProfileFor(null), [])
  const closeCustomStatus = useCallback(() => setCustomStatusOpen(false), [])
  /** A member's role in the server on screen (for profile cards). */
  const roleOf = (userId: string): { label: string; color?: string } | undefined => {
    const role = activeServer
      ? backend.members[activeServer.id]?.find((m) => m.userId === userId)?.role
      : undefined
    return role ? { label: ROLE_LABELS[role], color: ROLE_COLORS[role] } : undefined
  }
  const closeCreateServer = useCallback(() => setCreateServerOpen(false), [])
  const closeServerSettings = useCallback(() => setServerSettingsFor(null), [])
  const closeInvite = useCallback(() => setInviteFor(null), [])
  const serverForSettings = serverSettingsFor
    ? backend.servers.find((s) => s.id === serverSettingsFor)
    : undefined
  const { loadMembers: loadServerMembers } = backend
  useEffect(() => {
    if (serverSettingsFor) loadServerMembers(serverSettingsFor)
  }, [serverSettingsFor, loadServerMembers])

  // The same provider element wraps every view, so the sound service's lifecycle spans them.
  const withSound = (node: React.ReactNode): React.JSX.Element => (
    <SoundProvider
      service={sound}
      preferences={soundPrefs}
      outputDeviceId={settings.outputDeviceId}
    >
      {node}
    </SoundProvider>
  )

  if (backend.phase !== 'ready') {
    return withSound(
      <div className="app splash">
        <div className="splash-card">
          {backend.phase === 'error' ? (
            <>
              <h2>Couldn&rsquo;t load your servers</h2>
              <p>{backend.loadError}</p>
              <div className="splash-actions">
                <button type="button" className="button primary" onClick={backend.retryInitialLoad}>
                  Try again
                </button>
                <button type="button" className="button secondary" onClick={signOut}>
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="spinner" aria-hidden="true" />
              <p>Connecting to {session.httpUrl}…</p>
            </>
          )}
        </div>
        {createServerOpen && (
          <CreateServerModal
            onCreate={createServer}
            api={backend.api}
            onJoined={joinedServer}
            onClose={closeCreateServer}
          />
        )}
      </div>
    )
  }

  const userPanel = (
    <UserPanel
      displayName={displayName}
      avatarColor={backend.me?.avatarColor ?? DEFAULT_ACCENT}
      avatarId={backend.me?.avatarId}
      status={selfStatus}
      statusPreference={statusPreference}
      customStatus={selfCustomStatus}
      onSetStatus={setStatus}
      onEditCustomStatus={() => setCustomStatusOpen(true)}
      onClearCustomStatus={() => void backend.setCustomStatus(null)}
      onViewProfile={() => setProfileFor(selfId)}
      onEditProfile={() => openSettings('profile')}
      muted={muted}
      deafened={deafened}
      voice={voiceConnection}
      onToggleMute={toggleMute}
      onToggleDeafen={toggleDeafen}
      onOpenSettings={() => openSettings('account')}
      onDisconnect={() => void voice.session.leave()}
      onRetryVoice={() => voice.session.retry()}
      onOpenMicSettings={
        window.d2 ? () => void window.d2?.media.openMicrophoneSettings() : undefined
      }
      onShareScreen={() => {
        voice.session.dismissScreenShareMessage()
        if (!canStream) {
          setNotice('You don’t have permission to stream in this channel.')
          return
        }
        setPickerOpen(true)
      }}
      onStopShare={() => void voice.session.stopScreenShare()}
      onPreviewShare={() => {
        setViewerMode('focus')
        voice.session.watch(selfId)
      }}
      onChangeShareProfile={(profileId) => {
        updateSettings({ screenShareProfile: profileId })
        void voice.session.setScreenShareProfile(profileId)
      }}
      onDismissShareMessage={() => voice.session.dismissScreenShareMessage()}
      onDismissDeviceNotice={() => voice.session.dismissDeviceNotice()}
      onStartAudio={() => void voice.session.startAudio()}
      shareStatus={
        voice.state.screenShare.options ? (
          <ShareHealthNote
            session={voice.session}
            profileId={voice.state.screenShare.options.profileId}
          />
        ) : undefined
      }
    />
  )

  // ---- Home: friends and conversations ----
  const pendingRequests = pendingRequestCount(backend.relationships)
  const homeBadge =
    pendingRequests +
    Object.keys(backend.conversations).reduce(
      (sum, id) => sum + (id === viewChannelId ? 0 : (unreadCounts[id] ?? 0)),
      0
    )
  const conversationChannel: Channel | undefined = activeConversation
    ? {
        id: activeConversation.id,
        name: conversationTitle(activeConversation, backend.users, selfId),
        type: 'text',
        permissions: activeConversation.permissions
      }
    : undefined
  const chatChannel = homeActive ? conversationChannel : activeChannel
  const partnerId = activeConversation ? dmPartnerId(activeConversation, selfId) : undefined
  const conversationInfo: ConversationInfo | undefined = activeConversation
    ? {
        kind: activeConversation.kind,
        title: conversationChannel!.name,
        label:
          activeConversation.kind === 'dm'
            ? `@${conversationChannel!.name}`
            : conversationChannel!.name,
        partner: partnerId ? resolveUser(partnerId) : undefined,
        readOnlyReason: canSend(activeConversation)
          ? undefined
          : 'You can’t send messages to this person right now.'
      }
    : undefined

  /** Friend / message / block actions on someone's profile (none for yourself or bots). */
  function relationshipFor(
    userId: string,
    close: () => void
  ): { type: RelationshipType | null; handlers: RelationshipHandlers } | undefined {
    const user = backend.users[userId]
    if (!user || user.bot || userId === selfId) return undefined
    const report = (error: string | null): void => {
      if (error) setNotice(error)
    }
    return {
      type: backend.relationships[userId]?.type ?? null,
      handlers: {
        onMessage: () => {
          close()
          messageUser(userId)
        },
        onAddFriend: () =>
          void backend
            .sendFriendRequest(user.username)
            .then((r) =>
              setNotice(
                r.error ??
                  (r.type === 'friend'
                    ? `You and ${user.displayName} are now friends.`
                    : `Friend request sent to ${user.displayName}.`)
              )
            ),
        onAccept: () => void backend.acceptFriendRequest(userId).then(report),
        onRemove: () => void backend.removeRelationship(userId).then(report),
        onBlock: () => void backend.setBlocked(userId, true).then(report),
        onUnblock: () => void backend.setBlocked(userId, false).then(report)
      }
    }
  }

  /** Closes a DM (hidden until the next message) or leaves a group after confirming. */
  function closeOrLeave(conversation: ApiConversation): void {
    if (conversation.kind === 'group') {
      const title = conversationTitle(conversation, backend.users, selfId)
      if (
        !window.confirm(`Leave ${title}? You won’t see its messages unless someone adds you back.`)
      )
        return
      void backend.leaveGroup(conversation.id).then((error) => error && setNotice(error))
    } else {
      void backend.closeConversation(conversation.id).then((error) => error && setNotice(error))
    }
    if (activeConversationId === conversation.id) setActiveConversationId(null)
  }

  return withSound(
    <ProfileMediaContext.Provider value={backend.profileMedia}>
      <div className="app">
        <ServerSidebar
          servers={servers}
          activeServerId={activeServer?.id ?? null}
          homeActive={homeActive}
          homeBadge={homeBadge}
          onSelectHome={selectHome}
          unreadServerIds={unreadServerIds}
          onSelectServer={selectServer}
          onAddServer={() => setCreateServerOpen(true)}
        />

        {activeServer ? (
          <ChannelSidebar
            server={activeServer}
            activeChannelId={activeChannel?.id ?? ''}
            unreadChannelIds={backend.unread}
            unreadCounts={unreadCounts}
            voiceChannelId={voiceChannelId}
            selfId={selfId}
            resolveUser={resolveUser}
            voiceMembers={voiceMembers}
            voiceDetails={voiceDetails}
            getUserVolume={(userId) => settings.userVolumes[userId] ?? 100}
            onUserVolumeChange={(userId, volume) =>
              updateSettings({ userVolumes: { ...settings.userVolumes, [userId]: volume } })
            }
            isStreaming={isStreaming}
            watchingId={watching}
            onWatch={watchStream}
            getStreamVolume={(userId) => settings.streamVolumes[userId] ?? 100}
            onStreamVolumeChange={(userId, volume) =>
              updateSettings({ streamVolumes: { ...settings.streamVolumes, [userId]: volume } })
            }
            onSelectChannel={selectChannel}
            serverActions={serverActions(activeServer)}
            footer={userPanel}
          />
        ) : (
          <HomeSidebar
            conversations={backend.conversations}
            loaded={backend.conversationsLoaded}
            users={backend.users}
            meId={selfId}
            activeConversationId={activeConversation?.id ?? null}
            unreadCounts={unreadCounts}
            pendingRequests={pendingRequests}
            resolveUser={resolveUser}
            onOpenFriends={() => setActiveConversationId(null)}
            onOpenConversation={openConversation}
            onCloseConversation={closeOrLeave}
            onCreateGroup={() => setGroupDialog({ mode: 'create' })}
            footer={userPanel}
          />
        )}

        {watching && (
          // One viewer instance for both modes, so switching focus/mini never remounts the video.
          <main className={viewerMode === 'focus' ? 'chat-panel stream-main' : 'stream-slot-mini'}>
            <StreamViewer
              session={voice.session}
              identity={watching}
              isSelf={watchingSelf}
              sharerName={resolveUser(watching).name}
              channelName={voiceNames?.channelName ?? ''}
              live={watchedLive}
              streamRevision={voice.state.streamRevision}
              mode={viewerMode}
              quality={voice.state.connectionQuality}
              volume={
                !watchingSelf && watchedParticipant?.sharingAudio
                  ? (settings.streamVolumes[watching] ?? 100)
                  : null
              }
              defaultShowStats={settings.showStreamStats}
              onVolumeChange={(volume) =>
                updateSettings({ streamVolumes: { ...settings.streamVolumes, [watching]: volume } })
              }
              onModeChange={setViewerMode}
              onStopWatching={stopWatching}
            />
          </main>
        )}

        {watching && viewerMode === 'focus' ? null : chatChannel ? (
          <ChatPanel
            key={homeActive ? 'conversation' : 'channel'}
            channel={chatChannel}
            serverId={activeServer?.id ?? null}
            conversation={homeActive ? conversationInfo : undefined}
            state={backend.channels[chatChannel.id]}
            readState={backend.readStates[chatChannel.id]}
            meId={selfId}
            banner={
              <ConnectionBanner
                status={backend.gateway.status}
                retryInMs={backend.gateway.retryInMs}
              />
            }
            selfName={displayName}
            selfUsername={meUsername}
            showMembers={showMembers}
            compactMode={backend.preferences.density === 'compact'}
            showTimestamps={backend.preferences.showTimestamps}
            notificationsMuted={Boolean(settings.mutedChannels[chatChannel.id])}
            pinsRevision={backend.pinsRevision[chatChannel.id] ?? 0}
            recentEmoji={settings.recentEmoji}
            jumpTarget={jumpTarget}
            users={
              homeActive && activeConversation
                ? userList.filter((u) => activeConversation.memberIds.includes(u.id))
                : userList
            }
            backend={backend}
            resolveUser={resolveUser}
            roleColor={roleColor}
            channelName={channelName}
            onToggleMembers={() => setShowMembers((v) => !v)}
            onToggleNotificationsMuted={() => toggleChannelMute(chatChannel.id)}
            onEmojiUsed={useEmoji}
            onJumpTo={jumpTo}
            onOpenProfile={openProfile}
          />
        ) : homeActive ? (
          <FriendsPage
            relationships={backend.relationships}
            users={backend.users}
            loaded={backend.conversationsLoaded}
            supported={backend.connectionsSupported}
            resolveUser={resolveUser}
            banner={
              <ConnectionBanner
                status={backend.gateway.status}
                retryInMs={backend.gateway.retryInMs}
              />
            }
            onMessage={messageUser}
            onOpenProfile={openProfile}
            onSendRequest={backend.sendFriendRequest}
            onAccept={backend.acceptFriendRequest}
            onRemove={backend.removeRelationship}
            onUnblock={(userId) => backend.setBlocked(userId, false)}
          />
        ) : (
          <main className="chat-panel empty-state">This server has no text channels yet.</main>
        )}

        {showMembers && !(watching && viewerMode === 'focus') && activeServer && activeChannel && (
          <MemberList server={activeServer} resolveUser={resolveUser} onOpenProfile={openProfile} />
        )}

        {showMembers && !(watching && viewerMode === 'focus') && activeConversation && (
          <ConversationMembers
            key={activeConversation.id}
            conversation={activeConversation}
            meId={selfId}
            resolveUser={resolveUser}
            onOpenProfile={openProfile}
            onAddPeople={() => setGroupDialog({ mode: 'add', channelId: activeConversation.id })}
            onRename={(name) => backend.renameGroup(activeConversation.id, name)}
            onRemove={(userId) => backend.removeGroupMember(activeConversation.id, userId)}
            onLeave={() => closeOrLeave(activeConversation)}
          />
        )}

        {pickerOpen && (
          <ScreenSharePicker initial={shareDefaults} onGoLive={goLive} onClose={closePicker} />
        )}

        {settingsOpen && (
          <SettingsPanel
            settings={settings}
            voiceSession={voice.session}
            voiceState={voice.state}
            userName={(id) => resolveUser(id).name}
            username={backend.me?.username ?? session.username}
            serverUrl={session.httpUrl}
            muted={muted}
            deafened={deafened}
            initialSection={settingsSection}
            onChange={updateSettings}
            preferences={backend.preferences}
            preferencesLoaded={backend.preferencesLoaded}
            onPreferencesChange={backend.updatePreferences}
            onProfileSave={backend.updateProfile}
            onProfileImageUpload={backend.uploadProfileImage}
            onProfileImageRemove={backend.removeProfileImage}
            onSetStatus={setStatus}
            onEditCustomStatus={() => setCustomStatusOpen(true)}
            onLogout={signOut}
            api={backend.api}
            me={backend.me}
            servers={backend.servers}
            onSignedOutEverywhere={() => {
              void voice.session.leave()
              onSignOut('You signed out on all devices.')
            }}
            onToggleMute={toggleMute}
            onToggleDeafen={toggleDeafen}
            onClose={closeSettings}
            privacy={{
              allowServerDms: backend.me?.allowServerDms ?? true,
              onAllowServerDmsChange: backend.setAllowServerDms,
              blocked: Object.values(backend.relationships)
                .filter((r) => r.type === 'blocked')
                .map((r) => resolveUser(r.userId)),
              onUnblock: (userId) => backend.setBlocked(userId, false)
            }}
          />
        )}

        {createServerOpen && (
          <CreateServerModal
            onCreate={createServer}
            api={backend.api}
            onJoined={joinedServer}
            onClose={closeCreateServer}
          />
        )}

        {serverSettingsFor && serverForSettings && (
          <ServerSettingsModal
            api={backend.api}
            server={serverForSettings}
            meId={selfId}
            members={backend.members[serverForSettings.id]}
            revision={backend.serversRevision}
            resolveUser={resolveUser}
            onInvite={() => setInviteFor(serverForSettings.id)}
            onClose={closeServerSettings}
          />
        )}

        {inviteFor && (
          <InviteModal
            api={backend.api}
            serverId={inviteFor}
            serverName={backend.servers.find((s) => s.id === inviteFor)?.name ?? 'this server'}
            onClose={closeInvite}
          />
        )}

        {popout && (
          <ProfilePopout
            user={resolveUser(popout.userId)}
            anchor={popout.anchor}
            role={roleOf(popout.userId)}
            isSelf={popout.userId === selfId}
            selfCustomStatus={selfCustomStatus}
            relationship={relationshipFor(popout.userId, closePopout)}
            onViewProfile={() => {
              setProfileFor(popout.userId)
              setPopout(null)
            }}
            onEditProfile={() => {
              setPopout(null)
              openSettings('profile')
            }}
            onClose={closePopout}
          />
        )}

        {profileFor && (
          <ProfileModal
            user={resolveUser(profileFor)}
            isSelf={profileFor === selfId}
            selfCustomStatus={selfCustomStatus}
            relationship={relationshipFor(profileFor, closeProfileModal)}
            role={roleOf(profileFor)}
            servers={backend.servers}
            fetchProfile={backend.fetchProfile}
            onEditProfile={() => {
              setProfileFor(null)
              openSettings('profile')
            }}
            onOpenServer={(serverId) => {
              setProfileFor(null)
              setActiveServerId(serverId)
            }}
            onClose={closeProfileModal}
          />
        )}

        {groupDialog && (
          <GroupDialog
            mode={groupDialog.mode}
            relationships={backend.relationships}
            users={backend.users}
            existingMemberIds={
              groupDialog.mode === 'add'
                ? (backend.conversations[groupDialog.channelId]?.memberIds ?? [])
                : undefined
            }
            resolveUser={resolveUser}
            onSubmit={async (userIds, name) => {
              if (groupDialog.mode === 'create') {
                const result = await backend.createGroup(userIds, name)
                if (result.conversation) openConversation(result.conversation.id)
                return result.error ?? null
              }
              // Added one at a time (each is checked and logged by the server).
              for (const userId of userIds) {
                const error = await backend.addGroupMember(groupDialog.channelId, userId)
                if (error) return error
              }
              return null
            }}
            onClose={() => setGroupDialog(null)}
          />
        )}

        {customStatusOpen && (
          <CustomStatusModal
            current={selfCustomStatus}
            recentEmoji={settings.recentEmoji}
            onSave={backend.setCustomStatus}
            onClose={closeCustomStatus}
          />
        )}

        {notice && (
          <div className="app-toast" role="status">
            {notice}
            <button
              type="button"
              className="icon-button small"
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </ProfileMediaContext.Provider>
  )
}

export default Workspace
