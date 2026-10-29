import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MediaSession, MediaSnapshot, VoiceParticipant } from '../../media/MediaSession'
import { galleryGrid, galleryOrder, galleryPageSize, pageFor } from '../../lib/gallery'
import Avatar from '../Avatar'
import { CloseIcon, GridIcon, HeadphonesIcon, MicIcon, OverlayIcon } from '../Icons'
import CameraButton, { type CameraAvailability } from './CameraButton'
import VideoTile, { type TilePerson } from './VideoTile'

interface CallStageProps {
  session: MediaSession
  state: MediaSnapshot
  person: (p: VoiceParticipant) => TilePerson
  channelName: string
  mirror: boolean
  hideSelf: boolean
  overlayEnabled: boolean
  cameraAvailability: CameraAvailability
  onToggleCamera: () => void
  onToggleHideSelf: () => void
  onToggleOverlay: () => void
  onWatchStream: (identity: string) => void
  onClose: () => void
}

function useSize(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setSize((s) =>
        Math.round(r.width) === s.width && Math.round(r.height) === s.height
          ? s
          : { width: Math.round(r.width), height: Math.round(r.height) }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/**
 * The video view of your voice channel: everyone's cameras in a responsive grid (or one person
 * focused with the rest in a strip), the people without a camera below, and the call controls.
 */
function CallStage({
  session,
  state,
  person,
  channelName,
  mirror,
  hideSelf,
  overlayEnabled,
  cameraAvailability,
  onToggleCamera,
  onToggleHideSelf,
  onToggleOverlay,
  onWatchStream,
  onClose
}: CallStageProps): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const size = useSize(bodyRef)
  const [focused, setFocused] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [announcement, setAnnouncement] = useState('')

  const order = useMemo(
    () => galleryOrder(state.participants, { hideSelf }),
    [state.participants, hideSelf]
  )
  const others = state.participants.filter((p) => !p.cameraOn)
  const streamers = state.participants.filter((p) => p.sharingScreen && !p.isLocal)
  const selfCameraOn = state.participants.some((p) => p.isLocal && p.cameraOn)
  const focusedPresent = focused !== null && order.some((p) => p.identity === focused)
  void state.streamRevision // tracks are looked up again whenever cameras appear or disappear

  // Screen readers hear who turned their camera on or off (not every re-render). Compared while
  // rendering against the previous participant list, React's pattern for reacting to new props.
  const [previous, setPrevious] = useState(state.participants)
  if (previous !== state.participants) {
    setPrevious(state.participants)
    const before = new Map(previous.map((p) => [p.identity, p.cameraOn]))
    const changes: string[] = []
    for (const p of state.participants) {
      if (p.isLocal) continue
      const was = before.get(p.identity) ?? false
      if (p.cameraOn !== was)
        changes.push(`${person(p).name} turned ${p.cameraOn ? 'on' : 'off'} their camera`)
    }
    if (changes.length > 0) setAnnouncement(changes.join('. '))
  }

  const pageSize = galleryPageSize(size.width, size.height)
  const pages = Math.max(1, Math.ceil(order.length / pageSize))
  const currentPage = pageFor(order, pageSize, page)
  const visible = order.slice(currentPage * pageSize, currentPage * pageSize + pageSize)
  const grid = galleryGrid(visible.length, size.width, size.height)
  const focusedPerson = focusedPresent ? order.find((p) => p.identity === focused) : undefined
  const strip = focusedPerson ? order.filter((p) => p.identity !== focused) : []
  const focusGrid = galleryGrid(
    1,
    size.width,
    Math.max(0, size.height - (strip.length > 0 ? 112 : 0))
  )

  const tile = (
    p: VoiceParticipant,
    extra: { width?: number; height?: number; compact?: boolean; focused?: boolean }
  ): React.JSX.Element => (
    <VideoTile
      key={p.identity}
      person={person(p)}
      track={session.getCameraTrack(p.identity)}
      mirror={p.isLocal && mirror}
      onFocus={() => setFocused((f) => (f === p.identity ? null : p.identity))}
      {...extra}
    />
  )

  return (
    <section className="call-stage" aria-label={`Video in ${channelName}`}>
      <header className="call-stage-header">
        <div className="call-stage-title">
          <GridIcon size={20} />
          <h2>{channelName}</h2>
          <span className="call-stage-count">
            {order.length === 0
              ? 'No cameras on'
              : `${order.length} camera${order.length === 1 ? '' : 's'} on`}
          </span>
        </div>
        <div className="call-stage-tools">
          {selfCameraOn && (
            <button
              type="button"
              className="button secondary small"
              aria-pressed={hideSelf}
              onClick={onToggleHideSelf}
            >
              {hideSelf ? 'Show my self-view' : 'Hide my self-view'}
            </button>
          )}
          <button
            type="button"
            className={`button small ${overlayEnabled ? 'primary' : 'secondary'}`}
            aria-pressed={overlayEnabled}
            onClick={onToggleOverlay}
            title={
              overlayEnabled
                ? 'Turn off the in-game camera overlay'
                : 'Show cameras in a small overlay over games'
            }
          >
            <OverlayIcon size={16} slashed={!overlayEnabled} />
            {overlayEnabled ? 'Overlay on' : 'Overlay off'}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close video view"
            title="Close video view"
          >
            <CloseIcon size={18} />
          </button>
        </div>
      </header>

      {streamers.length > 0 && (
        <div className="call-stage-streams">
          {streamers.map((s) => (
            <button
              key={s.identity}
              type="button"
              className="button secondary small"
              onClick={() => onWatchStream(s.identity)}
            >
              <span className="live-badge">LIVE</span> Watch {person(s).name}’s stream
            </button>
          ))}
        </div>
      )}

      <div className="call-stage-body" ref={bodyRef}>
        {order.length === 0 ? (
          <div className="call-stage-empty">
            <GridIcon size={40} />
            <p className="call-stage-empty-title">Nobody has their camera on yet</p>
            <p className="call-stage-empty-text">
              {cameraAvailability.ok
                ? 'Turn yours on to let the others see you. It stays off until you press the camera button.'
                : (cameraAvailability.reason ?? 'Cameras aren’t available in this channel.')}
            </p>
          </div>
        ) : focusedPerson ? (
          <div className="call-stage-focus">
            {tile(focusedPerson, {
              width: focusGrid.tileWidth,
              height: focusGrid.tileHeight,
              focused: true
            })}
            {strip.length > 0 && (
              <div className="call-stage-strip" role="list" aria-label="Other cameras">
                {strip.map((p) => (
                  <div role="listitem" key={p.identity}>
                    {tile(p, { width: 160, height: 90, compact: true })}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div
            className="call-stage-grid"
            style={{
              gridTemplateColumns: `repeat(${grid.columns}, ${grid.tileWidth}px)`,
              gridAutoRows: `${grid.tileHeight}px`
            }}
          >
            {visible.map((p) => tile(p, { width: grid.tileWidth, height: grid.tileHeight }))}
          </div>
        )}
      </div>

      {!focusedPerson && pages > 1 && (
        <div className="call-stage-pager" role="navigation" aria-label="Camera pages">
          <button
            type="button"
            className="button secondary small"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </button>
          <span>
            Page {currentPage + 1} of {pages}
          </span>
          <button
            type="button"
            className="button secondary small"
            disabled={currentPage >= pages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </button>
        </div>
      )}

      {others.length > 0 && (
        <ul className="call-stage-others" aria-label="In voice without a camera">
          {others.map((p) => {
            const info = person(p)
            return (
              <li
                key={p.identity}
                className={`call-stage-person${info.speaking ? ' speaking' : ''}`}
                title={info.name}
              >
                <span className="voice-avatar">
                  <Avatar
                    name={info.name}
                    color={info.avatarColor}
                    imageId={info.avatarId}
                    size={32}
                    motion="still"
                  />
                </span>
                <span className="call-stage-person-name">
                  {p.isLocal ? `${info.name} (you)` : info.name}
                </span>
                {info.muted && <MicIcon size={14} slashed />}
                {info.deafened && <HeadphonesIcon size={14} slashed />}
              </li>
            )
          })}
        </ul>
      )}

      <div className="call-stage-controls">
        <CameraButton
          camera={state.camera}
          availability={cameraAvailability}
          onToggle={onToggleCamera}
          round
        />
      </div>
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </section>
  )
}

export default CallStage
