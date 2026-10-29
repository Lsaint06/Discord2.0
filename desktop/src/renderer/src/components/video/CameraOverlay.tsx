import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Track } from 'livekit-client'
import type { MediaSession, MediaSnapshot, VoiceParticipant } from '../../media/MediaSession'
import type { OverlayDisplay } from '../../../../preload/types'
import {
  overlayLayout,
  overlayTiles,
  overlayVisible,
  positionFromBounds,
  type OverlayLayoutKind,
  type OverlaySettings,
  type OverlaySize
} from '../../lib/overlay'
import type { TilePerson } from './VideoTile'
import overlayCss from './overlay.css?inline'

const WINDOW_NAME = 'd2-camera-overlay'
const SIZES: OverlaySize[] = ['small', 'medium', 'large']
const LAYOUTS: OverlayLayoutKind[] = ['grid', 'row', 'stack']
const LAYOUT_LABELS: Record<OverlayLayoutKind, string> = {
  grid: 'Grid',
  row: 'Row',
  stack: 'Stack'
}

/** LiveKit's adaptive-stream element info (RemoteVideoTrack.observeElementInfo). */
interface ElementInfo {
  element: object
  width(): number
  height(): number
  visible: boolean
  pictureInPicture: boolean
  visibilityChangedAt: number | undefined
  handleResize?: () => void
  handleVisibilityChanged?: () => void
  observe(): void
  stopObserving(): void
}
type ObservableTrack = Track & {
  observeElementInfo?: (info: ElementInfo) => void
  stopObservingElementInfo?: (info: ElementInfo) => void
}

interface OverlayTileProps {
  person: TilePerson
  track: Track | undefined
  width: number
  height: number
  mirror: boolean
  shown: boolean
  pinned: boolean
  showName: boolean
  showSpeaking: boolean
  sample?: number
  onPin?: () => void
}

/**
 * One camera in the overlay window. The video element lives in the overlay's document but plays
 * the SAME MediaStreamTrack the app already receives (no second connection or decode). For remote
 * cameras the tile tells LiveKit its size and whether it's on screen, so LiveKit sends a small
 * layer while the overlay is shown — even when the Discord 2.0 window itself is minimized — and
 * nothing while it's hidden.
 */
function OverlayTile({
  person,
  track,
  width,
  height,
  mirror,
  shown,
  pinned,
  showName,
  showSpeaking,
  sample,
  onPin
}: OverlayTileProps): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const size = useRef({ width, height })
  useLayoutEffect(() => {
    size.current = { width, height }
  }, [width, height])
  const infoRef = useRef<ElementInfo | null>(null)
  const [playing, setPlaying] = useState(false)
  const mediaTrack = track?.mediaStreamTrack

  useEffect(() => {
    const el = ref.current
    if (!el || !track || !mediaTrack) return
    setPlaying(false)
    el.srcObject = new MediaStream([mediaTrack])
    const onPlaying = (): void => setPlaying(true)
    el.addEventListener('playing', onPlaying)
    void el.play().catch(() => undefined)
    const observable = track as ObservableTrack
    let info: ElementInfo | null = null
    if (observable.observeElementInfo && observable.stopObservingElementInfo) {
      info = {
        element: el,
        width: () => size.current.width,
        height: () => size.current.height,
        visible: shown,
        pictureInPicture: shown,
        visibilityChangedAt: Date.now(),
        observe: () => undefined,
        stopObserving: () => undefined
      }
      infoRef.current = info
      observable.observeElementInfo(info)
    }
    return () => {
      el.removeEventListener('playing', onPlaying)
      if (info) observable.stopObservingElementInfo?.(info)
      infoRef.current = null
      el.srcObject = null
    }
    // `shown` is applied by the effect below without re-attaching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, mediaTrack])

  useEffect(() => {
    const info = infoRef.current
    if (!info) return
    info.visible = shown
    info.pictureInPicture = shown
    info.visibilityChangedAt = Date.now()
    info.handleVisibilityChanged?.()
  }, [shown])

  useEffect(() => {
    infoRef.current?.handleResize?.()
  }, [width, height])

  const initials = person.name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <div
      className={`overlay-tile${showSpeaking && person.speaking ? ' speaking' : ''}${pinned ? ' pinned' : ''}`}
      style={{ width, height }}
      onClick={onPin}
      title={onPin ? (pinned ? `Unpin ${person.name}` : `Pin ${person.name} first`) : undefined}
    >
      {sample === undefined && (
        <video
          ref={ref}
          className={`${mirror ? 'mirrored' : ''}${playing ? '' : ' waiting'}`}
          muted
          playsInline
          autoPlay
        />
      )}
      {(sample !== undefined || !playing) && <div className="overlay-placeholder">{initials}</div>}
      {showName && <span className="overlay-name">{person.name}</span>}
    </div>
  )
}

