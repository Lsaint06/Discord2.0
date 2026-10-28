import { useState, type ReactNode } from 'react'
import type { User } from '../../types'
import type { ApiConversation, ApiUser } from '../../net/protocol'
import { conversationTitle, dmPartnerId, sortConversations } from '../../chat/conversations'
import Avatar from '../Avatar'
import { CloseIcon, FriendsIcon, PlusIcon } from '../Icons'

interface HomeSidebarProps {
  conversations: Record<string, ApiConversation>
  loaded: boolean
  users: Record<string, ApiUser>
  meId: string
  /** null = the Friends page. */
  activeConversationId: string | null
  unreadCounts: Record<string, number>
  pendingRequests: number
  resolveUser: (id: string) => User
  onOpenFriends: () => void
  onOpenConversation: (id: string) => void
  onCloseConversation: (conversation: ApiConversation) => void
  onCreateGroup: () => void
  footer: ReactNode
}

function badge(count: number): string {
  return count >= 99 ? '99+' : String(count)
}

/** The Home column: Friends, then your direct and group conversations (newest activity first). */
function HomeSidebar(props: HomeSidebarProps): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const list = sortConversations(Object.values(props.conversations)).filter((c) => {
    const q = filter.trim().toLowerCase()
    return !q || conversationTitle(c, props.users, props.meId).toLowerCase().includes(q)
  })

  return (
    <aside className="channel-sidebar home-sidebar" aria-label="Direct messages">
      <header className="channel-sidebar-header home-search">
        <input
          type="search"
          className="text-input"
          placeholder="Find a conversation"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Find a conversation"
        />
      </header>

      <div className="channel-scroller">
        <button
          type="button"
          className={`channel-item home-nav${props.activeConversationId === null ? ' active' : ''}`}
          onClick={props.onOpenFriends}
          aria-current={props.activeConversationId === null ? 'page' : undefined}
        >
          <FriendsIcon size={20} className="channel-icon" />
          <span className="channel-name">Friends</span>
          {props.pendingRequests > 0 && (
            <span
              className="unread-badge"
              aria-label={`${props.pendingRequests} pending friend requests`}
            >
              {badge(props.pendingRequests)}
            </span>
          )}
        </button>

        <div className="home-section-header">
          <span>Direct Messages</span>
          <button
            type="button"
            className="icon-button small"
            onClick={props.onCreateGroup}
            aria-label="Create a group"
            title="Create a group"
          >
            <PlusIcon size={16} />
          </button>
        </div>

        {!props.loaded && <p className="home-empty">Loading conversations…</p>}
        {props.loaded && list.length === 0 && (
          <p className="home-empty">
            {filter
              ? 'No conversations match.'
              : 'No conversations yet. Message a friend to start one.'}
          </p>
        )}

        <ul className="conversation-list">
          {list.map((c) => {
            const active = c.id === props.activeConversationId
            const unread = active ? 0 : (props.unreadCounts[c.id] ?? 0)
            const title = conversationTitle(c, props.users, props.meId)
            const partner = c.kind === 'dm' ? dmPartnerId(c, props.meId) : undefined
            const user = partner ? props.resolveUser(partner) : undefined
            return (
              <li key={c.id} className="conversation-row">
                <button
                  type="button"
                  className={`conversation-item${active ? ' active' : ''}${unread > 0 ? ' unread' : ''}`}
                  onClick={() => props.onOpenConversation(c.id)}
                  aria-current={active ? 'page' : undefined}
                >
                  {user ? (
                    <Avatar
                      name={user.name}
                      color={user.avatarColor}
                      imageId={user.avatarId}
                      size={32}
                      status={user.status}
                      ringColor="var(--bg-secondary)"
                    />
                  ) : (
                    <span className="group-avatar" aria-hidden="true">
                      <FriendsIcon size={18} />
                    </span>
                  )}
                  <span className="conversation-text">
                    <span className="conversation-name">{title}</span>
                    {c.kind === 'group' && (
                      <span className="conversation-sub">{c.memberIds.length} members</span>
                    )}
                  </span>
                  {unread > 0 && (
                    <span className="unread-badge" aria-label={`${unread} unread`}>
                      {badge(unread)}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="icon-button small conversation-close"
                  onClick={() => props.onCloseConversation(c)}
                  aria-label={
                    c.kind === 'dm' ? `Close conversation with ${title}` : `Leave ${title}`
                  }
                  title={c.kind === 'dm' ? 'Close' : 'Leave group'}
                >
                  <CloseIcon size={14} />
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      {props.footer}
    </aside>
  )
}

export default HomeSidebar
