import { useEffect, useRef, useState } from 'react'
import type { PresenceStatus } from '../types'
import type { AvatarDecorationId } from '../net/protocol'
import { initials, statusLabels } from '../lib/format'
import { useProfileImage } from '../lib/profileMedia'
import { useProfileMotion } from '../lib/profileMotion'
import { AvatarDecoration } from './profile/AvatarDecoration'

interface AvatarProps {
  name: string
  color: string
  size?: number
  status?: PresenceStatus
  /** Background color behind the status dot so it "cuts out" of the avatar. */
  ringColor?: string
  /** Profile picture id; initials are shown while it loads or if it can't be loaded. */
  imageId?: string | null
  /** Milestone 14: avatar decoration drawn around the picture. */
  decoration?: AvatarDecorationId | null
  /** The picture is animated (the server also stores a still first frame). */
  animatedImage?: boolean
  /**
   * When the decoration / animated picture may move: 'active' = now (open profile, preview),
   * 'hover' = while the pointer is over the row it sits in (lists), 'still' = never.
   * Reduced motion always wins.
   */
  motion?: 'active' | 'hover' | 'still'
}

/** The row an avatar belongs to: hovering anywhere on it plays the avatar. */
const HOVER_ROOT = '[data-hover-root], .message, .member, li, button'

function Avatar({
  name,
  color,
  size = 40,
  status,
  ringColor = 'var(--bg-secondary)',
  imageId,
  decoration,
  animatedImage = false,
  motion = 'hover'
}: AvatarProps): React.JSX.Element {
  const dot = Math.max(10, Math.round(size * 0.32))
  const motionAllowed = useProfileMotion()
  const ref = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState(false)
  const wantsHover = motion === 'hover' && motionAllowed && Boolean(decoration || animatedImage)

  useEffect(() => {
    const el = ref.current
    if (!wantsHover || !el) return
    const root = (el.parentElement?.closest(HOVER_ROOT) as HTMLElement | null) ?? el
    const enter = (): void => setHovered(true)
    const leave = (): void => setHovered(false)
    root.addEventListener('pointerenter', enter)
    root.addEventListener('pointerleave', leave)
    return () => {
      root.removeEventListener('pointerenter', enter)
      root.removeEventListener('pointerleave', leave)
      setHovered(false)
    }
  }, [wantsHover])

  const active = motionAllowed && (motion === 'active' || (motion === 'hover' && hovered))
  // Thumbnails (128 px) are enough up to ~64 px on HiDPI screens.
  const size2x = size > 64 ? 'full' : 'small'
  // Animated pictures: the still frame by default; the animation only while active (so long
  // lists never decode dozens of animations at once).
  const plain = useProfileImage(animatedImage ? null : imageId, size2x)
  const still = useProfileImage(animatedImage ? imageId : null, 'still')
  const moving = useProfileImage(animatedImage && active ? imageId : null, size2x)
  const url = animatedImage ? (active ? (moving.url ?? still.url) : still.url) : plain.url

  return (
    <div
      ref={ref}
      className={`avatar${url ? ' has-image' : ''}${decoration ? ' decorated' : ''}`}
      style={{ width: size, height: size, background: color, fontSize: size * 0.38 }}
      role="img"
      aria-label={status ? `${name}, ${statusLabels[status]}` : name}
    >
      {url ? (
        <img src={url} alt="" draggable={false} decoding="async" />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
      {decoration && <AvatarDecoration id={decoration} animate={active} />}
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
