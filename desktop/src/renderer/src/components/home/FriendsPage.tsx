import { useState, type ReactNode } from 'react'
import type { User } from '../../types'
import type { ApiUser } from '../../net/protocol'
import {
  matchesUser,
  relationshipsOfType,
  sortFriends,
  type Relationships
} from '../../chat/conversations'
import Avatar from '../Avatar'
import { CustomStatusText } from '../profile/ProfileCard'
import { BlockIcon, ChatBubbleIcon, CheckIcon, CloseIcon, FriendsIcon } from '../Icons'

export type FriendsTab = 'online' | 'all' | 'pending' | 'blocked' | 'add'

interface FriendsPageProps {
  relationships: Relationships
  users: Record<string, ApiUser>
  loaded: boolean
  /** False when the server is older than Milestone 10. */
  supported: boolean
  resolveUser: (id: string) => User
  banner?: ReactNode
  onMessage: (userId: string) => void
  onOpenProfile: (userId: string, anchor: DOMRect) => void
  onSendRequest: (username: string) => Promise<{ error?: string; type?: 'friend' | 'outgoing' }>
  onAccept: (userId: string) => Promise<string | null>
  /** Remove a friend, cancel your request or decline theirs. */
  onRemove: (userId: string) => Promise<string | null>
  onUnblock: (userId: string) => Promise<string | null>
}

const TABS: { id: FriendsTab; label: string }[] = [
  { id: 'online', label: 'Online' },
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'blocked', label: 'Blocked' }
]

