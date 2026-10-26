import { useCallback, useMemo, useState } from 'react'
import type { Channel, Message, Server, User, UserSettings } from './types'
import {
  CURRENT_USER_ID,
  defaultChannelByServer,
  defaultSettings,
  initialMessages,
  initialServers,
  initialUnread,
  users
} from './data/mockData'
import { presenceFromSetting, statusLabels } from './lib/format'
import ServerSidebar from './components/ServerSidebar'
import ChannelSidebar from './components/ChannelSidebar'
import ChatPanel from './components/ChatPanel'
import MemberList from './components/MemberList'
import UserPanel from './components/UserPanel'
import SettingsPanel from './components/SettingsPanel'
import CreateServerModal from './components/CreateServerModal'

const EMPTY_MESSAGES: Message[] = []

function firstTextChannel(server: Server): Channel | undefined {
  return server.categories.flatMap((c) => c.channels).find((ch) => ch.type === 'text')
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
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

function App(): React.JSX.Element {
  const [servers, setServers] = useState<Server[]>(initialServers)
  const [messages, setMessages] = useState<Record<string, Message[]>>(initialMessages)
  const [activeServerId, setActiveServerId] = useState(initialServers[0].id)
  const [activeChannelByServer, setActiveChannelByServer] = useState<Record<string, string>>(
    () => ({ ...defaultChannelByServer })
  )
  const [unread, setUnread] = useState<Set<string>>(() => new Set(initialUnread))
  const [voiceChannelId, setVoiceChannelId] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  const [showMembers, setShowMembers] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createServerOpen, setCreateServerOpen] = useState(false)
  const [settings, setSettings] = useState<UserSettings>(defaultSettings)

  const displayName = settings.displayName.trim() || 'You'
  const selfStatus = presenceFromSetting(settings.status)

  const resolveUser = useCallback(
    (id: string): User => {
      if (id === CURRENT_USER_ID) {
        return {
          ...users.me,
          name: displayName,
          avatarColor: settings.accentColor,
          status: selfStatus,
          activity: settings.customStatus || undefined
        }
      }
      return users[id] ?? { id, name: 'Unknown User', avatarColor: '#5c5f66', status: 'offline' }
    },
    [displayName, selfStatus, settings.accentColor, settings.customStatus]
  )

  const activeServer = servers.find((s) => s.id === activeServerId) ?? servers[0]
  const activeChannel =
    activeServer.categories
      .flatMap((c) => c.channels)
      .find((c) => c.id === activeChannelByServer[activeServer.id]) ??
    firstTextChannel(activeServer)

  const roleColor = useCallback(
    (userId: string): string | undefined => {
      const roleId = activeServer.members.find((m) => m.userId === userId)?.roleId
      return activeServer.roles.find((r) => r.id === roleId)?.color
    },
    [activeServer]
  )

  const unreadServerIds = useMemo(
    () =>
      new Set(
        servers
          .filter((s) => s.categories.some((c) => c.channels.some((ch) => unread.has(ch.id))))
          .map((s) => s.id)
      ),
    [servers, unread]
  )

  const voiceConnection = findVoiceConnection(servers, voiceChannelId)

  const markRead = (channelId: string): void => {
    setUnread((prev) => {
      if (!prev.has(channelId)) return prev
      const next = new Set(prev)
      next.delete(channelId)
      return next
    })
  }

  const selectServer = (serverId: string): void => {
    setActiveServerId(serverId)
    const server = servers.find((s) => s.id === serverId)
    const channelId = activeChannelByServer[serverId] || (server && firstTextChannel(server)?.id)
    if (channelId) markRead(channelId)
  }

  const selectChannel = (channel: Channel): void => {
    if (channel.type === 'voice') {
      setVoiceChannelId(channel.id)
      return
    }
    setActiveChannelByServer((prev) => ({ ...prev, [activeServer.id]: channel.id }))
    markRead(channel.id)
  }

  const sendMessage = (content: string): void => {
    if (!activeChannel) return
    const channelId = activeChannel.id
    const message: Message = {
      id: makeId('msg'),
      channelId,
      authorId: CURRENT_USER_ID,
      content,
      timestamp: Date.now()
    }
    setMessages((prev) => ({ ...prev, [channelId]: [...(prev[channelId] ?? []), message] }))
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

  const createServer = (name: string, color: string): void => {
    const id = makeId('server')
    const server: Server = {
      id,
      name,
      color,
      roles: [{ id: `${id}-owner`, name: 'Owner', color }],
      members: [{ userId: CURRENT_USER_ID, roleId: `${id}-owner` }],
      categories: [
        {
          id: `${id}-text`,
          name: 'Text Channels',
          channels: [
            { id: `${id}-general`, name: 'general', type: 'text', topic: `Welcome to ${name}!` }
          ]
        },
        {
          id: `${id}-voice`,
          name: 'Voice Channels',
          channels: [{ id: `${id}-lounge`, name: 'Lounge', type: 'voice', voiceUsers: [] }]
        }
      ]
    }
    setServers((prev) => [...prev, server])
    setActiveChannelByServer((prev) => ({ ...prev, [id]: `${id}-general` }))
    setActiveServerId(id)
    setCreateServerOpen(false)
  }

  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const closeCreateServer = useCallback(() => setCreateServerOpen(false), [])
  const updateSettings = useCallback(
    (patch: Partial<UserSettings>) => setSettings((prev) => ({ ...prev, ...patch })),
    []
  )

  const appStyle = {
    '--accent': settings.accentColor,
    '--chat-font-size': `${settings.fontSize}px`
  } as React.CSSProperties

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
        unreadChannelIds={unread}
        voiceChannelId={voiceChannelId}
        selfMuted={muted}
        selfDeafened={deafened}
        resolveUser={resolveUser}
        onSelectChannel={selectChannel}
        footer={
          <UserPanel
            displayName={displayName}
            avatarColor={settings.accentColor}
            status={selfStatus}
            statusText={settings.customStatus || statusLabels[settings.status]}
            muted={muted}
            deafened={deafened}
            voice={voiceConnection}
            onToggleMute={toggleMute}
            onToggleDeafen={toggleDeafen}
            onOpenSettings={() => setSettingsOpen(true)}
            onDisconnect={() => setVoiceChannelId(null)}
          />
        }
      />

      {activeChannel ? (
        <ChatPanel
          channel={activeChannel}
          messages={messages[activeChannel.id] ?? EMPTY_MESSAGES}
          selfName={displayName}
          showMembers={showMembers}
          compactMode={settings.compactMode}
          showTimestamps={settings.showTimestamps}
          resolveUser={resolveUser}
          roleColor={roleColor}
          onToggleMembers={() => setShowMembers((v) => !v)}
          onSendMessage={sendMessage}
        />
      ) : (
        <main className="chat-panel empty-state">This server has no text channels yet.</main>
      )}

      {showMembers && activeChannel && (
        <MemberList server={activeServer} resolveUser={resolveUser} />
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          muted={muted}
          deafened={deafened}
          onChange={updateSettings}
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

export default App
