import type { ReactNode } from 'react'
import type { User } from '../../types'
import type { ApiCustomStatus } from '../../net/protocol'
import { useProfileImage } from '../../lib/profileMedia'
import { formatMemberSince } from '../../lib/format'
import Avatar from '../Avatar'

export function ProfileBanner({
  user,
  size,
  height
}: {
  user: Pick<User, 'bannerId' | 'accentColor' | 'avatarColor'>
  size: 'full' | 'small'
  height: number
}): React.JSX.Element {
  const { url } = useProfileImage(user.bannerId, size)
  return (
    <div
      className="profile-card-banner"
      style={{ height, background: user.accentColor ?? user.avatarColor }}
      aria-hidden="true"
    >
      {url && <img src={url} alt="" draggable={false} />}
    </div>
  )
}

export function CustomStatusText({
  status,
  className = 'custom-status'
}: {
  status: ApiCustomStatus | null | undefined
  className?: string
}): React.JSX.Element | null {
  if (!status || (!status.text && !status.emoji)) return null
  return (
    <span className={className}>
      {status.emoji && <span className="custom-status-emoji">{status.emoji}</span>}
      {status.text && <span className="custom-status-text">{status.text}</span>}
    </span>
  )
}

interface ProfileCardProps {
  user: User
  variant: 'popout' | 'modal' | 'preview'
  /** Role in the server on screen. */
  role?: { label: string; color?: string }
  /** Show the user's own custom status even when they appear offline (self view). */
  customStatus?: ApiCustomStatus | null
  children?: ReactNode
}

/** Banner, avatar, names, custom status, bio and account age. Text is never rendered as HTML. */
function ProfileCard({
  user,
  variant,
  role,
  customStatus,
  children
}: ProfileCardProps): React.JSX.Element {
  const big = variant === 'modal'
  const since = formatMemberSince(user.createdAt)
  const status = customStatus === undefined ? user.customStatus : customStatus
  return (
    <div
      className={`profile-card-v2 ${variant}`}
      style={{ '--profile-accent': user.accentColor ?? user.avatarColor } as React.CSSProperties}
    >
      <ProfileBanner user={user} size={big ? 'full' : 'small'} height={big ? 180 : 106} />
      <div className="profile-card-avatar">
        <Avatar
          name={user.name}
          color={user.avatarColor}
          imageId={user.avatarId}
          size={big ? 120 : 84}
          status={user.status}
          ringColor="var(--bg-floating)"
        />
      </div>
      <div className="profile-card-content">
        <div className="profile-card-names">
          <h2 className="profile-card-name">
            {user.name}
            {user.bot && <span className="bot-tag">BOT</span>}
          </h2>
          <div className="profile-card-username">
            {user.username ? `@${user.username}` : null}
            {user.pronouns && (
              <>
                <span aria-hidden="true"> · </span>
                <span className="profile-card-pronouns">{user.pronouns}</span>
              </>
            )}
          </div>
          <CustomStatusText status={status} className="profile-card-status" />
        </div>
        {(user.bio || since || role) && (
          <div className="profile-card-sections">
            {user.bio && (
              <section>
                <h3>About me</h3>
                <p className="profile-card-bio">{user.bio}</p>
              </section>
            )}
            {since && (
              <section>
                <h3>Member since</h3>
                <p>{since}</p>
              </section>
            )}
            {role && (
              <section>
                <h3>Role</h3>
                <span className="role-chip">
                  <span
                    className="role-chip-dot"
                    style={{ background: role.color || 'var(--text-faint)' }}
                  />
                  {role.label}
                </span>
              </section>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

export default ProfileCard