/** Friends, requests and blocks — plus adding friends by exact username. */
function FriendsPage(props: FriendsPageProps): React.JSX.Element {
  const [tab, setTab] = useState<FriendsTab>('online')
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [username, setUsername] = useState('')
  const [addResult, setAddResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [adding, setAdding] = useState(false)

  const { relationships, users } = props
  const incoming = relationshipsOfType(relationships, 'incoming')
  const outgoing = relationshipsOfType(relationships, 'outgoing')
  const friendIds = sortFriends(
    relationshipsOfType(relationships, 'friend').map((r) => r.userId),
    users
  )

  const act = async (userId: string, action: () => Promise<string | null>): Promise<void> => {
    setBusy(userId)
    setError(null)
    const failure = await action()
    setBusy(null)
    if (failure) setError(failure)
  }

  const submit = async (): Promise<void> => {
    const name = username.trim()
    if (!name) return
    setAdding(true)
    setAddResult(null)
    const result = await props.onSendRequest(name)
    setAdding(false)
    if (result.error) {
      setAddResult({ ok: false, text: result.error })
      return
    }
    setAddResult({
      ok: true,
      text:
        result.type === 'friend'
          ? `You and ${name} are now friends.`
          : `Friend request sent to ${name}.`
    })
    setUsername('')
  }

  let ids: string[] = []
  let title = ''
  if (tab === 'online') {
    ids = friendIds.filter((id) => users[id] && users[id].status !== 'offline')
    title = 'Online'
  } else if (tab === 'all') {
    ids = friendIds
    title = 'All friends'
  } else if (tab === 'blocked') {
    ids = relationshipsOfType(relationships, 'blocked').map((r) => r.userId)
    title = 'Blocked'
  }
  ids = ids.filter((id) => matchesUser(users[id], filter))
  const pendingIds = [...incoming, ...outgoing]
    .map((r) => r.userId)
    .filter((id) => matchesUser(users[id], filter))

  const row = (userId: string, sub: ReactNode, actions: ReactNode): React.JSX.Element => {
    const user = props.resolveUser(userId)
    return (
      <li key={userId} className={`friend-row${busy === userId ? ' busy' : ''}`}>
        <button
          type="button"
          className="friend-identity"
          onClick={(e) => props.onOpenProfile(userId, e.currentTarget.getBoundingClientRect())}
          aria-haspopup="dialog"
        >
          <Avatar
            name={user.name}
            color={user.avatarColor}
            imageId={user.avatarId}
            size={36}
            status={tab === 'blocked' ? undefined : user.status}
            ringColor="var(--bg-primary)"
          />
          <span className="friend-text">
            <span className="friend-name">
              {user.name} <span className="friend-username">{user.username}</span>
            </span>
            <span className="friend-sub">{sub}</span>
          </span>
        </button>
        <span className="friend-actions">{actions}</span>
      </li>
    )
  }

  const statusText = (user: User): ReactNode =>
    user.status === 'offline' ? (
      'Offline'
    ) : user.customStatus ? (
      <CustomStatusText status={user.customStatus} />
    ) : user.status === 'dnd' ? (
      'Do Not Disturb'
    ) : user.status === 'idle' ? (
      'Idle'
    ) : (
      'Online'
    )

  const iconAction = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    variant = ''
  ): React.JSX.Element => (
    <button
      type="button"
      className={`friend-action${variant ? ` ${variant}` : ''}`}
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={busy !== null}
    >
      {icon}
    </button>
  )

  return (
    <main className="chat-panel friends-page" aria-label="Friends">
      <header className="chat-header friends-header">
        <div className="chat-header-title">
          <FriendsIcon size={22} className="chat-header-hash" />
          <h2>Friends</h2>
          <span className="chat-header-divider" />
        </div>
        <nav className="friends-tabs" aria-label="Friends views">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`friends-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
              aria-pressed={tab === t.id}
            >
              {t.label}
              {t.id === 'pending' && incoming.length > 0 && (
                <span className="unread-badge" aria-label={`${incoming.length} incoming`}>
                  {incoming.length}
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            className={`friends-tab add${tab === 'add' ? ' active' : ''}`}
            onClick={() => setTab('add')}
            aria-pressed={tab === 'add'}
          >
            Add Friend
          </button>
        </nav>
      </header>

      {props.banner}

      <div className="friends-body">
        {!props.supported && (
          <p className="settings-note" role="status">
            This server doesn&rsquo;t support friends and direct messages yet. Ask the person who
            runs it to update the server to Milestone 10.
          </p>
        )}
        {error && (
          <p className="form-error friends-error" role="alert">
            {error}
          </p>
        )}

        {tab === 'add' ? (
          <section className="add-friend" aria-labelledby="add-friend-title">
            <h3 id="add-friend-title">Add a friend</h3>
            <p className="muted">
              Enter their exact username (not their display name). Usernames aren&rsquo;t
              case-sensitive.
            </p>
            <form
              className="add-friend-form"
              onSubmit={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              <input
                className="text-input"
                type="text"
                value={username}
                maxLength={32}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="username"
                aria-label="Username"
                onChange={(e) => {
                  setUsername(e.target.value)
                  setAddResult(null)
                }}
              />
              <button
                type="submit"
                className="button primary"
                disabled={adding || !username.trim()}
              >
                {adding ? 'Sending…' : 'Send Friend Request'}
              </button>
            </form>
            {addResult && (
              <p
                className={addResult.ok ? 'form-success' : 'form-error'}
                role={addResult.ok ? 'status' : 'alert'}
              >
                {addResult.text}
              </p>
            )}
          </section>
        ) : (
          <>
            <input
              type="search"
              className="text-input friends-filter"
              placeholder="Search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Search friends"
            />
            {!props.loaded ? (
              <p className="friends-empty">Loading…</p>
            ) : tab === 'pending' ? (
              <>
                <h3 className="friends-count">Pending — {pendingIds.length}</h3>
                {pendingIds.length === 0 && (
                  <p className="friends-empty">No pending friend requests.</p>
                )}
                <ul className="friend-list">
                  {incoming
                    .filter((r) => pendingIds.includes(r.userId))
                    .map((r) =>
                      row(
                        r.userId,
                        'Incoming friend request',
                        <>
                          {iconAction(
                            'Accept',
                            <CheckIcon size={18} />,
                            () => void act(r.userId, () => props.onAccept(r.userId)),
                            'accept'
                          )}
                          {iconAction(
                            'Decline',
                            <CloseIcon size={18} />,
                            () => void act(r.userId, () => props.onRemove(r.userId)),
                            'danger'
                          )}
                        </>
                      )
                    )}
                  {outgoing
                    .filter((r) => pendingIds.includes(r.userId))
                    .map((r) =>
                      row(
                        r.userId,
                        'Outgoing friend request',
                        iconAction(
                          'Cancel request',
                          <CloseIcon size={18} />,
                          () => void act(r.userId, () => props.onRemove(r.userId)),
                          'danger'
                        )
                      )
                    )}
                </ul>
              </>
            ) : (
              <>
                <h3 className="friends-count">
                  {title} — {ids.length}
                </h3>
                {ids.length === 0 && (
                  <p className="friends-empty">
                    {tab === 'blocked'
                      ? 'You haven’t blocked anyone.'
                      : tab === 'online'
                        ? 'None of your friends are online right now.'
                        : 'No friends yet — add someone by their username.'}
                  </p>
                )}
                <ul className="friend-list">
                  {ids.map((id) =>
                    tab === 'blocked'
                      ? row(
                          id,
                          'Blocked',
                          iconAction(
                            'Unblock',
                            <BlockIcon size={18} />,
                            () => void act(id, () => props.onUnblock(id))
                          )
                        )
                      : row(
                          id,
                          statusText(props.resolveUser(id)),
                          <>
                            {iconAction('Message', <ChatBubbleIcon size={18} />, () =>
                              props.onMessage(id)
                            )}
                            {iconAction(
                              'Remove friend',
                              <CloseIcon size={18} />,
                              () => {
                                const name = props.resolveUser(id).name
                                if (window.confirm(`Remove ${name} from your friends?`)) {
                                  void act(id, () => props.onRemove(id))
                                }
                              },
                              'danger'
                            )}
                          </>
                        )
                  )}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </main>
  )
}

export default FriendsPage
