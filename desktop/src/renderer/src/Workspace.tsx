import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Channel, ChannelCategory, Server, User, UserSettings } from './types'
import { presenceFromSetting, statusLabels } from './lib/format'
import { loadSettings, saveSettings } from './net/session'
import type { ApiServer, ApiUser } from './net/protocol'
import { useBackend, type BackendSession } from './hooks/useBackend'
import { useVoice } from './hooks/useVoice'
import { usePushToTalk } from './hooks/usePushToTalk'
import { describeKey } from './media/voiceLogic'
import ServerSidebar from './components/ServerSidebar'
import ChannelSidebar, { type VoiceUserDetails } from './components/ChannelSidebar'
import ChatPanel from './components/ChatPanel'
import MemberList from './components/MemberList'
import UserPanel, { type VoiceConnection } from './components/UserPanel'
import SettingsPanel from './components/SettingsPanel'
import CreateServerModal from './components/CreateServerModal'
import ConnectionBanner from './components/ConnectionBanner'
import ScreenSharePicker from './components/ScreenSharePicker'
import StreamViewer, { type ViewerMode } from './components/StreamViewer'
import ShareHealthNote from './components/ShareHealthNote'
import type { ScreenShareOptions, ScreenSource } from './media/ScreenShareController'

const EMPTY_MESSAGES: never[] = []

