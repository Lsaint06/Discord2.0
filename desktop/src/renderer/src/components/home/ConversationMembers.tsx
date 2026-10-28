import { useState } from 'react'
import type { User } from '../../types'
import type { ApiConversation } from '../../net/protocol'
import { LIMITS } from '../../net/protocol'
import Avatar from '../Avatar'
import { CustomStatusText } from '../profile/ProfileCard'
import { CloseIcon, LeaveIcon, UserPlusIcon } from '../Icons'

interface ConversationMembersProps {
  conversation: ApiConversation
  meId: string
  resolveUser: (id: string) => User
  onOpenProfile: (userId: string, anchor: DOMRect) => void
  onAddPeople: () => void
  /** Resolves to an error message or null. */
  onRename: (name: string | null) => Promise<string | null>
  onRemove: (userId: string) => Promise<string | null>
  onLeave: () => void
}

/** Members of a group (or both people in a DM), with group management for members and the owner. */
function ConversationMembers(props: ConversationMembersProps): React.JSX.Element {
  const { conversation, meId } = props
  const isGroup = conversation.kind === 'group'
  const isOwner = isGroup && conversation.ownerId === meId
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(conversation.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const members = conversation.memberIds
    .map(props.resolveUser)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const online = members.filter((u) => u.status !== 'offline')
  const offline = members.filter((u) => u.status === 'offline')

  const rename = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const failure = await props.onRename(name.trim() || null)
    setBusy(false)
    if (failure) setError(failure)
    else setEditing(false)
  }

  const remove = async (user: User): Promise<void> => {
    if (!window.confirm(`Remove ${user.name} from the group?`)) return
    setError(null)
    const failure = await props.onRemove(user.id)
    if (failure) setError(failure)
  }

  const section = (label: string, users: User[]): React.JSX.Element | null =>
    users.length === 0 ? null : (
      <section className="member-group" aria-label={label}>
        <h3>
          {label} — {users.length}
        </h3>
        <ul>
          {users.map((user) => (
            <li key={user.id} className="conversation-member">
              <button
                type="button"
                className={`member${user.status === 'offline' ? ' offline' : ''}`}
                onClick={(e) =>
                  props.onOpenProfile(user.id, e.currentTarget.getBoundingClientRect())
                }
                aria-haspopup="dialog"
              >
                <Avatar
                  name={user.name}
                  color={user.avatarColor}
                  imageId={user.avatarId}
                  size={32}
                  status={user.status}
                  ringColor="var(--bg-secondary)"
                />
                <span className="member-text">
                  <span className="member-name">
                    {user.name}
                    {isGroup && conversation.ownerId === user.id && (
                      <span className="owner-tag" title="Group owner">
                        OWNER
                      </span>
                    )}
                  </span>
                  {user.status !== 'offline' && (
                    <CustomStatusText status={user.customStatus} className="member-activity" />
                  )}
                </span>
              </button>
              {isOwner && user.id !== meId && (
                <button
                  type="button"
                  className="icon-button small member-remove"
                  onClick={() => void remove(user)}
                  aria-label={`Remove ${user.name} from the group`}
                  title="Remove from group"
                >
                  <CloseIcon size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    )

  return (
    <aside className="member-list conversation-members" aria-label="Conversation members">
      {isGroup && (
        <div className="group-tools">
          {editing ? (
            <form
              className="group-rename"
              onSubmit={(e) => {
                e.preventDefault()
                void rename()
              }}
            >
              <input
                className="text-input"
                type="text"
                value={name}
                autoFocus
                maxLength={LIMITS.groupNameMaxLength}
                placeholder="Group name"
                aria-label="Group name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setEditing(false)
                  }
                }}
              />
              <button type="submit" className="button primary small" disabled={busy}>
                Save
              </button>
            </form>
          ) : (
            <button type="button" className="link-button" onClick={() => setEditing(true)}>
              Rename group
            </button>
          )}
          <button
            type="button"
            className="button secondary small"
            onClick={props.onAddPeople}
            disabled={conversation.memberIds.length >= LIMITS.groupMaxMembers}
          >
            <UserPlusIcon size={16} /> Add friends
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {section('Online', online)}
      {section('Offline', offline)}
      {isGroup && (
        <button type="button" className="button danger-link leave-group" onClick={props.onLeave}>
          <LeaveIcon size={16} /> Leave group
        </button>
      )}
    </aside>
  )
}

export default ConversationMembers
