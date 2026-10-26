import { useState, type ReactNode } from 'react'
import type { Channel, Server, User } from '../types'
import Avatar from './Avatar'
import { ChevronDownIcon, HashIcon, HeadphonesIcon, MicIcon, SpeakerIcon } from './Icons'

interface ChannelSidebarProps {
  server: Server
  activeChannelId: string
  unreadChannelIds: Set<string>
  voiceChannelId: string | null
  selfId: string
  selfMuted: boolean
  selfDeafened: boolean
  resolveUser: (id: string) => User
  onSelectChannel: (channel: Channel) => void
  footer: ReactNode
}

function ChannelSidebar({
  server,
  activeChannelId,
  unreadChannelIds,
  voiceChannelId,
  selfId,
  selfMuted,
  selfDeafened,
  resolveUser,
  onSelectChannel,
  footer
}: ChannelSidebarProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggleCategory = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <aside className="channel-sidebar">
      <header className="channel-sidebar-header">
        <h1 title={server.name}>{server.name}</h1>
        <ChevronDownIcon size={18} />
      </header>

      <div className="channel-scroller">
        {server.categories.map((category) => {
          const isCollapsed = collapsed.has(category.id)
          return (
            <section key={category.id} className="channel-category">
              <button
                type="button"
                className={`category-toggle${isCollapsed ? ' collapsed' : ''}`}
                onClick={() => toggleCategory(category.id)}
                aria-expanded={!isCollapsed}
              >
                <ChevronDownIcon size={12} />
                <span>{category.name}</span>
              </button>

              <ul className="channel-list">
                {category.channels.map((channel) => {
                  const active = channel.id === activeChannelId
                  const unread = unreadChannelIds.has(channel.id)
                  const connected = channel.id === voiceChannelId
                  const participants =
                    channel.type === 'voice'
                      ? [...(channel.voiceUsers ?? []), ...(connected ? [selfId] : [])]
                      : []

                  // Collapsed categories still show the active/connected channel.
                  if (isCollapsed && !active && !connected) return null

                  return (
                    <li key={channel.id}>
                      <button
                        type="button"
                        className={`channel-item${active ? ' active' : ''}${
                          unread && !active ? ' unread' : ''
                        }${connected ? ' connected' : ''}`}
                        onClick={() => onSelectChannel(channel)}
                        title={
                          channel.type === 'voice'
                            ? connected
                              ? `Connected to ${channel.name}`
                              : `Join ${channel.name}`
                            : undefined
                        }
                      >
                        {channel.type === 'text' ? (
                          <HashIcon size={20} className="channel-icon" />
                        ) : (
                          <SpeakerIcon size={20} className="channel-icon" />
                        )}
                        <span className="channel-name">{channel.name}</span>
                        {unread && !active && <span className="unread-dot" />}
                      </button>

                      {participants.length > 0 && (
                        <ul className="voice-users">
                          {participants.map((userId) => {
                            const user = resolveUser(userId)
                            const isSelf = userId === selfId
                            return (
                              <li key={userId} className="voice-user">
                                <Avatar name={user.name} color={user.avatarColor} size={22} />
                                <span className="voice-user-name">{user.name}</span>
                                {isSelf && (selfMuted || selfDeafened) && (
                                  <span className="voice-user-flags">
                                    {selfDeafened ? (
                                      <HeadphonesIcon size={14} slashed />
                                    ) : (
                                      <MicIcon size={14} slashed />
                                    )}
                                  </span>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>

      {footer}
    </aside>
  )
}

export default ChannelSidebar