function toUiServer(server: ApiServer, memberIds: string[]): Server {
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
      topic: ch.topic ?? undefined
    })
  }
  return {
    id: server.id,
    name: server.name,
    color: server.color,
    categories,
    roles: [],
    members: memberIds.map((userId) => ({ userId }))
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
  const [createServerOpen, setCreateServerOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [viewerMode, setViewerMode] = useState<ViewerMode>('focus')

  const handleSessionInvalid = useCallback(
    () => onSignOut('Your session is no longer valid. Please sign in again.'),
    [onSignOut]
  )
  const backend = useBackend(session, {
    initialStatus: settings.status,
    onSessionInvalid: handleSessionInvalid
  })

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  // ---- Voice ----
  const voice = useVoice({ fetchToken: backend.fetchVoiceToken, settings })
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
  useEffect(() => {
    voice.session.setMicState({
      muted,
      deafened,
      pushToTalk: pushToTalkMode,
      pushToTalkActive: ptt.active
    })
  }, [voice.session, muted, deafened, pushToTalkMode, ptt.active])

  const selfId = backend.me?.id ?? ''
  const displayName = backend.me?.displayName ?? session.username
  const selfStatus = presenceFromSetting(settings.status)

  const resolveUser = useCallback(
    (id: string): User => {
      const u: ApiUser | undefined = backend.users[id]
      if (!u) return { id, name: 'Unknown User', avatarColor: '#5c5f66', status: 'offline' }
      const isSelf = id === selfId
      return {
        id: u.id,
        name: u.displayName,
        avatarColor: u.avatarColor,
        bot: u.bot,
        // Our own presence is shown from local settings so it updates instantly.
        status: isSelf ? selfStatus : u.status,
        activity: isSelf ? settings.customStatus || undefined : undefined
      }
    },
    [backend.users, selfId, selfStatus, settings.customStatus]
  )

  const servers = useMemo(() => {
    const memberIds = Object.keys(backend.users)
    return backend.servers.map((s) => toUiServer(s, memberIds))
  }, [backend.servers, backend.users])

  const activeServer = servers.find((s) => s.id === activeServerId) ?? servers[0]
  const activeChannel = activeServer
    ? (activeServer.categories
        .flatMap((c) => c.channels)
        .find((c) => c.id === activeChannelByServer[activeServer.id] && c.type === 'text') ??
      defaultChannel(activeServer))
    : undefined
  const activeChannelId = activeChannel?.id

  const { focusChannel } = backend
  useEffect(() => {
    if (backend.phase === 'ready' && activeChannelId) focusChannel(activeChannelId)
  }, [backend.phase, activeChannelId, focusChannel])

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
    const server = servers.find((s) => s.id === serverId)
    const channelId = activeChannelByServer[serverId] || (server && defaultChannel(server)?.id)
    if (channelId) backend.markRead(channelId)
  }

  const selectChannel = (channel: Channel): void => {
    if (!activeServer) return
    if (channel.type === 'voice') {
      void voice.session.join(channel.id)
      return
    }
    setActiveChannelByServer((prev) => ({ ...prev, [activeServer.id]: channel.id }))
    backend.markRead(channel.id)
    // Keep watching in a mini player while reading chat.
    if (watching) setViewerMode('mini')
  }

  const toggleMute = (): void => {
    // Unmuting while deafened also undeafens, matching common voice-chat behavior.
    if (deafened) {
      setDeafened(false)
      setMuted(false)
    } else {
      setMuted((m) => !m)
    }
  }

  const toggleDeafen = (): void => setDeafened((d) => !d)

  const createServer = async (name: string, color: string): Promise<string | null> => {
    const result = await backend.createServer(name, color)
    if (result.error || !result.server) return result.error ?? 'Could not create server.'
    setActiveServerId(result.server.id)
    setCreateServerOpen(false)
    return null
  }

  const { setPresence } = backend
  const updateSettings = useCallback(
    (patch: Partial<UserSettings>) => {
      setSettings((prev) => ({ ...prev, ...patch }))
      if (patch.status) setPresence(patch.status)
    },
    [setPresence]
  )
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const closeCreateServer = useCallback(() => setCreateServerOpen(false), [])

  const appStyle = {
    '--accent': settings.accentColor,
    '--chat-font-size': `${settings.fontSize}px`
  } as React.CSSProperties

  if (backend.phase !== 'ready' || !activeServer) {
    return (
      <div className="app splash" style={appStyle}>
        <div className="splash-card">
          {backend.phase === 'error' ? (
            <>
              <h2>Couldn&rsquo;t load your servers</h2>
              <p>{backend.loadError}</p>
              <div className="splash-actions">
                <button type="button" className="button primary" onClick={backend.retryInitialLoad}>
                  Try again
                </button>
                <button type="button" className="button secondary" onClick={() => onSignOut()}>
                  Sign out
                </button>
              </div>
            </>
          ) : backend.phase === 'ready' ? (
            <p>This server has no communities yet.</p>
          ) : (
            <>
              <div className="spinner" aria-hidden="true" />
              <p>Connecting to {session.httpUrl}…</p>
            </>
          )}
        </div>
      </div>
    )
  }

  const channelState = activeChannel ? backend.channels[activeChannel.id] : undefined

  return (
    <div className="app" style={appStyle}>
      <ServerSidebar
        servers={servers}
        activeServerId={activeServer.id}
        unreadServerIds={unreadServerIds}
        onSelectServer={selectServer}
        onAddServer={() => setCreateServerOpen(true)}
      />

      <ChannelSidebar
        server={activeServer}
        activeChannelId={activeChannel?.id ?? ''}
        unreadChannelIds={backend.unread}
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
        footer={
          <UserPanel
            displayName={displayName}
            avatarColor={backend.me?.avatarColor ?? settings.accentColor}
            status={selfStatus}
            statusText={settings.customStatus || statusLabels[settings.status]}
            muted={muted}
            deafened={deafened}
            voice={voiceConnection}
            onToggleMute={toggleMute}
            onToggleDeafen={toggleDeafen}
            onOpenSettings={() => setSettingsOpen(true)}
            onDisconnect={() => void voice.session.leave()}
            onRetryVoice={() => voice.session.retry()}
            onOpenMicSettings={
              window.d2 ? () => void window.d2?.media.openMicrophoneSettings() : undefined
            }
            onShareScreen={() => {
              voice.session.dismissScreenShareMessage()
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
        }
      />

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

      {watching && viewerMode === 'focus' ? null : activeChannel ? (
        <ChatPanel
          channel={activeChannel}
          messages={channelState?.messages ?? EMPTY_MESSAGES}
          loaded={channelState?.loaded ?? false}
          loadError={channelState?.error}
          hasMore={channelState?.hasMore ?? false}
          loadingOlder={channelState?.loadingOlder ?? false}
          banner={
            <ConnectionBanner
              status={backend.gateway.status}
              retryInMs={backend.gateway.retryInMs}
            />
          }
          selfName={displayName}
          showMembers={showMembers}
          compactMode={settings.compactMode}
          showTimestamps={settings.showTimestamps}
          resolveUser={resolveUser}
          roleColor={roleColor}
          onToggleMembers={() => setShowMembers((v) => !v)}
          onSendMessage={(content) => backend.sendMessage(activeChannel.id, content)}
          onLoadOlder={() => void backend.loadOlder(activeChannel.id)}
          onReload={() => backend.reloadChannel(activeChannel.id)}
          onRetryMessage={(nonce) => backend.retryMessage(activeChannel.id, nonce)}
          onDiscardMessage={(nonce) => backend.discardMessage(activeChannel.id, nonce)}
        />
      ) : (
        <main className="chat-panel empty-state">This server has no text channels yet.</main>
      )}

      {showMembers && activeChannel && !(watching && viewerMode === 'focus') && (
        <MemberList server={activeServer} resolveUser={resolveUser} />
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
          displayName={displayName}
          username={backend.me?.username ?? session.username}
          avatarColor={backend.me?.avatarColor ?? settings.accentColor}
          serverUrl={session.httpUrl}
          muted={muted}
          deafened={deafened}
          onChange={updateSettings}
          onSaveDisplayName={backend.updateDisplayName}
          onLogout={() => onSignOut()}
          onToggleMute={toggleMute}
          onToggleDeafen={toggleDeafen}
          onClose={closeSettings}
        />
      )}

      {createServerOpen && (
        <CreateServerModal onCreate={createServer} onClose={closeCreateServer} />
      )}
    </div>
  )
}

export default Workspace
