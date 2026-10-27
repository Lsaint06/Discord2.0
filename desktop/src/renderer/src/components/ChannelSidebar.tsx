import { useState, type ReactNode } from 'react'
import type { Channel, Server, User } from '../types'
import Avatar from './Avatar'
import { ChevronDownIcon, HashIcon, HeadphonesIcon, MicIcon, SpeakerIcon } from './Icons'

export interface VoiceUserDetails {
  speaking: boolean
  muted: boolean
  deafened: boolean
}

interface ChannelSidebarProps {
  server: Server
  activeChannelId: string
  unreadChannelIds: Set<string>
  /** Unread message counts per channel (shown as a badge). */
  unreadCounts?: Record<string, number>
  /** Voice channel we're in (or joining), if any. */
  voiceChannelId: string | null
  selfId: string
  resolveUser: (id: string) => User
  /** User ids currently in a voice channel. */
  voiceMembers: (channelId: string) => string[]
  /** Live details for users in our current voice room (undefined elsewhere). */
  voiceDetails: (userId: string) => VoiceUserDetails | undefined
  getUserVolume: (userId: string) => number
  onUserVolumeChange: (userId: string, volume: number) => void
  /** Users currently screen sharing (from the backend, so visible outside the room too). */
  isStreaming: (userId: string) => boolean
  /** Identity whose stream is being watched. */
  watchingId: string | null
  onWatch: (userId: string, channel: Channel) => void
  getStreamVolume: (userId: string) => number
  onStreamVolumeChange: (userId: string, volume: number) => void
  onSelectChannel: (channel: Channel) => void
  footer: ReactNode
}

function ChannelSidebar({
  server,
  activeChannelId,
  unreadChannelIds,
  unreadCounts,
  voiceChannelId,
  selfId,
  resolveUser,
  voiceMembers,
  voiceDetails,
  getUserVolume,
  onUserVolumeChange,
  isStreaming,
  watchingId,
  onWatch,
  getStreamVolume,
  onStreamVolumeChange,
  onSelectChannel,
  footer
}: ChannelSidebarProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [volumeFor, setVolumeFor] = useState<string | null>(null)

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
                  const participants = channel.type === 'voice' ? voiceMembers(channel.id) : []

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
                        {unread && !active && (unreadCounts?.[channel.id] ?? 0) > 0 ? (
                          <span
                            className="unread-badge"
                            aria-label={`${unreadCounts![channel.id]} unread`}
                          >
                            {unreadCounts![channel.id] >= 99 ? '99+' : unreadCounts![channel.id]}
                          </span>
                        ) : (
                          unread && !active && <span className="unread-dot" />
                        )}
                      </button>

                      {participants.length > 0 && (
                        <ul className="voice-users">
                          {participants.map((userId) => {
                            const user = resolveUser(userId)
                            const isSelf = userId === selfId
                            const details = connected ? voiceDetails(userId) : undefined
                            const canAdjust = connected && !isSelf && details !== undefined
                            const volume = getUserVolume(userId)
                            const live = isStreaming(userId)
                            const watched = watchingId === userId
                            return (
                              <li key={userId} className="voice-user-row">
                                <button
                                  type="button"
                                  className={`voice-user${canAdjust ? ' adjustable' : ''}`}
                                  onClick={() =>
                                    canAdjust && setVolumeFor((v) => (v === userId ? null : userId))
                                  }
                                  aria-expanded={canAdjust ? volumeFor === userId : undefined}
                                  title={canAdjust ? `Adjust ${user.name}'s volume` : user.name}
                                >
                                  <span
                                    className={`voice-avatar${details?.speaking ? ' speaking' : ''}`}
                                  >
                                    <Avatar name={user.name} color={user.avatarColor} size={22} />
                                  </span>
                                  <span className="voice-user-name">{user.name}</span>
                                  {(details?.muted || details?.deafened) && (
                                    <span className="voice-user-flags">
                                      {details.muted && <MicIcon size={14} slashed />}
                                      {details.deafened && <HeadphonesIcon size={14} slashed />}
                                    </span>
                                  )}
                                </button>
                                {live && (
                                  <button
                                    type="button"
                                    className={`live-badge clickable${watched ? ' watching' : ''}`}
                                    onClick={() => onWatch(userId, channel)}
                                    title={
                                      watched
                                        ? `Watching ${user.name}`
                                        : isSelf
                                          ? 'Preview your stream'
                                          : connected
                                            ? `Watch ${user.name}'s stream`
                                            : `Join ${channel.name} and watch ${user.name}`
                                    }
                                    aria-label={`Watch ${user.name}'s stream`}
                                  >
                                    LIVE
                                  </button>
                                )}
                                {canAdjust && volumeFor === userId && (
                                  <div className="voice-user-volume">
                                    <label>
                                      <span>Volume {volume}%</span>
                                      <input
                                        className="slider"
                                        type="range"
                                        min={0}
                                        max={200}
                                        step={5}
                                        value={volume}
                                        onChange={(e) =>
                                          onUserVolumeChange(userId, Number(e.target.value))
                                        }
                                        aria-label={`${user.name} volume`}
                                      />
                                    </label>
                                    {live && (
                                      <label>
                                        <span>Stream volume {getStreamVolume(userId)}%</span>
                                        <input
                                          className="slider"
                                          type="range"
                                          min={0}
                                          max={200}
                                          step={5}
                                          value={getStreamVolume(userId)}
                                          onChange={(e) =>
                                            onStreamVolumeChange(userId, Number(e.target.value))
                                          }
                                          aria-label={`${user.name} stream volume`}
                                        />
                                      </label>
                                    )}
                                  </div>
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
