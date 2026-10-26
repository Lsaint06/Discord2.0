import { useEffect, useRef, useState } from 'react'
import type { MediaSession } from '../media/MediaSession'
import { useTrackStats } from '../hooks/useTrackStats'
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
  /** Re-render trigger: changes whenever stream tracks appear/disappear. */
  streamRevision: number
  mode: ViewerMode
  /** Stream (system audio) volume in percent, or null when there is no stream audio to adjust. */
  volume: number | null
  defaultShowStats: boolean
  onVolumeChange: (volume: number) => void
  onModeChange: (mode: ViewerMode) => void
  onStopWatching: () => void
}

function fmt(n: number | undefined, unit = ''): string {
  return n === undefined ? '—' : `${Math.round(n)}${unit}`
}

function StatsOverlay({
  stats,
  isSelf
}: {
  stats: InboundVideoStats | OutboundVideoStats | null
  isSelf: boolean
}): React.JSX.Element {
  if (!stats) return <div className="stream-stats">Collecting stats…</div>
  const out = isSelf ? (stats as OutboundVideoStats) : null
  const inb = isSelf ? null : (stats as InboundVideoStats)
  const impl = out?.encoder ?? inb?.decoder
  return (
    <dl className="stream-stats">
      <dt>Resolution</dt>
      <dd>{stats.width && stats.height ? `${stats.width}×${stats.height}` : '—'}</dd>
      <dt>Frame rate</dt>
      <dd>{fmt(stats.fps, ' fps')}</dd>
      <dt>Bitrate</dt>
      <dd>
        {stats.bitrateKbps === undefined ? '—' : `${(stats.bitrateKbps / 1000).toFixed(1)} Mbps`}
      </dd>
      <dt>Codec</dt>
      <dd>{stats.codec ?? '—'}</dd>
      <dt>{isSelf ? 'Encoder' : 'Decoder'}</dt>
      <dd>
        {impl ?? '—'}
        {stats.powerEfficient === true
          ? ' (hardware)'
          : stats.powerEfficient === false
            ? ' (software)'
            : ''}
      </dd>
      {out && (
        <>
          <dt>Encode time</dt>
          <dd>{out.encodeMsPerFrame === undefined ? '—' : `${out.encodeMsPerFrame} ms/frame`}</dd>
          <dt>Limited by</dt>
          <dd>{out.qualityLimitation ?? '—'}</dd>
        </>
      )}
      {inb && (
        <>
          <dt>Dropped frames</dt>
          <dd>{fmt(inb.framesDropped)}</dd>
          <dt>Jitter</dt>
          <dd>{fmt(inb.jitterMs, ' ms')}</dd>
        </>
      )}
      <dt>Packet loss</dt>
      <dd>{stats.packetLossPct === undefined ? '—' : `${stats.packetLossPct}%`}</dd>
      <dt>Round trip</dt>
      <dd>{fmt(stats.rttMs, ' ms')}</dd>
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
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  // streamRevision is part of the key so a republished track is picked up.
  const track = live ? session.getScreenTrack(identity) : undefined
  const trackKey = `${streamRevision}:${track?.sid ?? ''}`
  const stats = useTrackStats(track, isSelf ? 'outbound' : 'inbound', showStats ? 1000 : 2000)

  useEffect(() => {
    const el = videoRef.current
    if (!track || !el) return
    track.attach(el)
    return () => {
      track.detach(el)
    }
    // trackKey covers re-attachment after a republish of the same Track object.
  }, [track, trackKey])

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

  const resolution = size ? `${size.w}×${size.h}` : null
  const fps = stats?.fps
  const codec = stats?.codec?.toUpperCase()

  return (
    <div
      ref={rootRef}
      className={`stream-viewer ${mode}${fit ? ' fit' : ' actual'}${fullscreen ? ' fullscreen' : ''}`}
      role="region"
      aria-label={`${sharerName}'s stream`}
    >
      <header className="stream-header">
        <span className="live-badge">LIVE</span>
        <span className="stream-title" title={`${sharerName} in ${channelName}`}>
          {isSelf ? 'Your stream' : sharerName}
          {mode === 'focus' && <span className="stream-where"> · {channelName}</span>}
        </span>
        {mode === 'focus' && live && (
          <span className="stream-format">
            {[resolution, fps !== undefined ? `${Math.round(fps)} fps` : null, codec]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
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
        <video
          ref={videoRef}
          className="stream-video"
          autoPlay
          playsInline
          muted
          onResize={(e) =>
            setSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })
          }
        />
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
        {showStats && live && mode === 'focus' && <StatsOverlay stats={stats} isSelf={isSelf} />}
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
