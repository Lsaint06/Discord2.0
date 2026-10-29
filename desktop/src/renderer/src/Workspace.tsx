import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
import { timeoutNotice } from './lib/timeouts'
import {
  clearLegacyAppearance,
  loadSettings,
  readLegacyAppearance,
  saveSettings
} from './net/session'
import { legacyAppearanceFrom } from './lib/appearance'
import { ProfileMediaContext } from './lib/profileMedia'
import { ProfileMotionContext } from './lib/profileMotion'
import { decorationOf } from './lib/profileStyle'
import { DEFAULT_ACCENT } from './data/defaults'
import { useAppearance, useReducedMotion } from './hooks/useAppearance'
import {
  appThemeById,
  localThemeKey,
  readLocalTheme,
  readThemeUnsynced,
  resolveAppTheme,
  unsyncedThemeAction,
  writeLocalTheme,
  writeThemeUnsynced
} from './lib/themes'
import type { AppThemeId } from './net/protocol'
import { GifContext, ReducedMotionContext, type GifSupport } from './chat/gifContext'
import { DiskDownloadContext, type DiskDownloads } from './chat/diskDownloads'
import { UploadAbortedError, type LargeFileSupport } from './net/api'
import { UploadContext } from './chat/uploadContext'
import {
  UploadManager,
  largeUploadsKey,
  localLargeUploadStore,
  type ActiveUpload,
  type UploadManagerDeps
} from './chat/uploadManager'
import { LargeUploadAborted, needsLargeUpload, uploadLargeFile } from './chat/largeUpload'
import { UPLOAD_LIMITS, isImageName } from './chat/uploads'
import UploadsIndicator from './components/chat/UploadsIndicator'
import { useMediaQuery } from './hooks/useMediaQuery'
import { useIdleDetection } from './hooks/useIdleDetection'
import { createMentionDetector } from './chat/mentions'
import { SoundService } from './sound/SoundService'
import { messageSound, SeenMessages, type SoundPreferences } from './sound/soundPolicy'
import { useVoiceSounds } from './sound/useVoiceSounds'
import { useConnectionStats } from './hooks/useConnectionStats'
import {
  clearDrafts,
  draftsKey,
  loadDrafts,
  saveDrafts,
  setDraft,
  type Drafts
} from './chat/drafts'
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
  pendingRequestCount,
  sortConversations
} from './chat/conversations'
import HomeSidebar from './components/home/HomeSidebar'
import FriendsPage, { type FriendsTab } from './components/home/FriendsPage'
import WordGame from './components/games/WordGame'
import WelcomeModal from './components/onboarding/WelcomeModal'
import GroupDialog from './components/home/GroupDialog'
import ConversationMembers from './components/home/ConversationMembers'
import { Permissions } from './net/protocol'
import { ROLE_COLORS, ROLE_LABELS, hasPermission } from './lib/permissions'
import { pushVisit, type SwitchItem } from './lib/quickSwitch'
import { parseKeybinds } from './lib/keybinds'
import { useKeybinds } from './hooks/useKeybinds'
import QuickSwitcher from './components/QuickSwitcher'
import SidebarResizer from './components/SidebarResizer'
import { clampSidebarWidth } from './lib/sidebarWidth'
import { useBackend, describeError, type BackendSession } from './hooks/useBackend'
import { useVoice } from './hooks/useVoice'
import { usePushToTalk } from './hooks/usePushToTalk'
import { describeKey } from './media/voiceLogic'
import { effectiveNotificationLevel, notificationText, shouldNotify } from './chat/unread'
import { pushRecent } from './chat/emoji'
import ServerSidebar from './components/ServerSidebar'
import ChannelSidebar, { type VoiceUserDetails } from './components/ChannelSidebar'
import ChatPanel, { type ConversationInfo, type JumpTarget } from './components/ChatPanel'
import MemberList from './components/MemberList'
import UserPanel, { type VoiceConnection } from './components/UserPanel'
import SoundboardPanel from './components/SoundboardPanel'
import SettingsPanel, { type SectionId } from './components/SettingsPanel'
import ProfilePopout from './components/profile/ProfilePopout'
import ProfileModal from './components/profile/ProfileModal'
import type { RelationshipHandlers } from './components/profile/RelationshipActions'
import CustomStatusModal from './components/profile/CustomStatusModal'
import CreateServerModal from './components/CreateServerModal'
import ServerSettingsModal from './components/manage/ServerSettingsModal'
import { InviteModal } from './components/manage/InviteModal'
import CreateChannelModal, { type NewChannelType } from './components/manage/CreateChannelModal'
import ConnectionBanner from './components/ConnectionBanner'
import ScreenSharePicker from './components/ScreenSharePicker'
import StreamViewer, { type ViewerMode } from './components/StreamViewer'
import ShareHealthNote from './components/ShareHealthNote'
import type { ScreenShareOptions, ScreenSource } from './media/ScreenShareController'
import CallStage from './components/video/CallStage'
import CameraStrip from './components/video/CameraStrip'
import CameraOverlay from './components/video/CameraOverlay'
import type { CameraAvailability } from './components/video/CameraButton'
import type { TilePerson } from './components/video/VideoTile'
import type { VoiceParticipant } from './media/MediaSession'
import type { OverlaySettings } from './lib/overlay'

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
      permissions: ch.permissions,
      userLimit: ch.userLimit
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
      ? members.map((m) => ({
          userId: m.userId,
          roleId: m.role === 'member' ? undefined : m.role,
          timeoutUntil: m.timeoutUntil
        }))
      : allUserIds.map((userId) => ({ userId })),
    role: server.role,
    permissions: server.permissions,
    ownerId: server.ownerId,
    description: server.description,
    iconId: server.iconId,
    defaultNotifications: server.defaultNotifications,
    timeoutUntil: server.timeoutUntil
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
  /** Signed in right after creating the account: show the short welcome. */
  newAccount?: boolean
  onSignOut: (notice?: string) => void
  /** Opens Connection settings without signing out (offered when the server can't be reached). */
  onOpenConnectionSettings?: () => void
}

