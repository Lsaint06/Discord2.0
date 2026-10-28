import { useState } from 'react'
import type { User } from '../../types'
import type { ApiUser } from '../../net/protocol'
import { LIMITS } from '../../net/protocol'
import { addableFriends, matchesUser, type Relationships } from '../../chat/conversations'
import { useDialog } from '../../hooks/useDialog'
import Avatar from '../Avatar'
import { CloseIcon } from '../Icons'

interface GroupDialogProps {
  /** 'create' starts a new group; 'add' adds people to an existing one. */
  mode: 'create' | 'add'
  relationships: Relationships
  users: Record<string, ApiUser>
  /** People already in the group (add mode). */
  existingMemberIds?: string[]
  resolveUser: (id: string) => User
  /** Resolves to an error message or null. */
  onSubmit: (userIds: string[], name: string | null) => Promise<string | null>
  onClose: () => void
}

/** Pick friends for a new group (3–10 people including you) or to add to an existing group. */
function GroupDialog(props: GroupDialogProps): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useDialog<HTMLDivElement>({ onClose: saving ? undefined : props.onClose })

  const existing = props.existingMemberIds ?? []
  // Total size includes you (create) or the current members (add).
  const base = props.mode === 'create' ? 1 : existing.length
  const room = LIMITS.groupMaxMembers - base
  const candidates = addableFriends(props.relationships, props.users, existing).filter((id) =>
    matchesUser(props.users[id], filter)
  )
  const minSelected = props.mode === 'create' ? LIMITS.groupMinMembers - 1 : 1
  const valid = selected.length >= minSelected && selected.length <= room

  const toggle = (id: string): void => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < room ? [...prev, id] : prev
    )
  }

  const submit = async (): Promise<void> => {
    if (!valid) return
    setSaving(true)
    setError(null)
    const failure = await props.onSubmit(selected, name.trim() || null)
    setSaving(false)
    if (failure) setError(failure)
    else props.onClose()
  }

  const title = props.mode === 'create' ? 'Create a group' : 'Add friends to the group'
  return (
    <div className="modal-backdrop" onMouseDown={saving ? undefined : props.onClose}>
      <div
        ref={dialogRef}
        className="modal group-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button type="button" className="modal-close" onClick={props.onClose} aria-label="Close">
          <CloseIcon size={18} />
        </button>
        <h2 id="group-dialog-title">{title}</h2>
        <p className="muted">
          {props.mode === 'create'
            ? `Choose at least ${minSelected} friends. Groups can have up to ${LIMITS.groupMaxMembers} people.`
            : `New members only see messages sent after they join. ${Math.max(0, room)} spot${room === 1 ? '' : 's'} left.`}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {props.mode === 'create' && (
            <>
              <label className="field-label" htmlFor="group-name">
                Group name (optional)
              </label>
              <input
                id="group-name"
                className="text-input"
                type="text"
                value={name}
                maxLength={LIMITS.groupNameMaxLength}
                placeholder="Weekend plans"
                onChange={(e) => setName(e.target.value)}
              />
            </>
          )}
          <input
            type="search"
            className="text-input group-filter"
            placeholder="Search your friends"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Search your friends"
            data-autofocus
          />
          <ul className="group-candidates" aria-label="Friends">
            {candidates.length === 0 && (
              <li className="muted group-empty">
                {filter
                  ? 'No friends match.'
                  : props.mode === 'create'
                    ? 'Add some friends first — groups are made of friends.'
                    : 'All your friends are already here.'}
              </li>
            )}
            {candidates.map((id) => {
              const user = props.resolveUser(id)
              const checked = selected.includes(id)
              const disabled = !checked && selected.length >= room
              return (
                <li key={id}>
                  <label className={`group-candidate${disabled ? ' disabled' : ''}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled || saving}
                      onChange={() => toggle(id)}
                    />
                    <Avatar
                      name={user.name}
                      color={user.avatarColor}
                      imageId={user.avatarId}
                      size={28}
                    />
                    <span className="group-candidate-name">{user.name}</span>
                    <span className="friend-username">{user.username}</span>
                  </label>
                </li>
              )
            })}
          </ul>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              onClick={props.onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={!valid || saving}>
              {saving
                ? 'Saving…'
                : props.mode === 'create'
                  ? `Create group${selected.length ? ` (${selected.length + 1})` : ''}`
                  : `Add${selected.length ? ` ${selected.length}` : ''}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default GroupDialog
