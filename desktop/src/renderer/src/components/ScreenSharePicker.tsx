import { useCallback, useEffect, useState } from 'react'
import { useDialog } from '../hooks/useDialog'
import type { ScreenCaptureCapabilities, ScreenSourceInfo } from '../../../preload/types'
import type { ScreenShareOptions, ScreenSource } from '../media/ScreenShareController'
import {
  SCREEN_CODEC_LABELS,
  SCREEN_MODE_LABELS,
  SCREEN_PROFILES,
  sourceSupportsProfile,
  type ScreenCodec,
  type ScreenContentHint,
  type ScreenProfileId
} from '../media/screenProfiles'
import { CloseIcon, RefreshIcon } from './Icons'

interface ScreenSharePickerProps {
  initial: ScreenShareOptions
  onGoLive: (source: ScreenSource, options: ScreenShareOptions) => void
  onClose: () => void
}

type Tab = 'screen' | 'window'

/** Outside Electron (browser dev mode) we can't enumerate sources; the browser shows its own picker. */
const BROWSER_SOURCE: ScreenSourceInfo = {
  id: 'browser',
  name: 'Screen (chosen in browser)',
  kind: 'screen',
  thumbnail: null,
  appIcon: null
}

function ScreenSharePicker({
  initial,
  onGoLive,
  onClose
}: ScreenSharePickerProps): React.JSX.Element {
  const bridge = window.d2
  const [tab, setTab] = useState<Tab>('screen')
  const [sources, setSources] = useState<ScreenSourceInfo[] | null>(
    bridge ? null : [BROWSER_SOURCE]
  )
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(bridge ? null : BROWSER_SOURCE.id)
  const [caps, setCaps] = useState<ScreenCaptureCapabilities | null>(null)
  const [profileId, setProfileId] = useState<ScreenProfileId>(initial.profileId)
  const [audio, setAudio] = useState(initial.audio)
  const [hint, setHint] = useState<ScreenContentHint>(initial.hint)
  const [codec, setCodec] = useState<ScreenCodec>(initial.codec)

  const load = useCallback(async (): Promise<void> => {
    if (!bridge) return
    const list = await bridge.screen.getSources().catch(() => null)
    setLoadError(list ? null : 'Could not list screens and windows.')
    setSources(list ?? [])
    setSelectedId((id) => (id && list?.some((s) => s.id === id) ? id : null))
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    void bridge.screen
      .getSources()
      .catch(() => null)
      .then((list) => {
        if (cancelled) return
        setLoadError(list ? null : 'Could not list screens and windows.')
        setSources(list ?? [])
      })
    void bridge.screen.getCapabilities().then((c) => {
      if (!cancelled) setCaps(c)
    })
    return () => {
      cancelled = true
    }
  }, [bridge])

  const dialogRef = useDialog<HTMLDivElement>({ onClose })

  const visible = (sources ?? []).filter((s) => !bridge || s.kind === tab)
  const selected = sources?.find((s) => s.id === selectedId)
  const profile = SCREEN_PROFILES[profileId]
  const supports =
    selected?.kind === 'screen' && selected.width && selected.height
      ? sourceSupportsProfile({ width: selected.width, height: selected.height }, profile)
      : undefined
  // Electron only offers system (loopback) audio on Windows; the browser dialog decides itself.
  const audioAvailable = bridge ? Boolean(caps?.systemAudio) : true

  const goLive = (source: ScreenSourceInfo | undefined = selected): void => {
    if (!source) return
    onGoLive(
      { id: source.id, name: source.name },
      { ...initial, profileId, audio: audio && audioAvailable, hint, codec }
    )
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal screen-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="screen-picker-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <CloseIcon size={18} />
        </button>
        <h2 id="screen-picker-title">Share your screen</h2>

        {bridge && (
          <div className="picker-tabs" role="tablist">
            {(
              [
                ['screen', 'Screens'],
                ['window', 'Applications']
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`picker-tab${tab === id ? ' selected' : ''}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className="icon-button picker-refresh"
              onClick={() => void load()}
              aria-label="Refresh sources"
              title="Refresh"
            >
              <RefreshIcon size={18} />
            </button>
          </div>
        )}

        <div className="picker-grid" role="listbox" aria-label="Sources">
          {sources === null ? (
            <div className="picker-empty">
              <div className="spinner" aria-hidden="true" />
              Looking for screens and windows…
            </div>
          ) : visible.length === 0 ? (
            <div className="picker-empty">
              {loadError ??
                (tab === 'screen' ? 'No screens found.' : 'No shareable windows are open.')}
            </div>
          ) : (
            visible.map((s) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={s.id === selectedId}
                className={`picker-source${s.id === selectedId ? ' selected' : ''}`}
                onClick={() => setSelectedId(s.id)}
                onDoubleClick={() => goLive(s)}
                title={s.name}
              >
                <span className="picker-thumb">
                  {s.thumbnail ? (
                    <img src={s.thumbnail} alt="" draggable={false} />
                  ) : (
                    <span className="picker-thumb-empty">
                      {bridge ? 'No preview' : 'Your browser will ask which screen to share'}
                    </span>
                  )}
                </span>
                <span className="picker-source-name">
                  {s.appIcon && <img className="picker-app-icon" src={s.appIcon} alt="" />}
                  <span>{s.name}</span>
                </span>
                {s.width && s.height ? (
                  <span className="picker-source-meta">
                    {s.width}×{s.height}
                    {s.primary ? ' · Primary' : ''}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>

        <div className="picker-options">
          <label className="setting-field">
            <span className="setting-field-label">Stream Quality</span>
            <select
              className="text-input"
              value={profileId}
              onChange={(e) => setProfileId(e.target.value as ScreenProfileId)}
            >
              {Object.values(SCREEN_PROFILES).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="setting-field">
            <span className="setting-field-label">Mode</span>
            <select
              className="text-input"
              value={hint}
              onChange={(e) => setHint(e.target.value as ScreenContentHint)}
            >
              {(Object.keys(SCREEN_MODE_LABELS) as ScreenContentHint[]).map((h) => (
                <option key={h} value={h}>
                  {SCREEN_MODE_LABELS[h].label}
                </option>
              ))}
            </select>
          </label>
          <label className="setting-field">
            <span className="setting-field-label">Codec</span>
            <select
              className="text-input"
              value={codec}
              onChange={(e) => setCodec(e.target.value as ScreenCodec)}
            >
              {(Object.keys(SCREEN_CODEC_LABELS) as ScreenCodec[]).map((c) => (
                <option key={c} value={c}>
                  {SCREEN_CODEC_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="picker-note">
          {profile.description} {SCREEN_MODE_LABELS[hint].description}
        </p>
        {profileId === 'high' && supports === false && (
          <p className="picker-note warn" role="status">
            This screen is smaller than 2560×1440, so it will be sent at its native size (not
            upscaled).
          </p>
        )}
        {profileId === 'high' && selected?.kind === 'window' && (
          <p className="picker-note">
            Windows are sent at their actual size, up to 2560×1440. Maximize the window on a 1440p
            display for full 1440p.
          </p>
        )}
        {codec !== 'h264' && (
          <p className="picker-note">
            {codec === 'av1'
              ? 'AV1 uses the GPU encoder on RTX 40, Radeon RX 7000 and Intel Arc GPUs (other GPUs encode in software). '
              : 'VP9 is encoded in software on Windows. '}
            Diagnostics shows which encoder is actually used.
          </p>
        )}

        <label className={`picker-audio${audioAvailable ? '' : ' disabled'}`}>
          <input
            type="checkbox"
            checked={audio && audioAvailable}
            disabled={!audioAvailable}
            onChange={(e) => setAudio(e.target.checked)}
          />
          <span>
            Share system audio
            <small>
              {!audioAvailable
                ? 'System audio sharing is only available on Windows.'
                : !bridge
                  ? 'Your browser decides whether audio can be shared.'
                  : caps?.excludeOwnAudio
                    ? 'Shares everything you hear except Discord 2.0 voices.'
                    : 'Shares everything you hear. On Windows 10 this can include other people’s voices; use headphones to avoid echo.'}
            </small>
          </span>
        </label>

        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!selected}
            onClick={() => goLive()}
          >
            Go Live
          </button>
        </div>
      </div>
    </div>
  )
}

export default ScreenSharePicker