function Workspace({
  session,
  newAccount = false,
  onSignOut,
  onOpenConnectionSettings
}: WorkspaceProps): React.JSX.Element {
  const [settings, setSettings] = useState<UserSettings>(loadSettings)
  const keybinds = useMemo(() => parseKeybinds(settings.keybinds), [settings.keybinds])
  const [activeServerId, setActiveServerId] = useState<string | null>(null)
  const [activeChannelByServer, setActiveChannelByServer] = useState<Record<string, string>>({})
  const [muted, setMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  const [showMembers, setShowMembers] = useState(true)
  // Narrow windows (or large interface scales): the member list doesn't squeeze the chat; its
  // button opens it over the chat instead, and it starts closed.
  const narrowWindow = useMediaQuery('(max-width: 980px)')
  const [membersOverlay, setMembersOverlay] = useState(false)
  const membersVisible = narrowWindow ? membersOverlay : showMembers
  const toggleMembers = (): void =>
    narrowWindow ? setMembersOverlay((v) => !v) : setShowMembers((v) => !v)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SectionId>('account')
  // Milestone 14.5: the video view, and the overlay's session-only state (hidden with its
  // shortcut, being moved, or being arranged from Settings). Nothing here starts a camera.
  const [stageOpen, setStageOpen] = useState(false)
  const [overlayHidden, setOverlayHidden] = useState(false)
  const [overlayEditing, setOverlayEditing] = useState(false)
  const [overlayArranging, setOverlayArranging] = useState(false)
  const [cameraSupported, setCameraSupported] = useState<boolean | null>(null)
  const [popout, setPopout] = useState<{ userId: string; anchor: DOMRect } | null>(null)
  const [profileFor, setProfileFor] = useState<string | null>(null)
  const [customStatusOpen, setCustomStatusOpen] = useState(false)
  const popoutClosedRef = useRef<{ userId: string; at: number } | null>(null)
  const [createServerOpen, setCreateServerOpen] = useState(false)
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false)
  /** Recently opened channels and conversations (quick switcher ordering), newest first. */
  const [visits, setVisits] = useState<string[]>([])
  // Unsent drafts per conversation, persisted per server + account (saved shortly after typing).
  const draftStorageKey = draftsKey(session.httpUrl, session.username)
  const [drafts, setDrafts] = useState<Drafts>(() => loadDrafts(draftStorageKey))
  const draftsRef = useRef(drafts)
  const changeDraft = useCallback(
    (channelId: string, text: string) =>
      setDrafts((current) => setDraft(current, channelId, text, Date.now())),
    []
  )
  useEffect(() => {
    draftsRef.current = drafts
    const timer = setTimeout(() => saveDrafts(draftStorageKey, drafts), 400)
    return () => clearTimeout(timer)
  }, [drafts, draftStorageKey])
  // Don't lose the last keystrokes when the app closes within the save delay.
  useEffect(() => {
    const flush = (): void => saveDrafts(draftStorageKey, draftsRef.current)
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [draftStorageKey])
  /** First-run welcome checklist for brand-new accounts ('done' once closed or skipped). */
  const [welcome, setWelcome] = useState<'pending' | 'done'>(newAccount ? 'pending' : 'done')
  /** Asks the Friends page to open a tab (the counter remounts it). */
  const [friendsTabRequest, setFriendsTabRequest] = useState<{ tab: FriendsTab; n: number } | null>(
    null
  )
  const [serverSettingsFor, setServerSettingsFor] = useState<string | null>(null)
  const [inviteFor, setInviteFor] = useState<string | null>(null)
  // The + next to a category in the channel list.
  const [createChannelIn, setCreateChannelIn] = useState<{
    serverId: string
    category: string
    type: NewChannelType
  } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [viewerMode, setViewerMode] = useState<ViewerMode>('focus')
  /** Home view: the open conversation (null = the Friends page). */
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  /** Home shows the Daily Word game instead of Friends. */
  const [gameOpen, setGameOpen] = useState(false)
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
  const attentionFlashRef = useRef(false)
  const messageFailedRef = useRef<() => void>(() => undefined)
  const onMessageFailed = useCallback(() => messageFailedRef.current(), [])
  const soundboardRef = useRef<
    (event: { serverId: string; channelId: string; soundId: string; userId: string }) => void
  >(() => undefined)
  const onSoundboardPlay = useCallback(
    (event: { serverId: string; channelId: string; soundId: string; userId: string }) =>
      soundboardRef.current(event),
    []
  )
  const backend = useBackend(session, {
    onSessionInvalid: handleSessionInvalid,
    onIncomingMessage,
    onServerRemoved,
    onRelationshipChanged,
    onConversationRemoved,
    onMessageFailed,
    onSoundboardPlay
  })

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  // ---- Sound effects (one service for the whole workspace; see sound/) ----
  const [sound] = useState(() => new SoundService())
  useEffect(() => {
    messageFailedRef.current = () => sound.play('sendFailed')
  }, [sound])
  const [seenMessages] = useState(() => new SeenMessages())
  const soundPrefs = useMemo<SoundPreferences>(
    () => ({
      enabled: settings.soundEffects,
      volume: settings.soundVolume,
      events: settings.soundEvents,
      categoryVolumes: settings.soundCategoryVolumes,
      eventVolumes: settings.soundEventVolumes,
      custom: settings.soundCustom,
      pack: settings.soundPack
    }),
    [
      settings.soundEffects,
      settings.soundVolume,
      settings.soundEvents,
      settings.soundCategoryVolumes,
      settings.soundEventVolumes,
      settings.soundCustom,
      settings.soundPack
    ]
  )

  // ---- Appearance (synced preferences + this device's font size) and automatic idle ----
  // Milestone 14: the full-app theme follows your account on servers that support it (API 6);
  // this device keeps a copy so the theme applies instantly at start-up and on older servers.
  const themeKey = useMemo(
    () => localThemeKey(session.httpUrl, session.username),
    [session.httpUrl, session.username]
  )
  const [localTheme, setLocalTheme] = useState<AppThemeId | null>(() => readLocalTheme(themeKey))
  // Picked while this server couldn't save themes: moved to the account once it can.
  const [themeUnsynced, setThemeUnsynced] = useState(() => readThemeUnsynced(themeKey))
  const syncedTheme = backend.preferences.appTheme
  const [customizationSupported, setCustomizationSupported] = useState(false)
  // Milestone 14: private notes about people (shown in profile popouts on servers that keep them).
  const [userNotesSupported, setUserNotesSupported] = useState(false)
  // Once the server's saved choice is known (API 6), it wins over this device's copy.
  const serverTheme: AppThemeId | null | undefined =
    customizationSupported && backend.preferencesLoaded && syncedTheme !== undefined
      ? (appThemeById(syncedTheme)?.id ?? null)
      : undefined
  const appThemeId = resolveAppTheme(serverTheme, localTheme, themeUnsynced)
  // Keep this device's copy in step (instant theme at the next start, and on older servers).
  useEffect(() => {
    writeLocalTheme(themeKey, appThemeId)
  }, [appThemeId, themeKey])
  // Once per start: a theme picked before the server could save it becomes the account's, unless
  // another device has chosen one since. A failed save is retried at the next start (no loop).
  const themeMoveStarted = useRef(false)
  const updatePreferences = backend.updatePreferences
  useEffect(() => {
    if (themeMoveStarted.current) return
    const action = unsyncedThemeAction(serverTheme, localTheme, themeUnsynced)
    if (action === 'wait') return
    themeMoveStarted.current = true
    const settle = (): void => {
      writeThemeUnsynced(themeKey, false)
      setThemeUnsynced(false)
    }
    if (action === 'drop') void Promise.resolve().then(settle)
    else
      void updatePreferences({ appTheme: localTheme }).then((error) => {
        if (!error) settle()
      })
  }, [serverTheme, localTheme, themeUnsynced, themeKey, updatePreferences])
  // A theme being previewed in Settings (undefined = none): shown everywhere until applied/cancelled.
  const [themePreview, setThemePreview] = useState<AppThemeId | null | undefined>(undefined)
  const appTheme = appThemeById(themePreview !== undefined ? themePreview : appThemeId)
  const setAppTheme = useCallback(
    async (id: AppThemeId | null): Promise<string | null> => {
      setLocalTheme(id)
      writeLocalTheme(themeKey, id)
      writeThemeUnsynced(themeKey, !customizationSupported)
      setThemeUnsynced(!customizationSupported)
      if (!customizationSupported) return null
      return backend.updatePreferences({ appTheme: id })
    },
    [backend, customizationSupported, themeKey]
  )
  useAppearance(
    backend.preferences,
    settings.fontSize,
    settings.contrast,
    appTheme,
    settings.themeEffects
  )
  const reducedMotion = useReducedMotion(backend.preferences.reducedMotion)
  // Profile decorations/effects/animated pictures move only if motion is allowed here.
  const profileMotion = !reducedMotion && settings.profileEffects === 'full'
  useIdleDetection(backend.preferences.idleTimeoutMinutes, backend.setIdle)

  // Large downloads go straight to disk through the main process (never through memory).
  const diskDownloads = useMemo<DiskDownloads>(
    () => ({
      urlFor: (id) => backend.api.attachmentDownload(id)?.url ?? null,
      start: async (id) => {
        const target = backend.api.attachmentDownload(id)
        const bridge = window.d2?.downloads
        if (!target || !bridge) return false
        return bridge.start(target.url, target.authorization)
      }
    }),
    [backend.api]
  )

  // ---- Server features from /api/meta: GIF picker and large files (when set up there) ----
  const [serverFeatures, setServerFeatures] = useState<{
    gifs: GifSupport | null
    largeFiles: LargeFileSupport | null
  }>({ gifs: null, largeFiles: null })
  const gifSupport = serverFeatures.gifs
  // Asked again after every (re)connection: the first try may have failed while the server was
  // restarting, and an administrator may have switched a feature on or off since.
  const gatewayConnected = backend.gateway.status === 'connected'
  const { fetchSaved } = backend
  useEffect(() => {
    if (!gatewayConnected) return
    let cancelled = false
    backend.api
      .meta()
      .then((meta) => {
        if (cancelled) return
        setServerFeatures({ gifs: meta.gifs ?? null, largeFiles: meta.largeFiles ?? null })
        setCustomizationSupported(meta.customization === true)
        // Milestone 14: private saved messages (the bookmark buttons appear once loaded).
        if (meta.savedMessages === true) void fetchSaved().catch(() => undefined)
        setUserNotesSupported(meta.userNotes === true)
        setCameraSupported(meta.camera === true)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [backend.api, gatewayConnected, fetchSaved])

  // ---- Uploads: owned by the workspace, so switching channels never cancels one ----
  const uploadDepsRef = useRef<UploadManagerDeps | null>(null)
  const [uploadManager] = useState(() => new UploadManager(() => uploadDepsRef.current!))
  const largeUploadStore = useMemo(
    () => localLargeUploadStore(largeUploadsKey(session.httpUrl, session.username)),
    [session.httpUrl, session.username]
  )
  const largeFilesSupport = serverFeatures.largeFiles
  useEffect(() => {
    uploadDepsRef.current = {
      upload: (channelId, file, name, onProgress, signal, resume) => {
        const normalLimit = isImageName(name)
          ? UPLOAD_LIMITS.maxImageBytes
          : (largeFilesSupport?.normalMaxBytes ?? UPLOAD_LIMITS.maxFileBytes)
        if (!largeFilesSupport || !needsLargeUpload(file.size, normalLimit)) {
          return backend.uploadAttachment(channelId, file, name, onProgress, signal)
        }
        // Large files: chunked and resumable, streamed from disk by the browser.
        return uploadLargeFile(backend.api, channelId, file, name, {
          onProgress,
          signal,
          resumeId: resume.id,
          onSession: resume.onSession
        })
      },
      deleteAttachment: backend.deleteAttachment,
      cancelLargeUpload: (id) => void backend.api.cancelLargeUpload(id).catch(() => undefined),
      describeError,
      isCancelled: (err) => err instanceof UploadAbortedError || err instanceof LargeUploadAborted,
      createPreview: (file) => URL.createObjectURL(file),
      revokePreview: (url) => URL.revokeObjectURL(url),
      store: largeUploadStore,
      // Milestone 14: a failure always sounds; success only for uploads you had to wait for.
      onSettled: (outcome, ms) => {
        if (outcome === 'failed') sound.play('uploadFailed')
        else if (ms > 4000) sound.play('uploadDone')
      }
    }
  })
  // Signing out (or switching account) cancels everything and deletes unsent attachments.
  useEffect(() => () => uploadManager.dispose(), [uploadManager])
  const activeUploads = useSyncExternalStore(uploadManager.subscribe, uploadManager.active)

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
  // Leaving shows at once: you drop out of the channel without waiting for the server's update.
  const leaveVoice = (): void => {
    if (voiceChannelId) backend.forgetOwnVoiceState(voiceChannelId)
    void voice.session.leave()
  }
  const pushToTalkMode = settings.inputMode === 'push-to-talk'
  const ptt = usePushToTalk({
    enabled: pushToTalkMode && voiceActive,
    code: settings.pushToTalkKey,
    global: settings.pushToTalkGlobal
  })
  // Milestone 14: optional push-to-talk cues (off by default), only while connected.
  const pttWasActive = useRef(false)
  useEffect(() => {
    if (pushToTalkMode && voiceStatus === 'connected' && ptt.active !== pttWasActive.current) {
      sound.play(ptt.active ? 'pttOn' : 'pttOff')
    }
    pttWasActive.current = ptt.active
  }, [ptt.active, pushToTalkMode, voiceStatus, sound])
  // Milestone 14: soundboard clips played in your voice channel (not while you're deafened).
  useEffect(() => {
    soundboardRef.current = (event) => {
      if (deafened || voiceStatus !== 'connected' || event.channelId !== voice.state.channelId)
        return
      sound.playClip(
        event.soundId,
        () => backend.api.fetchSoundboardAudio(event.soundId),
        settings.soundboardVolume
      )
    }
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
  // Milestone 14: the server of the voice channel you're in (for its soundboard).
  const voiceServer = voiceChannelId
    ? backend.servers.find((s) => s.channels.some((c) => c.id === voiceChannelId))
    : undefined
  const canStream = hasPermission(voicePerms, Permissions.stream)

  // ---- Camera (Milestone 14.5) ----
  const cameraState = voice.state.camera
  const cameraAvailability: CameraAvailability =
    voiceStatus !== 'connected'
      ? { ok: false, reason: 'Join a voice channel to turn on your camera.' }
      : !canStream
        ? { ok: false, reason: 'You don’t have permission to use video in this channel.' }
        : voice.state.cameraAllowed === false
          ? {
              ok: false,
              reason:
                cameraSupported === false
                  ? 'This server doesn’t support cameras yet (it needs the Discord 2.0 v1.4 server update).'
                  : 'Cameras aren’t allowed in this voice channel.'
            }
          : { ok: true }
  const toggleCamera = (): void => {
    if (cameraState.status === 'on' || cameraState.status === 'starting') {
      void voice.session.stopCamera()
      return
    }
    if (!cameraAvailability.ok) {
      setNotice(cameraAvailability.reason ?? 'Camera unavailable.')
      return
    }
    // Show the call view so you can see what you're sending.
    setStageOpen(true)
    void voice.session.startCamera()
  }
  const camerasOn = voice.state.participants.filter((p) => p.cameraOn).length
  const updateOverlay = useCallback(
    (patch: Partial<OverlaySettings>) =>
      setSettings((current) => ({ ...current, overlay: { ...current.overlay, ...patch } })),
    []
  )
  const toggleOverlay = (): void => {
    const enabled = !settings.overlay.enabled
    updateOverlay({ enabled })
    if (enabled) setOverlayHidden(false)
    else setOverlayEditing(false)
  }
  // Leaving voice closes the video view and ends any overlay edit mode (not an arrange session).
  // Adjusted while rendering (React's pattern for reacting to a changed value) rather than in an
  // effect, so there's no extra render with stale state.
  const [wasVoiceActive, setWasVoiceActive] = useState(voiceActive)
  if (wasVoiceActive !== voiceActive) {
    setWasVoiceActive(voiceActive)
    if (!voiceActive) {
      setStageOpen(false)
      if (!overlayArranging) setOverlayEditing(false)
    }
  }
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
        customStatus: isSelf ? selfCustomStatus : u.customStatus,
        profileStyle: u.profileStyle ?? null,
        avatarAnimated: u.avatarAnimated === true,
        bannerAnimated: u.bannerAnimated === true
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
  const mentionsByServer = useMemo(() => {
    const out: Record<string, number> = {}
    for (const s of servers) {
      let total = 0
      for (const c of s.categories)
        for (const ch of c.channels) total += backend.mentionCounts[ch.id] ?? 0
      if (total > 0) out[s.id] = total
    }
    return out
  }, [servers, backend.mentionCounts])

  const voiceNames = findVoiceConnection(servers, voiceChannelId)
  // Live voice telemetry for the connection panel: every 5 s, every 2 s with details open.
  const [connectionDetailsOpen, setConnectionDetailsOpen] = useState(false)
  const connectionStats = useConnectionStats(
    voice.session,
    voice.state.status === 'connected',
    connectionDetailsOpen ? 2000 : 5000
  )
  const voiceConnection: VoiceConnection | null = voiceNames
    ? {
        ...voiceNames,
        status: voiceStatus,
        error: voice.state.error,
        micError: voice.state.micError,
        deviceNotice: voice.state.deviceNotice,
        retryInMs: voice.state.retryInMs,
        quality: voice.state.connectionQuality,
        stats: connectionStats,
        detailsOpen: connectionDetailsOpen,
        onToggleDetails: () => setConnectionDetailsOpen((open) => !open),
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
      if (p.isLocal)
        return { speaking: p.speaking, muted: muted || deafened, deafened, camera: p.cameraOn }
      return {
        speaking: p.speaking,
        muted: !p.micEnabled,
        deafened: p.deafened,
        camera: p.cameraOn
      }
    },
    [voice.state.participants, muted, deafened]
  )

  /** A call participant as a video tile shows them (name, avatar, speaking, mute state). */
  const tilePerson = useCallback(
    (p: VoiceParticipant): TilePerson => {
      const user = resolveUser(p.identity)
      return {
        identity: p.identity,
        name: user.name,
        avatarColor: user.avatarColor,
        avatarId: user.avatarId,
        isLocal: p.isLocal,
        speaking: p.speaking,
        muted: p.isLocal ? muted || deafened : !p.micEnabled,
        deafened: p.isLocal ? deafened : p.deafened
      }
    },
    [resolveUser, muted, deafened]
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
    setGameOpen(false)
    setViewerMode((mode) => (mode === 'focus' ? 'mini' : mode))
    setVisits((v) => pushVisit(v, channelId))
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
      // Clicking the channel you're already in opens its video view (Milestone 14.5).
      if (channel.id === voiceChannelId && voiceStatus === 'connected') {
        setStageOpen(true)
        if (watching) setViewerMode('mini')
        return
      }
      void voice.session.join(channel.id)
      return
    }
    // Opening a channel doesn't mark it read; the chat panel does that once the newest
    // messages are actually on screen in a focused window.
    setActiveChannelByServer((prev) => ({ ...prev, [activeServer.id]: channel.id }))
    setVisits((v) => pushVisit(v, channel.id))
    // Keep watching in a mini player while reading chat.
    if (watching) setViewerMode('mini')
  }

  // ---- Quick switcher (Ctrl+K) ----
  const switchItems = useMemo((): SwitchItem[] => {
    const out: SwitchItem[] = []
    for (const s of servers) {
      out.push({
        id: `server:${s.id}`,
        kind: 'server',
        name: s.name,
        context: 'Server',
        serverId: s.id
      })
      for (const c of s.categories) {
        for (const ch of c.channels) {
          out.push({
            id: ch.id,
            kind: ch.type === 'voice' ? 'voice' : 'text',
            name: ch.name,
            context: s.name,
            serverId: s.id,
            unread: ch.type === 'text' && backend.unread.has(ch.id)
          })
        }
      }
    }
    for (const conv of Object.values(backend.conversations)) {
      out.push({
        id: conv.id,
        kind: conv.kind === 'dm' ? 'dm' : 'group',
        name: conversationTitle(conv, backend.users, selfId ?? ''),
        context: conv.kind === 'dm' ? 'Direct message' : 'Group',
        unread: backend.unread.has(conv.id)
      })
    }
    return out
  }, [servers, backend.conversations, backend.users, backend.unread, selfId])

  const openSwitchItem = (item: SwitchItem): void => {
    setQuickSwitchOpen(false)
    if (item.kind === 'dm' || item.kind === 'group') {
      openConversation(item.id)
      return
    }
    if (!item.serverId) return
    setActiveServerId(item.serverId)
    if (item.kind === 'text') {
      setActiveChannelByServer((prev) => ({ ...prev, [item.serverId!]: item.id }))
      setVisits((v) => pushVisit(v, item.id))
      setViewerMode((mode) => (mode === 'focus' ? 'mini' : mode))
    } else if (item.kind === 'voice') {
      const channel = servers
        .find((s) => s.id === item.serverId)
        ?.categories.flatMap((c) => c.channels)
        .find((c) => c.id === item.id)
      if (channel && !hasPermission(channel.permissions, Permissions.connect)) {
        setNotice(`You don’t have permission to join ${channel.name}.`)
        return
      }
      void voice.session.join(item.id)
    }
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
    if (!goToChannel(channelId)) return
    setJumpTarget((prev) => ({ channelId, messageId, seq: (prev?.seq ?? 0) + 1 }))
  }, [])

  /** Shows a channel or conversation by id; false if it isn't one you can open. */
  function goToChannel(channelId: string): boolean {
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
      return false
    }
    setViewerMode((mode) => (mode === 'focus' ? 'mini' : mode))
    return true
  }

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
      // Server channels follow the server's notification level (or your choice for it).
      const inServer = conversation
        ? undefined
        : servers.find((s) =>
            s.categories.some((c) => c.channels.some((ch) => ch.id === m.channelId))
          )
      const mentionsOnly =
        inServer !== undefined &&
        effectiveNotificationLevel(
          settings.serverNotifications[inServer.id],
          inServer.defaultNotifications
        ) === 'mentions'
      const wantedSound = messageSound(
        m,
        {
          meId: backend.me?.id,
          doNotDisturb: statusPreference === 'dnd',
          mutedChannels: settings.mutedChannels,
          activeChannelId: viewChannelId,
          windowFocused,
          mentionsMe,
          mentionsOnly,
          // Milestone 14: one-to-one conversations have their own sound (groups use the
          // message chime, which coalesces in busy chats).
          isDirect: conversation?.kind === 'dm'
        },
        soundPrefs
      )
      const played = wantedSound ? sound.play(wantedSound) : 'skipped'
      // Milestone 14: blink the taskbar button for mentions and direct messages while unfocused.
      if ((wantedSound === 'mention' || wantedSound === 'directMessage') && !windowFocused) {
        attentionFlashRef.current = true
      }

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
          windowFocused,
          mentionsOnly,
          mentionsMe
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
        // Milestone 14: also restores a minimized or tray-hidden window.
        void window.d2?.lifecycle?.showWindow()
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

  // Milestone 14: taskbar overlay dot for unread mentions, direct messages and friend requests
  // (and a flash for new mentions/DMs while the window isn't focused). Before any early return.
  const attentionCount =
    pendingRequestCount(backend.relationships) +
    Object.keys(backend.conversations).reduce(
      (sum, id) => sum + (id === viewChannelId ? 0 : (unreadCounts[id] ?? 0)),
      0
    ) +
    Object.values(mentionsByServer).reduce((a, b) => a + b, 0)
  useEffect(() => {
    const flash = attentionFlashRef.current
    attentionFlashRef.current = false
    void window.d2?.lifecycle?.attention(attentionCount, flash)
  }, [attentionCount])

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

  // ---- Keyboard shortcuts (Settings → Keybinds) ----
  const moveChannel = (step: 1 | -1): void => {
    if (homeActive) {
      const list = sortConversations(Object.values(backend.conversations))
      const index = list.findIndex((c) => c.id === activeConversation?.id)
      const next = list[Math.min(list.length - 1, Math.max(0, index + step))]
      if (next) openConversation(next.id)
      return
    }
    if (!activeServer) return
    const text = activeServer.categories.flatMap((c) => c.channels).filter((c) => c.type === 'text')
    const index = text.findIndex((c) => c.id === activeChannel?.id)
    const next = text[Math.min(text.length - 1, Math.max(0, index + step))]
    if (next && next.id !== activeChannel?.id) selectChannel(next)
  }
  const moveServer = (step: 1 | -1): void => {
    const order = [HOME_ID, ...servers.map((s) => s.id)]
    const index = order.indexOf(homeActive ? HOME_ID : (activeServer?.id ?? HOME_ID))
    const next = order[Math.min(order.length - 1, Math.max(0, index + step))]
    if (next) setActiveServerId(next)
  }
  const shortcutStatus = useKeybinds(keybinds, {
    // Like the user panel buttons: mute and deafen work in or out of a voice channel.
    toggleMute,
    toggleDeafen,
    leaveVoice: () => voiceActive && leaveVoice(),
    toggleScreenShare: () => {
      if (!voiceActive) return
      if (selfSharing) {
        void voice.session.stopScreenShare()
        return
      }
      if (!canStream) {
        setNotice('You don’t have permission to stream in this channel.')
        return
      }
      setPickerOpen(true)
    },
    toggleCamera: () => {
      if (voiceActive) toggleCamera()
    },
    // Instant show/hide without touching the call; turns the overlay on if it was off.
    toggleCameraOverlay: () => {
      if (!settings.overlay.enabled) {
        updateOverlay({ enabled: true })
        setOverlayHidden(false)
      } else {
        setOverlayHidden((hidden) => !hidden)
      }
    },
    overlayEditMode: () => {
      if (!settings.overlay.enabled && !overlayArranging) return
      setOverlayHidden(false)
      setOverlayEditing((editing) => !editing)
    },
    quickSwitcher: () => setQuickSwitchOpen(true),
    openSettings: () => openSettings(),
    toggleMembers,
    previousChannel: () => moveChannel(-1),
    nextChannel: () => moveChannel(1),
    previousServer: () => moveServer(-1),
    nextServer: () => moveServer(1)
  })

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
      // Milestone 14: your request was accepted.
      if (type === 'friend' && previous === 'outgoing' && statusPreference !== 'dnd') {
        sound.play('friendAccepted')
      }
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
            void window.d2?.lifecycle?.showWindow()
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
      if (inVoice) leaveVoice()
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
    leaveVoice()
    // Unsent drafts stay private to this account: they don't outlive an explicit sign-out.
    draftsRef.current = {}
    setDrafts({})
    clearDrafts(draftStorageKey)
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
  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    // A theme preview never outlives Settings.
    setThemePreview(undefined)
  }, [])
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

  // Server unreachable at start: retry by itself (2 s, 4 s, 8 s … at most every 30 s).
  const { phase: backendPhase, loadOffline, loadFailures, retryInitialLoad: retryLoad } = backend
  useEffect(() => {
    if (backendPhase !== 'error' || !loadOffline) return
    const delay = Math.min(30_000, 2000 * 2 ** Math.max(0, loadFailures - 1))
    const timer = setTimeout(retryLoad, delay)
    return () => clearTimeout(timer)
  }, [backendPhase, loadOffline, loadFailures, retryLoad])

  // The welcome checklist steps aside while one of its steps has its own dialog open.
  const welcomeVisible = welcome === 'pending' && !settingsOpen && !createServerOpen
  const welcomeProgress = {
    hasAvatar: Boolean(backend.me?.avatarId),
    friendCount: Object.values(backend.relationships).filter(
      (r) => r.type === 'friend' || r.type === 'outgoing'
    ).length,
    serverCount: backend.servers.length
  }

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
        <div className="splash-card" role="status" aria-live="polite">
          {backend.phase === 'error' ? (
            <>
              <h2>
                {backend.loadOffline ? 'Can’t reach Discord 2.0' : 'Couldn’t load your servers'}
              </h2>
              <p>
                {backend.loadOffline
                  ? 'Check your internet connection. Trying again automatically…'
                  : backend.loadError}
              </p>
              <div className="splash-actions">
                <button type="button" className="button primary" onClick={backend.retryInitialLoad}>
                  Try again now
                </button>
                {onOpenConnectionSettings && (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={onOpenConnectionSettings}
                  >
                    Connection settings
                  </button>
                )}
                <button type="button" className="button secondary" onClick={signOut}>
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="spinner" aria-hidden="true" />
              <p>Connecting to Discord 2.0…</p>
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
      decoration={decorationOf(backend.me?.profileStyle)}
      avatarAnimated={backend.me?.avatarAnimated === true}
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
      onDisconnect={leaveVoice}
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
      video={{
        camera: cameraState,
        availability: cameraAvailability,
        cameraCount: camerasOn,
        stageOpen: stageOpen && !(watching && viewerMode === 'focus'),
        overlayEnabled: settings.overlay.enabled,
        onToggleCamera: toggleCamera,
        onDismissCamera: () => voice.session.dismissCameraMessage(),
        onOpenView: () => {
          setStageOpen((open) => !(open && !(watching && viewerMode === 'focus')))
          if (watching) setViewerMode('mini')
        },
        onToggleOverlay: toggleOverlay
      }}
      shareStatus={
        voice.state.screenShare.options ? (
          <ShareHealthNote
            session={voice.session}
            profileId={voice.state.screenShare.options.profileId}
          />
        ) : undefined
      }
      soundboard={
        voiceServer && customizationSupported ? (
          <SoundboardPanel
            api={backend.api}
            serverId={voiceServer.id}
            serverName={voiceServer.name}
            canManage={hasPermission(voiceServer.permissions, Permissions.manageServer)}
            onPreview={(s) => {
              const result = sound.playClip(
                s.id,
                () => backend.api.fetchSoundboardAudio(s.id),
                Math.max(settings.soundboardVolume, 30)
              )
              if (result === 'unavailable') setNotice('Sound couldn’t play right now.')
            }}
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
  // Uploads still running (or failed) in channels other than the one on screen.
  const uploadsElsewhere = activeUploads.filter(
    (u) => u.channelId !== (gameOpen && homeActive ? undefined : chatChannel?.id)
  )
  const uploadLabel = (channelId: string): string | null => {
    for (const s of servers) {
      for (const c of s.categories) {
        const ch = c.channels.find((x) => x.id === channelId)
        if (ch) return `#${ch.name}`
      }
    }
    const conv = backend.conversations[channelId]
    return conv ? conversationTitle(conv, backend.users, selfId) : null
  }
  const sidebarFooter = (
    <>
      <UploadsIndicator
        uploads={uploadsElsewhere}
        labelFor={uploadLabel}
        onOpen={(channelId) => {
          setGameOpen(false)
          goToChannel(channelId)
        }}
        onCancel={(u: ActiveUpload) => uploadManager.remove(u.channelId, u.key)}
      />
      {userPanel}
    </>
  )
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
      <ProfileMotionContext.Provider value={profileMotion}>
        <GifContext.Provider value={gifSupport}>
          <ReducedMotionContext.Provider value={reducedMotion}>
            <DiskDownloadContext.Provider value={diskDownloads}>
              <UploadContext.Provider value={uploadManager}>
                <div
                  className={narrowWindow ? 'app narrow-window' : 'app'}
                  style={
                    {
                      '--sidebar-width': `${clampSidebarWidth(settings.sidebarWidth)}px`
                    } as React.CSSProperties
                  }
                >
                  {appTheme && (
                    <div className="app-ambient" data-ambient={appTheme.ambient} aria-hidden="true">
                      <span className="amb-1" />
                      <span className="amb-2" />
                      <span className="amb-3" />
                    </div>
                  )}
                  <ServerSidebar
                    servers={servers}
                    activeServerId={activeServer?.id ?? null}
                    homeActive={homeActive}
                    homeBadge={homeBadge}
                    onSelectHome={selectHome}
                    unreadServerIds={unreadServerIds}
                    mentionsByServer={mentionsByServer}
                    onSelectServer={selectServer}
                    onAddServer={() => setCreateServerOpen(true)}
                  />

                  {activeServer ? (
                    <ChannelSidebar
                      server={activeServer}
                      activeChannelId={activeChannel?.id ?? ''}
                      unreadChannelIds={backend.unread}
                      unreadCounts={unreadCounts}
                      mentionCounts={backend.mentionCounts}
                      voiceChannelId={voiceChannelId}
                      selfId={selfId}
                      resolveUser={resolveUser}
                      voiceMembers={voiceMembers}
                      voiceDetails={voiceDetails}
                      getUserVolume={(userId) => settings.userVolumes[userId] ?? 100}
                      onUserVolumeChange={(userId, volume) =>
                        updateSettings({
                          userVolumes: { ...settings.userVolumes, [userId]: volume }
                        })
                      }
                      isStreaming={isStreaming}
                      watchingId={watching}
                      onWatch={watchStream}
                      getStreamVolume={(userId) => settings.streamVolumes[userId] ?? 100}
                      onStreamVolumeChange={(userId, volume) =>
                        updateSettings({
                          streamVolumes: { ...settings.streamVolumes, [userId]: volume }
                        })
                      }
                      onSelectChannel={selectChannel}
                      serverActions={serverActions(activeServer)}
                      onCreateChannel={
                        hasPermission(activeServer.permissions ?? 0, Permissions.manageChannels)
                          ? (category) =>
                              setCreateChannelIn({
                                serverId: activeServer.id,
                                category: category.name,
                                // Voice-only categories suggest voice; anything else suggests text.
                                type:
                                  category.channels.length > 0 &&
                                  category.channels.every((c) => c.type === 'voice')
                                    ? 'voice'
                                    : 'text'
                              })
                          : undefined
                      }
                      footer={sidebarFooter}
                    />
                  ) : (
                    <HomeSidebar
                      conversations={backend.conversations}
                      loaded={backend.conversationsLoaded}
                      users={backend.users}
                      meId={selfId}
                      activeConversationId={activeConversation?.id ?? null}
                      gameActive={gameOpen && !activeConversation}
                      unreadCounts={unreadCounts}
                      pendingRequests={pendingRequests}
                      resolveUser={resolveUser}
                      onOpenFriends={() => {
                        setGameOpen(false)
                        setActiveConversationId(null)
                      }}
                      onOpenGame={() => {
                        setGameOpen(true)
                        setActiveConversationId(null)
                      }}
                      onOpenConversation={openConversation}
                      onCloseConversation={closeOrLeave}
                      onCreateGroup={() => setGroupDialog({ mode: 'create' })}
                      footer={sidebarFooter}
                    />
                  )}
                  <SidebarResizer
                    width={clampSidebarWidth(settings.sidebarWidth)}
                    onResize={(sidebarWidth) => updateSettings({ sidebarWidth })}
                  />

                  {watching && (
                    // One viewer instance for both modes, so switching focus/mini never remounts the video.
                    <main
                      className={
                        viewerMode === 'focus' ? 'chat-panel stream-main' : 'stream-slot-mini'
                      }
                    >
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
                          updateSettings({
                            streamVolumes: { ...settings.streamVolumes, [watching]: volume }
                          })
                        }
                        onModeChange={setViewerMode}
                        onStopWatching={stopWatching}
                      />
                      {viewerMode === 'focus' && (
                        <CameraStrip
                          session={voice.session}
                          state={voice.state}
                          person={tilePerson}
                          mirror={settings.cameraMirror}
                          hideSelf={settings.cameraHideSelf}
                          onOpenCalls={() => {
                            setStageOpen(true)
                            setViewerMode('mini')
                          }}
                        />
                      )}
                    </main>
                  )}

                  {stageOpen &&
                  voiceStatus === 'connected' &&
                  !(watching && viewerMode === 'focus') ? (
                    <main className="chat-panel call-stage-main">
                      <CallStage
                        session={voice.session}
                        state={voice.state}
                        person={tilePerson}
                        channelName={voiceNames?.channelName ?? 'Voice'}
                        mirror={settings.cameraMirror}
                        hideSelf={settings.cameraHideSelf}
                        overlayEnabled={settings.overlay.enabled}
                        cameraAvailability={cameraAvailability}
                        onToggleCamera={toggleCamera}
                        onToggleHideSelf={() =>
                          updateSettings({ cameraHideSelf: !settings.cameraHideSelf })
                        }
                        onToggleOverlay={toggleOverlay}
                        onWatchStream={(identity) => {
                          setViewerMode('focus')
                          voice.session.watch(identity)
                        }}
                        onClose={() => setStageOpen(false)}
                      />
                    </main>
                  ) : watching && viewerMode === 'focus' ? null : chatChannel ? (
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
                      showMembers={membersVisible}
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
                      onToggleMembers={toggleMembers}
                      onToggleNotificationsMuted={() => toggleChannelMute(chatChannel.id)}
                      onEmojiUsed={useEmoji}
                      onJumpTo={jumpTo}
                      onOpenProfile={openProfile}
                      drafts={drafts}
                      onDraftChange={changeDraft}
                      readOnlyReason={
                        homeActive ? undefined : timeoutNotice(activeServer?.timeoutUntil)
                      }
                      largeFiles={serverFeatures.largeFiles}
                      wallpaper={settings.chatWallpaper}
                      wallpaperIntensity={settings.chatWallpaperIntensity}
                    />
                  ) : homeActive && gameOpen && selfId ? (
                    // Keyed by account so saved games/stats never cross users.
                    <WordGame key={selfId} userId={selfId} />
                  ) : homeActive ? (
                    <FriendsPage
                      key={friendsTabRequest?.n ?? 0}
                      initialTab={friendsTabRequest?.tab}
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
                    <main className="chat-panel empty-state">
                      This server has no text channels yet.
                    </main>
                  )}

                  {membersVisible &&
                    !(watching && viewerMode === 'focus') &&
                    activeServer &&
                    activeChannel && (
                      <MemberList
                        server={activeServer}
                        resolveUser={resolveUser}
                        onOpenProfile={openProfile}
                      />
                    )}

                  {membersVisible &&
                    !(watching && viewerMode === 'focus') &&
                    activeConversation && (
                      <ConversationMembers
                        key={activeConversation.id}
                        conversation={activeConversation}
                        meId={selfId}
                        resolveUser={resolveUser}
                        onOpenProfile={openProfile}
                        onAddPeople={() =>
                          setGroupDialog({ mode: 'add', channelId: activeConversation.id })
                        }
                        onRename={(name) => backend.renameGroup(activeConversation.id, name)}
                        onRemove={(userId) =>
                          backend.removeGroupMember(activeConversation.id, userId)
                        }
                        onLeave={() => closeOrLeave(activeConversation)}
                      />
                    )}

                  {pickerOpen && (
                    <ScreenSharePicker
                      initial={shareDefaults}
                      onGoLive={goLive}
                      onClose={closePicker}
                    />
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
                        leaveVoice()
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
                      shortcutStatus={shortcutStatus}
                      customization={{
                        supported: customizationSupported,
                        appTheme: appThemeId,
                        onAppThemeChange: setAppTheme,
                        onPreviewTheme: setThemePreview
                      }}
                      onArrangeOverlay={() => {
                        closeSettings()
                        setOverlayHidden(false)
                        setOverlayArranging(true)
                        setOverlayEditing(true)
                      }}
                    />
                  )}

                  <CameraOverlay
                    session={voice.session}
                    state={voice.state}
                    person={tilePerson}
                    settings={settings.overlay}
                    mirror={settings.cameraMirror}
                    hidden={overlayHidden}
                    editing={overlayEditing}
                    arranging={overlayArranging}
                    onChange={updateOverlay}
                    onEditDone={() => {
                      setOverlayEditing(false)
                      setOverlayArranging(false)
                    }}
                    onClosed={() => {
                      setOverlayEditing(false)
                      setOverlayArranging(false)
                      // Closed from outside (e.g. Alt+F4): stay hidden until shown again.
                      setOverlayHidden(true)
                    }}
                    onError={setNotice}
                  />

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

                  {createChannelIn && (
                    <CreateChannelModal
                      categoryName={createChannelIn.category}
                      initialType={createChannelIn.type}
                      onClose={() => setCreateChannelIn(null)}
                      onCreate={async (name, type) => {
                        const { serverId, category } = createChannelIn
                        try {
                          const channel = await backend.api.createChannel(serverId, {
                            name,
                            type,
                            category
                          })
                          await backend.refreshServers()
                          setCreateChannelIn(null)
                          // Open a new text channel right away (voice channels wait for a click).
                          if (type === 'text') {
                            setActiveChannelByServer((prev) => ({
                              ...prev,
                              [serverId]: channel.id
                            }))
                          }
                          return null
                        } catch (err) {
                          return describeError(err)
                        }
                      }}
                    />
                  )}

                  {inviteFor && (
                    <InviteModal
                      api={backend.api}
                      serverId={inviteFor}
                      serverName={
                        backend.servers.find((s) => s.id === inviteFor)?.name ?? 'this server'
                      }
                      onClose={closeInvite}
                    />
                  )}

                  {quickSwitchOpen && (
                    <QuickSwitcher
                      items={switchItems}
                      recent={visits}
                      onSelect={openSwitchItem}
                      onClose={() => setQuickSwitchOpen(false)}
                    />
                  )}

                  {welcomeVisible && backend.me && (
                    <WelcomeModal
                      displayName={backend.me.displayName}
                      progress={welcomeProgress}
                      onSaveDisplayName={backend.updateDisplayName}
                      onChoosePicture={() => openSettings('profile')}
                      onAddFriends={() => {
                        setWelcome('done')
                        setActiveServerId(HOME_ID)
                        setActiveConversationId(null)
                        setFriendsTabRequest((r) => ({ tab: 'add', n: (r?.n ?? 0) + 1 }))
                      }}
                      onJoinServer={() => setCreateServerOpen(true)}
                      onClose={() => setWelcome('done')}
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
                      note={
                        userNotesSupported && popout.userId !== selfId
                          ? {
                              value: backend.notes[popout.userId],
                              load: backend.fetchNote,
                              save: backend.saveNote
                            }
                          : undefined
                      }
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
              </UploadContext.Provider>
            </DiskDownloadContext.Provider>
          </ReducedMotionContext.Provider>
        </GifContext.Provider>
      </ProfileMotionContext.Provider>
    </ProfileMediaContext.Provider>
  )
}

export default Workspace
