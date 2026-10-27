import type { PresenceStatus } from '../types'
import { initials, statusLabels } from '../lib/format'
import { useProfileImage } from '../lib/profileMedia'

interface AvatarProps {
  name: string
  color: string
  size?: number
  status?: PresenceStatus
  /** Background color behind the status dot so it "cuts out" of the avatar. */
  ringColor?: string
  /** Profile picture id; initials are shown while it loads or if it can't be loaded. */
  imageId?: string | null
}

function Avatar({
  name,
  color,
  size = 40,
  status,
  ringColor = 'var(--bg-secondary)',
  imageId
}: AvatarProps): React.JSX.Element {
  const dot = Math.max(10, Math.round(size * 0.32))
  // Thumbnails (128 px) are enough up to ~64 px on HiDPI screens.
  const { url } = useProfileImage(imageId, size > 64 ? 'full' : 'small')
  return (
    <div
      className={`avatar${url ? ' has-image' : ''}`}
      style={{ width: size, height: size, background: color, fontSize: size * 0.38 }}
      role="img"
      aria-label={status ? `${name}, ${statusLabels[status]}` : name}
    >
      {url ? (
        <img src={url} alt="" draggable={false} decoding="async" />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
      {status && (
        <span
          className={`status-dot status-${status}`}
          style={{ width: dot, height: dot, borderColor: ringColor }}
          title={statusLabels[status]}
          aria-hidden="true"
        />
      )}
    </div>
  )
}

export default Avatar
