import { useEffect, useRef, useState } from 'react'
import type { ConnectionQualityLabel, MediaSession } from '../media/MediaSession'
import { useTrackStats } from '../hooks/useTrackStats'
import { receiverRows, senderRows, type StatRow } from '../media/statsFormat'
import type { InboundVideoStats, OutboundVideoStats } from '../media/stats'
import { ChartIcon, CloseIcon, ExpandIcon, FullscreenIcon, PopOutIcon, SpeakerIcon } from './Icons'

export type ViewerMode = 'focus' | 'mini'

interface StreamViewerProps {
  session: MediaSession
  identity: string
  isSelf: boolean
  sharerName: string
  channelName: string
  /** The sharer is still publishing. */
  live: boolean
  /** Changes whenever stream tracks appear/disappear, so the current track is looked up again. */
  streamRevision: number
  mode: ViewerMode
  quality: ConnectionQualityLabel
  /** Stream (system audio) volume in percent, or null when there is no stream audio to adjust. */
  volume: number | null
  defaultShowStats: boolean
  onVolumeChange: (volume: number) => void
  onModeChange: (mode: ViewerMode) => void
  onStopWatching: () => void
}

function StatsOverlay({ rows }: { rows: StatRow[] | null }): React.JSX.Element {
  if (!rows) return <div className="stream-stats">Collecting stats…</div>
  return (
    <dl className="stream-stats">
      {rows.map((r) => (
        <div key={r.label} className="stream-stats-row">
          <dt>{r.label}</dt>
          <dd>
            {r.kind === 'estimated' ? '≈ ' : ''}
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function StreamViewer({
  session,
  identity,
  isSelf,
  sharerName,
  channelName,
  live,
  streamRevision,
  mode,
  quality,
  volume,
  defaultShowStats,
  onVolumeChange,
  onModeChange,
  onStopWatching
}: StreamViewerProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [fit, setFit] = useState(true)
  const [showStats, setShowStats] = useState(defaultShowStats)
  const [fullscreen, setFullscreen] = useState(false)

  // Re-evaluated on every streamRevision change; the attach effect below only runs when the
  // underlying MediaStreamTrack actually changes (no detach/re-attach churn).
  void streamRevision
  const track = live ? session.getScreenTrack(identity) : undefined
  const mediaTrackId = track?.mediaStreamTrack?.id
  const stats = useTrackStats(track, isSelf ? 'outbound' : 'inbound', 1000)

  useEffect(() => {
    const el = videoRef.current
    if (!track || !el) return
    track.attach(el)
    return () => {
      track.detach(el)
    }
  }, [track, mediaTrackId])

  useEffect(() => {
    const onChange = (): void => setFullscreen(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // Leave fullscreen when the stream ends (or the viewer closes) so the user isn't stuck.
  useEffect(() => {
    if (!live && document.fullscreenElement === rootRef.current) void document.exitFullscreen()
  }, [live])
  useEffect(
    () => () => {
      if (document.fullscreenElement && document.fullscreenElement === rootRef.current) {
        void document.exitFullscreen()
      }
    },
    []
  )

  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void rootRef.current?.requestFullscreen().catch(() => undefined)
  }

  let format: string[] = []
  let rows: StatRow[] | null = null
  let stalled = false
  if (stats) {
    if (isSelf) {
      const out = stats.rtc as OutboundVideoStats
      const top = out.top
      format = [
        top?.width ? `${top.width}×${top.height}` : '',
        top?.encodedFps !== undefined ? `${Math.round(top.encodedFps)} fps sent` : '',
        top?.codec?.toUpperCase() ?? ''
      ]
      rows = senderRows(out)
    } else {
      const inb = stats.rtc as InboundVideoStats
      const shown = stats.playback.presentedFps ?? inb.decodedFps
      format = [
        inb.width ? `${inb.width}×${inb.height}` : '',
        shown !== undefined ? `${Math.round(shown)} fps shown` : '',
        inb.codec?.toUpperCase() ?? ''
      ]
      rows = receiverRows(inb, stats.playback)
      stalled = (inb.receivedFps ?? 1) < 1 && (shown ?? 1) < 1
    }
  }

  return (
    <div
      ref={rootRef}
      className={`stream-viewer ${mode}${fit ? ' fit' : ' actual'}${fullscreen ? ' fullscreen' : ''}`}
      role="region"
      aria-label={`${sharerName}'s stream`}
    >
      <header className="stream-header">
        <span className="live-badge">LIVE</span>
        <span
          className={`stream-quality quality-${quality}`}
          title={`Connection: ${quality}`}
          aria-label={`Connection ${quality}`}
        />
        <span className="stream-title" title={`${sharerName} in ${channelName}`}>
          {isSelf ? 'Your stream' : sharerName}
          {mode === 'focus' && <span className="stream-where"> · {channelName}</span>}
        </span>
        {mode === 'focus' && live && (
          <span className="stream-format">{format.filter(Boolean).join(' · ')}</span>
        )}
        {live && stalled && <span className="stream-stalled">Stalled</span>}
        <span className="stream-actions">
          {mode === 'focus' ? (
            <>
              <button
                type="button"
                className={`icon-button${showStats ? ' on' : ''}`}
                onClick={() => setShowStats((s) => !s)}
                aria-pressed={showStats}
                aria-label="Stream stats"
                title="Stream stats"
              >
                <ChartIcon size={18} />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => setFit((f) => !f)}
                aria-label={fit ? 'Actual size' : 'Fit to window'}
                title={fit ? 'Actual size' : 'Fit to window'}
              >
                <ExpandIcon size={18} />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={toggleFullscreen}
                aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                <FullscreenIcon size={18} exit={fullscreen} />
              </button>
              {!fullscreen && (
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => onModeChange('mini')}
                  aria-label="Pop out"
                  title="Keep watching while you chat"
                >
                  <PopOutIcon size={18} />
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="icon-button"
              onClick={() => onModeChange('focus')}
              aria-label="Expand stream"
              title="Expand"
            >
              <ExpandIcon size={16} />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            onClick={onStopWatching}
            aria-label={isSelf ? 'Close preview' : 'Stop watching'}
            title={isSelf ? 'Close preview' : 'Stop watching'}
          >
            <CloseIcon size={mode === 'focus' ? 18 : 16} />
          </button>
        </span>
      </header>

      <div
        className="stream-stage"
        onDoubleClick={mode === 'focus' ? toggleFullscreen : () => onModeChange('focus')}
      >
        <video ref={videoRef} className="stream-video" autoPlay playsInline muted />
        {!live ? (
          <div className="stream-overlay">
            <strong>Stream ended</strong>
            <span>{isSelf ? 'You stopped sharing.' : `${sharerName} stopped streaming.`}</span>
            <button type="button" className="button secondary" onClick={onStopWatching}>
              Close
            </button>
          </div>
        ) : !track ? (
          <div className="stream-overlay">
            <div className="spinner" aria-hidden="true" />
            <span>Joining stream…</span>
          </div>
        ) : null}
        {showStats && live && mode === 'focus' && <StatsOverlay rows={rows} />}
      </div>

      {mode === 'focus' && volume !== null && live && (
        <footer className="stream-footer">
          <SpeakerIcon size={18} />
          <input
            className="slider"
            type="range"
            min={0}
            max={200}
            step={5}
            value={volume}
            onChange={(e) => onVolumeChange(Number(e.target.value))}
            aria-label="Stream volume"
          />
          <span className="stream-volume">{volume}%</span>
        </footer>
      )}
    </div>
  )
}

export default StreamViewer
