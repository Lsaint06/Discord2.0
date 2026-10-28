import type { RelationshipType } from '../../net/protocol'

export interface RelationshipHandlers {
  onMessage: () => void
  onAddFriend: () => void
  onAccept: () => void
  /** Remove friend, cancel your request or decline theirs. */
  onRemove: () => void
  onBlock: () => void
  onUnblock: () => void
}

interface RelationshipActionsProps {
  name: string
  relationship: RelationshipType | null
  handlers: RelationshipHandlers
  /** Popouts show only the main actions; the full profile shows all of them. */
  full?: boolean
}

/** Message / friend / block actions for someone else's profile. */
function RelationshipActions({
  name,
  relationship,
  handlers,
  full = false
}: RelationshipActionsProps): React.JSX.Element {
  if (relationship === 'blocked') {
    return (
      <div className="profile-card-actions relationship-actions">
        <span className="muted relationship-note">You blocked {name}.</span>
        <button type="button" className="button secondary small" onClick={handlers.onUnblock}>
          Unblock
        </button>
      </div>
    )
  }
  const confirmBlock = (): void => {
    if (
      window.confirm(
        `Block ${name}? They won’t be able to message you or send friend requests, and you won’t see their status. They aren’t told.`
      )
    ) {
      handlers.onBlock()
    }
  }
  return (
    <div className="profile-card-actions relationship-actions">
      <button type="button" className="button primary small" onClick={handlers.onMessage}>
        Message
      </button>
      {relationship === null && (
        <button type="button" className="button secondary small" onClick={handlers.onAddFriend}>
          Add Friend
        </button>
      )}
      {relationship === 'incoming' && (
        <>
          <button type="button" className="button secondary small" onClick={handlers.onAccept}>
            Accept Request
          </button>
          {full && (
            <button type="button" className="button secondary small" onClick={handlers.onRemove}>
              Decline
            </button>
          )}
        </>
      )}
      {relationship === 'outgoing' && (
        <button type="button" className="button secondary small" onClick={handlers.onRemove}>
          Cancel Request
        </button>
      )}
      {full && relationship === 'friend' && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => {
            if (window.confirm(`Remove ${name} from your friends?`)) handlers.onRemove()
          }}
        >
          Remove Friend
        </button>
      )}
      {full && (
        <button type="button" className="button danger-link small" onClick={confirmBlock}>
          Block
        </button>
      )}
    </div>
  )
}

export default RelationshipActions
