import { useCallback, useEffect, useRef, useState } from 'react'
import type { MicrophoneAccess, OverlayDisplay } from '../../../preload/types'
import type { UserSettings } from '../types'
import type { MediaSession, MediaSnapshot } from '../media/MediaSession'
import {
  CAMERA_PRESETS,
  cameraConstraints,
  cameraErrorMessage,
  type CameraPresetId
} from '../media/cameraProfiles'
import {
  DEFAULT_OVERLAY,
  type OverlayAnchor,
  type OverlayLayoutKind,
  type OverlaySettings,
  type OverlaySize
} from '../lib/overlay'
import { Field, Toggle } from './SettingsControls'

interface VideoSettingsProps {
  session: MediaSession
  state: MediaSnapshot
  settings: UserSettings
  onChange: (patch: Partial<UserSettings>) => void
  /** Shows the overlay with sample tiles so it can be dragged into place. */
  onArrangeOverlay: () => void
  /** The pinned person's name, if any. */
  pinnedName: string | null
}

type PreviewState = 'off' | 'starting' | 'on' | 'error'

/**
 * Settings → Video & Overlay. The camera preview here is only for you: it never publishes
 * anything, stops when you leave this page, and is separate from turning your camera on in a call.
 */
function VideoSettings({
  session,
  state,
  settings,
  onChange,
  onArrangeOverlay,
  pinnedName
}: VideoSettingsProps): React.JSX.Element {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [access, setAccess] = useState<MicrophoneAccess>('unknown')
  const [preview, setPreview] = useState<PreviewState>('off')
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewInfo, setPreviewInfo] = useState<string | null>(null)
  /** 'call' = showing your live call camera; 'own' = a private preview capture. */
  const [previewSource, setPreviewSource] = useState<'own' | 'call'>('own')
  const [displays, setDisplays] = useState<OverlayDisplay[]>([])
  const videoRef = useRef<HTMLVideoElement>(null)
  const ownTrack = useRef<MediaStreamTrack | null>(null)
  const previewSeq = useRef(0)
  const callCameraOn = state.camera.status === 'on'
  const overlay = settings.overlay

  const loadDevices = useCallback((): void => {
    void navigator.mediaDevices
      .enumerateDevices()
      .catch(() => [] as MediaDeviceInfo[])
      .then((all) => setCameras(all.filter((d) => d.kind === 'videoinput' && d.deviceId !== '')))
    void window.d2?.media.getCameraAccess().then(setAccess)
  }, [])

  useEffect(() => {
    loadDevices()
    navigator.mediaDevices.addEventListener('devicechange', loadDevices)
    void window.d2?.overlay.getDisplays().then((d) => d && setDisplays(d))
    return () => navigator.mediaDevices.removeEventListener('devicechange', loadDevices)
  }, [loadDevices])

  const stopPreview = useCallback((): void => {
    previewSeq.current++
    ownTrack.current?.stop()
    ownTrack.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setPreview('off')
    setPreviewInfo(null)
  }, [])

  // Leaving this page (or closing Settings) always closes the preview camera.
  useEffect(
    () => () => {
      previewSeq.current++
      ownTrack.current?.stop()
      ownTrack.current = null
    },
    []
  )

  const startPreview = useCallback(
    async (choice?: { deviceId: string; preset: CameraPresetId }): Promise<void> => {
      const deviceId = choice?.deviceId ?? settings.cameraDeviceId
      const presetId = choice?.preset ?? settings.cameraPreset
      stopPreview()
      const seq = ++previewSeq.current
      setPreviewError(null)
      // Your camera is already on in a call: show that same track (no second capture).
      const live = session.getLocalCameraTrack()
      if (live) {
        if (videoRef.current) videoRef.current.srcObject = new MediaStream([live])
        setPreviewSource('call')
        setPreview('on')
        setPreviewInfo('This is what the others in your call see.')
        return
      }
      setPreviewSource('own')
      setPreview('starting')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: cameraConstraints(CAMERA_PRESETS[presetId], deviceId || undefined),
          audio: false
        })
        const [track] = stream.getVideoTracks()
        if (seq !== previewSeq.current || !track) {
          for (const t of stream.getTracks()) t.stop()
          return
        }
        ownTrack.current = track
        track.addEventListener('ended', () => {
          if (ownTrack.current === track) {
            stopPreview()
            setPreviewError('The camera stopped (unplugged or taken by another app).')
          }
        })
        if (videoRef.current) videoRef.current.srcObject = new MediaStream([track])
        const s = track.getSettings()
        setPreview('on')
        setPreviewInfo(
          `Preview only — nobody else sees this. ${track.label || 'Camera'}: ${s.width ?? '?'}×${s.height ?? '?'} at ${Math.round(s.frameRate ?? 0)} fps.`
        )
        loadDevices()
      } catch (err) {
        if (seq !== previewSeq.current) return
        setPreview('error')
        setPreviewError(cameraErrorMessage(err))
        loadDevices()
      }
    },
    [session, settings.cameraPreset, settings.cameraDeviceId, stopPreview, loadDevices]
  )

  // Changing the device or quality while previewing restarts the preview with the new choice.
  const previewing = preview === 'on' || preview === 'starting'
  const changeCamera = (patch: {
    cameraDeviceId?: string
    cameraPreset?: CameraPresetId
  }): void => {
    onChange(patch)
    if (previewing && !callCameraOn)
      void startPreview({
        deviceId: patch.cameraDeviceId ?? settings.cameraDeviceId,
        preset: patch.cameraPreset ?? settings.cameraPreset
      })
  }

  const selectedMissing =
    settings.cameraDeviceId !== '' &&
    cameras.length > 0 &&
    !cameras.some((c) => c.deviceId === settings.cameraDeviceId)
  const labelsHidden = cameras.length > 0 && cameras.every((c) => !c.label)
  const setOverlay = (patch: Partial<OverlaySettings>): void =>
    onChange({ overlay: { ...overlay, ...patch } })

  return (
    <>
      <h2>Video &amp; Overlay</h2>

      <h3>Camera</h3>
      <p className="settings-note">
        Your camera is always off when you join a call. It only turns on when you press the camera
        button in voice, and turns off when you leave, switch channels or reconnect.
      </p>
      {access === 'denied' || access === 'restricted' ? (
        <div className="dev-notice danger" role="alert">
          <strong>Camera access is blocked by Windows</strong>
          <span>
            Turn on “Camera access” and “Let desktop apps access your camera”, then try again.
          </span>
          <button
            type="button"
            className="link-button"
            onClick={() => void window.d2?.media.openCameraSettings()}
          >
            Open Windows camera settings
          </button>
        </div>
      ) : null}

      <div className="settings-grid">
        <Field label="Camera">
          <div className="inline-actions">
            <select
              className="text-input"
              value={settings.cameraDeviceId}
              onChange={(e) => changeCamera({ cameraDeviceId: e.target.value })}
              aria-label="Camera device"
            >
              <option value="">Default camera</option>
              {cameras.map((c, i) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label || `Camera ${i + 1}`}
                </option>
              ))}
            </select>
            <button type="button" className="button secondary small" onClick={loadDevices}>
              Refresh
            </button>
          </div>
        </Field>
        <Field label="Video quality">
          <select
            className="text-input"
            value={settings.cameraPreset}
            onChange={(e) => changeCamera({ cameraPreset: e.target.value as CameraPresetId })}
            aria-label="Video quality"
          >
            {Object.values(CAMERA_PRESETS).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="settings-note">
        {CAMERA_PRESETS[settings.cameraPreset].description} The camera sends the best it can up to
        this; it’s never forced.
      </p>
      {cameras.length === 0 && (
        <p className="settings-note">No camera found. Connect one and press Refresh.</p>
      )}
      {labelsHidden && (
        <p className="settings-note">Camera names appear after you start a preview once.</p>
      )}
      {selectedMissing && (
        <p className="settings-note warn">
          Your selected camera isn’t connected; your default camera will be used.
        </p>
      )}

      <div className={`camera-preview${settings.cameraMirror ? ' mirrored' : ''}`}>
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          aria-label="Camera preview"
          className={previewing ? '' : 'hidden'}
        />
        {!previewing && (
          <span className="camera-preview-empty">
            {preview === 'error' ? 'Preview failed' : 'Preview is off'}
          </span>
        )}
        {previewing && (
          <span className={`camera-preview-badge${previewSource === 'call' ? ' live' : ''}`}>
            {previewSource === 'call' ? 'LIVE in call' : 'Preview — not sent'}
          </span>
        )}
      </div>
      <div className="inline-actions">
        {previewing ? (
          <button type="button" className="button secondary" onClick={stopPreview}>
            Stop Preview
          </button>
        ) : (
          <button type="button" className="button primary" onClick={() => void startPreview()}>
            Start Preview
          </button>
        )}
      </div>
      {previewInfo && (
        <p className="settings-note" role="status">
          {previewInfo}
        </p>
      )}
      {previewError && (
        <p className="form-error" role="alert">
          {previewError}
        </p>
      )}

      <Toggle
        label="Mirror my video"
        description="Only for you (preview and self-view). Others always see you the right way round."
        checked={settings.cameraMirror}
        onChange={(cameraMirror) => onChange({ cameraMirror })}
      />
      <Toggle
        label="Hide my self-view in calls"
        description="Your camera keeps sending; you just don’t see your own tile."
        checked={settings.cameraHideSelf}
        onChange={(cameraHideSelf) => onChange({ cameraHideSelf })}
      />
      <Toggle
        label="Show other people’s cameras"
        description="Turn off to save bandwidth; you’ll see avatars instead."
        checked={settings.receiveCameras}
        onChange={(receiveCameras) => onChange({ receiveCameras })}
      />

      <h3>Camera overlay</h3>
      <p className="settings-note">
        Small floating camera tiles that stay on top of other apps and games while you’re in voice.
        They let clicks pass through to your game. Turning this on never turns your camera on.
      </p>
      <Toggle
        label="Show the camera overlay"
        description="Off by default. You can also hide it instantly with its shortcut (Keybinds) or from the voice panel."
        checked={overlay.enabled}
        onChange={(enabled) => setOverlay({ enabled })}
      />
      <div className="settings-grid">
        <Field label="Layout">
          <select
            className="text-input"
            value={overlay.layout}
            onChange={(e) => setOverlay({ layout: e.target.value as OverlayLayoutKind })}
          >
            <option value="grid">Compact grid</option>
            <option value="row">Horizontal row</option>
            <option value="stack">Vertical stack</option>
          </select>
        </Field>
        <Field label="Size">
          <select
            className="text-input"
            value={overlay.size}
            onChange={(e) => setOverlay({ size: e.target.value as OverlaySize })}
          >
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </Field>
        <Field label="Cameras shown">
          <select
            className="text-input"
            value={overlay.maxVisible}
            onChange={(e) =>
              setOverlay({ maxVisible: Number(e.target.value) as OverlaySettings['maxVisible'] })
            }
          >
            {[2, 4, 6, 8].map((n) => (
              <option key={n} value={n}>
                Up to {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Position">
          <select
            className="text-input"
            value={overlay.position.anchor}
            onChange={(e) =>
              setOverlay({
                position: { ...overlay.position, anchor: e.target.value as OverlayAnchor }
              })
            }
          >
            <option value="top-right">Top right</option>
            <option value="top-left">Top left</option>
            <option value="bottom-right">Bottom right</option>
            <option value="bottom-left">Bottom left</option>
            <option value="custom">Where I dragged it</option>
          </select>
        </Field>
        <Field label="Display">
          <select
            className="text-input"
            value={overlay.position.displayId === null ? '' : String(overlay.position.displayId)}
            onChange={(e) =>
              setOverlay({
                position: {
                  ...overlay.position,
                  displayId: e.target.value === '' ? null : Number(e.target.value)
                }
              })
            }
          >
            <option value="">Main display</option>
            {displays.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label} — {d.bounds.width}×{d.bounds.height}
                {d.scaleFactor !== 1 ? ` (${Math.round(d.scaleFactor * 100)}%)` : ''}
                {d.primary ? ' (main)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Opacity — ${overlay.opacity}%`}>
          <input
            type="range"
            min={40}
            max={100}
            step={5}
            value={overlay.opacity}
            onChange={(e) => setOverlay({ opacity: Number(e.target.value) })}
            aria-label="Overlay opacity"
          />
        </Field>
      </div>
      <Toggle
        label="Show names"
        checked={overlay.showNames}
        onChange={(showNames) => setOverlay({ showNames })}
      />
      <Toggle
        label="Highlight who’s speaking"
        checked={overlay.showSpeaking}
        onChange={(showSpeaking) => setOverlay({ showSpeaking })}
      />
      <Toggle
        label="Include my own camera"
        description="Only while your camera is on."
        checked={overlay.showSelf}
        onChange={(showSelf) => setOverlay({ showSelf })}
      />
      <Toggle
        label="Lock position"
        description="Edit mode can’t move it while locked."
        checked={overlay.locked}
        onChange={(locked) => setOverlay({ locked })}
      />
      <Toggle
        label="Also show it while Discord 2.0 is in front"
        description="Off: it hides while you’re looking at Discord 2.0 (you see the cameras there)."
        checked={overlay.showWhenAppFocused}
        onChange={(showWhenAppFocused) => setOverlay({ showWhenAppFocused })}
      />
      {pinnedName && (
        <p className="settings-note">
          Pinned first: <strong>{pinnedName}</strong>{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => setOverlay({ pinned: null })}
          >
            Unpin
          </button>
        </p>
      )}
      <div className="inline-actions">
        <button
          type="button"
          className="button secondary"
          onClick={onArrangeOverlay}
          disabled={!window.d2}
        >
          Arrange overlay…
        </button>
        <button
          type="button"
          className="button secondary"
          onClick={() => onChange({ overlay: { ...DEFAULT_OVERLAY, enabled: overlay.enabled } })}
        >
          Restore defaults
        </button>
      </div>
      <p className="settings-note">
        Works over windowed and borderless (“fullscreen windowed”) games and normal apps. Games in
        exclusive fullscreen can draw over it — that’s a Windows limitation Discord 2.0 doesn’t try
        to get around. It never reads or changes a game. In edit mode you can drag it and click a
        tile to pin that person first.
      </p>
    </>
  )
}

export default VideoSettings
