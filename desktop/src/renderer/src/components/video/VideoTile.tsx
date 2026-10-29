import { useRef } from 'react'
import type { Track } from 'livekit-client'
import Avatar from '../Avatar'
import { ExpandIcon, FullscreenIcon, HeadphonesIcon, MicIcon, PinIcon } from '../Icons'
import { useAttachedTrack } from './useAttachedTrack'

export interface TilePerson {
  identity: string
  name: string
  avatarColor: string
  avatarId?: string | null
  isLocal: boolean
  speaking: boolean
  muted: boolean
  deafened: boolean
}

interface VideoTileProps {
  person: TilePerson
  track: Track | undefined
  /** Mirror (only ever your own self-view). */
  mirror: boolean
  focused?: boolean
  /** Small thumbnail in a filmstrip. */
  compact?: boolean
  width?: number
  height?: number
  onFocus?: () => void
}

/**
 * One camera in the call view. The video keeps its aspect ratio (letterboxed, never stretched or
 * aggressively cropped). While the camera is loading or frozen, the person's avatar is shown.
 */
function VideoTile({
  person,
  track,
  mirror,
  focused,
  compact,
  width,
  height,
  onFocus
}: VideoTileProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const { ref, frames } = useAttachedTrack(track)
  const showVideo = track !== undefined && frames === 'playing'
  const state = !track
    ? 'Camera starting'
    : frames === 'stalled'
      ? 'Video paused'
      : frames === 'loading'
        ? 'Connecting video'
        : null
  const who = person.isLocal ? 'your camera' : `${person.name}’s camera`
  const label = [
    person.isLocal ? 'Your camera' : `${person.name}’s camera`,
    person.speaking ? 'speaking' : null,
    person.muted ? 'muted' : null,
    person.deafened ? 'deafened' : null,
    state
  ]
    .filter(Boolean)
    .join(', ')

  const fullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void rootRef.current?.requestFullscreen().catch(() => undefined)
  }

  return (
    <div
      ref={rootRef}
      className={`video-tile${person.speaking ? ' speaking' : ''}${focused ? ' focused' : ''}${compact ? ' compact' : ''}`}
      style={width && height ? { width, height } : undefined}
      role="group"
      aria-label={label}
      data-identity={person.identity}
      data-frames={track ? frames : 'none'}
    >
      <video
        ref={ref}
        className={`video-tile-video${mirror ? ' mirrored' : ''}${showVideo ? '' : ' hidden'}`}
        muted
        playsInline
        autoPlay
        disablePictureInPicture
      />
      {!showVideo && (
        <div className="video-tile-placeholder" aria-hidden="true">
          <Avatar
            name={person.name}
            color={person.avatarColor}
            imageId={person.avatarId}
            size={compact ? 36 : 72}
            motion="still"
          />
          {state && !compact && <span className="video-tile-state">{state}…</span>}
        </div>
      )}
      <div className="video-tile-label">
        <span className="video-tile-name">
          {person.isLocal ? `${person.name} (you)` : person.name}
        </span>
        {person.muted && <MicIcon size={14} slashed />}
        {person.deafened && <HeadphonesIcon size={14} slashed />}
      </div>
      {compact ? (
        onFocus && (
          <button
            type="button"
            className="video-tile-hit"
            onClick={onFocus}
            aria-label={`Focus on ${who}`}
          />
        )
      ) : (
        <div className="video-tile-actions">
          {onFocus && (
            <button
              type="button"
              className="video-tile-button"
              onClick={onFocus}
              aria-label={focused ? 'Back to everyone' : `Focus on ${who}`}
              title={focused ? 'Back to everyone' : 'Focus'}
            >
              {focused ? <ExpandIcon size={16} /> : <PinIcon size={16} />}
            </button>
          )}
          <button
            type="button"
            className="video-tile-button"
            onClick={fullscreen}
            aria-label={`Show ${who} full screen`}
            title="Full screen"
          >
            <FullscreenIcon size={16} />
          </button>
        </div>
      )}
    </div>
  )
}

export default VideoTile
