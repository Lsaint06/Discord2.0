import RelationshipActions, { type RelationshipHandlers } from './RelationshipActions'
import type { RelationshipType } from '../../net/protocol'
import { useEffect, useState } from 'react'
import { useDialog } from '../../hooks/useDialog'
import type { User } from '../../types'
import type { ApiCustomStatus, ApiProfile, ApiServer } from '../../net/protocol'
import { CloseIcon } from '../Icons'
import ProfileCard from './ProfileCard'

interface ProfileModalProps {
  user: User
  isSelf: boolean
  selfCustomStatus?: ApiCustomStatus | null
  role?: { label: string; color?: string }
  servers: ApiServer[]
  fetchProfile: (userId: string) => Promise<ApiProfile>
  onEditProfile: () => void
  onOpenServer: (serverId: string) => void
  onClose: () => void
  /** Friend / message / block actions for other people (omitted for bots and yourself). */
  relationship?: { type: RelationshipType | null; handlers: RelationshipHandlers }
}

/** Full profile: large banner and avatar, bio, account age and mutual servers. */
function ProfileModal({
  user,
  isSelf,
  selfCustomStatus,
  role,
  servers,
  fetchProfile,
  onEditProfile,
  onOpenServer,
  onClose,
  relationship
}: ProfileModalProps): React.JSX.Element {
  const [tab, setTab] = useState<'about' | 'servers'>('about')
  const [mutual, setMutual] = useState<{ userId: string; ids: string[] } | null>(null)
  const [error, setError] = useState<{ userId: string; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchProfile(user.id).then(
      (profile) => !cancelled && setMutual({ userId: user.id, ids: profile.mutualServerIds }),
      (err: unknown) =>
        !cancelled &&
        setError({
          userId: user.id,
          text: err instanceof Error ? err.message : 'Could not load this profile.'
        })
    )
    return () => {
      cancelled = true
    }
  }, [fetchProfile, user.id])

  const dialogRef = useDialog<HTMLDivElement>({ onClose })

  const mutualIds = mutual?.userId === user.id ? mutual.ids : null
  const loadError = error?.userId === user.id ? error.text : null
  const mutualServers = (mutualIds ?? [])
    .map((id) => servers.find((s) => s.id === id))
    .filter((s): s is ApiServer => Boolean(s))

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal profile-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${user.name}’s profile`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="modal-close on-banner"
          onClick={onClose}
          aria-label="Close"
        >
          <CloseIcon size={18} />
        </button>
        <ProfileCard
          user={user}
          variant="modal"
          role={role}
          customStatus={isSelf ? selfCustomStatus : undefined}
        >
          {isSelf && (
            <div className="profile-card-actions top">
              <button type="button" className="button primary small" onClick={onEditProfile}>
                Edit Profile
              </button>
            </div>
          )}
          {!isSelf && relationship && (
            <RelationshipActions
              name={user.name}
              relationship={relationship.type}
              handlers={relationship.handlers}
              full
            />
          )}
          {!isSelf && (
            <>
              <div className="modal-tabs profile-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'about'}
                  className={tab === 'about' ? 'active' : ''}
                  onClick={() => setTab('about')}
                >
                  About
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'servers'}
                  className={tab === 'servers' ? 'active' : ''}
                  onClick={() => setTab('servers')}
                >
                  Mutual Servers{mutualIds ? ` — ${mutualServers.length}` : ''}
                </button>
              </div>
              {tab === 'about' && !user.bio && (
                <p className="muted profile-empty">{user.name} hasn’t written anything yet.</p>
              )}
              {tab === 'servers' && (
                <div className="profile-mutual" role="tabpanel">
                  {loadError ? (
                    <p className="form-error">{loadError}</p>
                  ) : !mutualIds ? (
                    <div className="spinner small" aria-label="Loading" />
                  ) : mutualServers.length === 0 ? (
                    <p className="muted profile-empty">No servers in common.</p>
                  ) : (
                    <ul>
                      {mutualServers.map((s) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            className="profile-mutual-server"
                            onClick={() => onOpenServer(s.id)}
                          >
                            <span className="profile-mutual-icon" style={{ background: s.color }}>
                              {s.name.slice(0, 1).toUpperCase()}
                            </span>
                            {s.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </ProfileCard>
      </div>
    </div>
  )
}

export default ProfileModal