interface CameraOverlayProps {
  session: MediaSession
  state: MediaSnapshot
  person: (p: VoiceParticipant) => TilePerson
  settings: OverlaySettings
  mirror: boolean
  /** Hidden with the show/hide shortcut (the call is unaffected). */
  hidden: boolean
  /** Edit mode: draggable, with a toolbar; otherwise click-through. */
  editing: boolean
  /** Opened from Settings to position it (sample tiles if nobody's camera is on). */
  arranging: boolean
  onChange: (patch: Partial<OverlaySettings>) => void
  onEditDone: () => void
  /** The window was closed from outside (e.g. Alt+F4 while editing). */
  onClosed: () => void
  onError: (message: string) => void
}

/** Owns the overlay window: opens it when needed, positions it, and renders the tiles into it. */
function CameraOverlay({
  session,
  state,
  person,
  settings,
  mirror,
  hidden,
  editing,
  arranging,
  onChange,
  onEditDone,
  onClosed,
  onError
}: CameraOverlayProps): React.JSX.Element | null {
  const bridge = window.d2?.overlay
  const [target, setTarget] = useState<{ win: Window; root: HTMLElement } | null>(null)
  const [displays, setDisplays] = useState<OverlayDisplay[]>([])
  const [appFocused, setAppFocused] = useState(() => document.hasFocus())
  const inVoice = state.status === 'connected'
  const want = Boolean(bridge) && ((settings.enabled && inVoice) || arranging)
  void state.streamRevision

  const live = useMemo(
    () =>
      overlayTiles(state.participants, settings).map((p) => ({ participant: p, info: person(p) })),
    [state.participants, settings, person]
  )
  const samples = (arranging || editing) && live.length === 0
  const tileCount = samples ? settings.maxVisible : live.length
  const layout = useMemo(
    () => overlayLayout(settings, tileCount, displays, { edit: editing }),
    [settings, tileCount, displays, editing]
  )
  const visible =
    overlayVisible({
      enabled: settings.enabled,
      hidden,
      inVoice,
      tiles: live.length,
      appFocused,
      showWhenAppFocused: settings.showWhenAppFocused,
      // While positioning it, it is always shown (with sample tiles if nobody's camera is on).
      arranging: arranging || editing
    }) && layout !== null

  // Main window focus decides "hide while Discord 2.0 is in front".
  useEffect(() => {
    const onFocus = (): void => setAppFocused(true)
    const onBlur = (): void => setAppFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const onClosedRef = useRef(onClosed)
  const latest = useRef({ displays, onChange })
  useLayoutEffect(() => {
    onClosedRef.current = onClosed
    latest.current = { displays, onChange }
  }, [onClosed, displays, onChange])
  useEffect(() => {
    if (!bridge) return
    const load = (): void => {
      void bridge.getDisplays().then((d) => d && setDisplays(d))
    }
    load()
    return bridge.onEvent((event) => {
      if (event.type === 'displays') load()
      else if (event.type === 'closed') {
        setTarget(null)
        onClosedRef.current()
      } else if (event.type === 'moved') {
        const position = positionFromBounds(event.bounds, latest.current.displays)
        if (position) latest.current.onChange({ position })
      }
    })
  }, [bridge])

  // One window for as long as it's wanted (not one per camera or per frame).
  useEffect(() => {
    if (!want || !bridge) return
    const child = window.open('about:blank', WINDOW_NAME, 'width=470,height=270')
    if (!child) {
      onError('The camera overlay window couldn’t be opened.')
      return
    }
    const doc = child.document
    doc.title = 'Discord 2.0 camera overlay'
    const style = doc.createElement('style')
    style.textContent = overlayCss
    doc.head.appendChild(style)
    const root = doc.createElement('div')
    doc.body.appendChild(root)
    // The window is an external system that exists only now: publishing it to state is the
    // effect's purpose (the portal can't render before the window does).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTarget({ win: child, root })
    return () => {
      setTarget(null)
      void bridge.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, bridge])

  // Position, mode (click-through or edit) and visibility.
  useEffect(() => {
    if (!target || !bridge) return
    const bounds = layout?.bounds ?? { x: 0, y: 0, width: 470, height: 270 }
    void bridge.update({ visible, mode: editing && visible ? 'edit' : 'view', bounds })
  }, [target, bridge, layout, visible, editing])

  if (!target || !layout) return null
  const tiles = samples
    ? Array.from({ length: Math.min(settings.maxVisible, layout.visible) }, (_, i) => ({
        key: `sample-${i}`,
        sample: i,
        info: {
          identity: `sample-${i}`,
          name: `Friend ${i + 1}`,
          avatarColor: '#5865f2',
          isLocal: false,
          speaking: i === 0,
          muted: false,
          deafened: false
        } as TilePerson,
        participant: null as VoiceParticipant | null
      }))
    : live.slice(0, layout.visible).map(({ participant, info }) => ({
        key: participant.identity,
        sample: undefined,
        info,
        participant
      }))

  const sizeIndex = SIZES.indexOf(settings.size)
  const view = (
    <div
      className={`overlay${editing ? ' editing' : ''}${settings.locked ? ' locked' : ''}`}
      style={{ '--overlay-opacity': String(settings.opacity / 100) } as React.CSSProperties}
    >
      {editing && (
        <div className="overlay-toolbar">
          <span className="overlay-drag">
            {settings.locked ? 'Position locked' : '⠿ Drag to move'}
          </span>
          <button
            type="button"
            aria-label="Smaller"
            title="Smaller"
            disabled={sizeIndex <= 0}
            onClick={() => onChange({ size: SIZES[Math.max(0, sizeIndex - 1)] })}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Bigger"
            title="Bigger"
            disabled={sizeIndex >= SIZES.length - 1}
            onClick={() => onChange({ size: SIZES[Math.min(SIZES.length - 1, sizeIndex + 1)] })}
          >
            +
          </button>
          <button
            type="button"
            title="Change layout"
            onClick={() =>
              onChange({ layout: LAYOUTS[(LAYOUTS.indexOf(settings.layout) + 1) % LAYOUTS.length] })
            }
          >
            {LAYOUT_LABELS[settings.layout]}
          </button>
          <button type="button" className="overlay-done" onClick={onEditDone}>
            Done
          </button>
        </div>
      )}
      <div
        className="overlay-grid"
        style={{ gridTemplateColumns: `repeat(${layout.columns}, ${layout.tile.width}px)` }}
      >
        {tiles.map((t) => (
          <OverlayTile
            key={t.key}
            person={t.info}
            sample={t.sample}
            track={t.participant ? session.getCameraTrack(t.participant.identity) : undefined}
            width={layout.tile.width}
            height={layout.tile.height}
            mirror={Boolean(t.participant?.isLocal) && mirror}
            shown={visible}
            pinned={settings.pinned === t.info.identity}
            showName={settings.showNames}
            showSpeaking={settings.showSpeaking}
            onPin={
              editing && t.participant
                ? () =>
                    onChange({
                      pinned: settings.pinned === t.info.identity ? null : t.info.identity
                    })
                : undefined
            }
          />
        ))}
      </div>
    </div>
  )
  return createPortal(view, target.root)
}

export default CameraOverlay
