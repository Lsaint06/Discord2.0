import type { PresenceStatus } from '../types'
import { initials, statusLabels } from '../lib/format'

interface AvatarProps {
  name: string
  color: string
  size?: number
  status?: PresenceStatus
  /** Background color behind the status dot so it "cuts out" of the avatar. */
  ringColor?: string
}

function Avatar({
  name,
  color,
  size = 40,
  status,
  ringColor = 'var(--bg-secondary)'
}: AvatarProps): React.JSX.Element {
  const dot = Math.max(10, Math.round(size * 0.32))
  return (
    <div
      className="avatar"
      style={{ width: size, height: size, background: color, fontSize: size * 0.38 }}
      aria-label={name}
    >
      <span>{initials(name)}</span>
      {status && (
        <span
          className={`status-dot status-${status}`}
          style={{ width: dot, height: dot, borderColor: ringColor }}
          title={statusLabels[status]}
        />
      )}
    </div>
  )
}

export default Avatar
