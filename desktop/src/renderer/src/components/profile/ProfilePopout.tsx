import RelationshipActions, { type RelationshipHandlers } from './RelationshipActions'
import type { RelationshipType } from '../../net/protocol'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { User } from '../../types'
import type { ApiCustomStatus } from '../../net/protocol'
import ProfileCard from './ProfileCard'
import UserNoteField, { type UserNoteSupport } from './UserNoteField'

const WIDTH = 320
const GAP = 10

interface ProfilePopoutProps {
  user: User
  anchor: DOMRect
  role?: { label: string; color?: string }
  isSelf: boolean
  /** Your own custom status (visible to you even while invisible). */
  selfCustomStatus?: ApiCustomStatus | null
  onViewProfile: () => void
  onEditProfile: () => void
  onClose: () => void
  /** Friend / message / block actions for other people (omitted for bots and yourself). */
  relationship?: { type: RelationshipType | null; handlers: RelationshipHandlers }
  /** Milestone 14: your private note about this person (servers that keep notes). */
  note?: UserNoteSupport
}

/** Small profile card next to the clicked avatar or name. */
function ProfilePopout({
  user,
  anchor,
  role,
  isSelf,
  selfCustomStatus,
  onViewProfile,
  onEditProfile,
  onClose,
  relationship,
  note
}: ProfilePopoutProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // Place it beside the anchor (right if there is room, else left), clamped to the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const height = el.offsetHeight
    const fitsRight = anchor.right + GAP + WIDTH <= window.innerWidth - 8
    const left = fitsRight ? anchor.right + GAP : Math.max(8, anchor.left - GAP - WIDTH)
    const top = Math.min(Math.max(8, anchor.top - 20), window.innerHeight - height - 8)
    setPosition({ left, top: Math.max(8, top) })
  }, [anchor, user])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown)
      previous?.focus?.()
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="profile-popout"
      role="dialog"
      aria-label={`${user.name}’s profile`}
      tabIndex={-1}
      style={{
        width: WIDTH,
        left: position?.left ?? -9999,
        top: position?.top ?? 0,
        visibility: position ? 'visible' : 'hidden'
      }}
    >
      <ProfileCard
        user={user}
        variant="popout"
        role={role}
        customStatus={isSelf ? selfCustomStatus : undefined}
      >
        {relationship && !isSelf && (
          <RelationshipActions
            name={user.name}
            relationship={relationship.type}
            handlers={relationship.handlers}
          />
        )}
        {note && !isSelf && (
          <UserNoteField key={user.id} userId={user.id} name={user.name} {...note} />
        )}
        <div className="profile-card-actions">
          {isSelf && (
            <button type="button" className="button secondary small" onClick={onEditProfile}>
              Edit Profile
            </button>
          )}
          <button type="button" className="button primary small" onClick={onViewProfile}>
            View Full Profile
          </button>
        </div>
      </ProfileCard>
    </div>
  )
}

export default ProfilePopout
