import type { ReactNode } from 'react'
import type { User } from '../../types'
import type { ApiCustomStatus } from '../../net/protocol'
import { useProfileImage } from '../../lib/profileMedia'
import { formatMemberSince } from '../../lib/format'
import {
  bannerPresetOf,
  decorationOf,
  effectOf,
  gradientColors,
  nameStyleOf,
  profileGradientCss
} from '../../lib/profileStyle'
import { useProfileActivity, useProfileMotion } from '../../lib/profileMotion'
import Avatar from '../Avatar'
import BannerArt from './BannerArt'
import ProfileEffect from './ProfileEffect'

export function ProfileBanner({
  user,
  size,
  height,
  animate = false
}: {
  user: Pick<User, 'bannerId' | 'accentColor' | 'avatarColor' | 'bannerAnimated' | 'profileStyle'>
  size: 'full' | 'small'
  height: number
  /** Milestone 14: an animated banner / banner preset may move now. */
  animate?: boolean
}): React.JSX.Element {
  const animated = user.bannerAnimated === true
  const plain = useProfileImage(animated ? null : user.bannerId, size)
  const still = useProfileImage(animated ? user.bannerId : null, 'still')
  const moving = useProfileImage(animated && animate ? user.bannerId : null, size)
  const url = animated ? (animate ? (moving.url ?? still.url) : still.url) : plain.url
  const preset = user.bannerId ? null : bannerPresetOf(user.profileStyle)
  const gradient = profileGradientCss(user.profileStyle)
  return (
    <div
      className="profile-card-banner"
      style={{ height, background: gradient ?? user.accentColor ?? user.avatarColor }}
      aria-hidden="true"
    >
      {preset && <BannerArt id={preset} animate={animate} />}
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

/** A display name with its (optional) Milestone 14 name style. Always real, selectable text. */
export function StyledName({
  user,
  children,
  className = ''
}: {
  user: Pick<User, 'profileStyle' | 'accentColor'>
  children: ReactNode
  className?: string
}): React.JSX.Element {
  const style = nameStyleOf(user.profileStyle)
  if (!style) return <span className={className || undefined}>{children}</span>
  const colors = gradientColors(user.profileStyle)
  const vars =
    style === 'gradient'
      ? ({
          '--name-a': colors[0] ?? 'var(--accent)',
          '--name-b': colors[colors.length - 1] ?? '#f472b6'
        } as React.CSSProperties)
      : undefined
  return (
    <span className={`styled-name name-style-${style} ${className}`.trim()} style={vars}>
      {children}
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
  /** Studio preview: replay the effect when this number changes. */
  replayKey?: number
}

/** Banner, avatar, names, custom status, bio and account age. Text is never rendered as HTML. */
function ProfileCard({
  user,
  variant,
  role,
  customStatus,
  children,
  replayKey = 0
}: ProfileCardProps): React.JSX.Element {
  const big = variant === 'modal'
  const since = formatMemberSince(user.createdAt)
  const status = customStatus === undefined ? user.customStatus : customStatus
  const motion = useProfileMotion()
  const activity = useProfileActivity(motion)
  const effect = effectOf(user.profileStyle)
  const decoration = decorationOf(user.profileStyle)
  const gradient = profileGradientCss(user.profileStyle)
  return (
    <div
      className={`profile-card-v2 ${variant}${gradient ? ' has-gradient' : ''}`}
      style={
        {
          '--profile-accent': user.accentColor ?? user.avatarColor,
          ...(gradient ? { '--profile-gradient': gradient } : {})
        } as React.CSSProperties
      }
      data-effect={effect ?? undefined}
      {...activity.bind}
    >
      <ProfileBanner
        user={user}
        size={big ? 'full' : 'small'}
        height={big ? 180 : 106}
        animate={activity.active}
      />
      {effect && <ProfileEffect id={effect} run={activity.run + replayKey} still={!motion} />}
      <div className="profile-card-avatar">
        <Avatar
          name={user.name}
          color={user.avatarColor}
          imageId={user.avatarId}
          size={big ? 120 : 84}
          status={user.status}
          ringColor="var(--bg-floating)"
          decoration={decoration}
          animatedImage={user.avatarAnimated}
          motion={activity.active ? 'active' : 'still'}
        />
      </div>
      <div className="profile-card-content">
        <div className="profile-card-names">
          <h2 className="profile-card-name">
            <StyledName user={user}>{user.name}</StyledName>
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
