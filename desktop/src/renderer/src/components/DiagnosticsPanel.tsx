import { useEffect, useState } from 'react'
import type { AppMetrics, ScreenCaptureCapabilities } from '../../../preload/types'
import type { MediaSession, MediaSnapshot } from '../media/MediaSession'
import type { InboundVideoStats, OutboundVideoStats } from '../media/stats'
import { useTrackStats } from '../hooks/useTrackStats'

interface DiagnosticsPanelProps {
  session: MediaSession
  state: MediaSnapshot
  userName: (userId: string) => string
}

const mbps = (kbps: number | undefined): string =>
  kbps === undefined ? '—' : `${(kbps / 1000).toFixed(2)} Mbps`
const val = (v: number | string | undefined, unit = ''): string =>
  v === undefined || v === ''
    ? '—'
    : `${typeof v === 'number' ? Math.round(v * 10) / 10 : v}${unit}`

function hw(powerEfficient: boolean | undefined): string {
  if (powerEfficient === true) return 'Yes (power-efficient)'
  if (powerEfficient === false) return 'No (software)'
  return 'Not reported'
}

function Rows({ rows }: { rows: [string, string][] }): React.JSX.Element {
  return (
    <dl className="diag-rows">
      {rows.map(([k, v]) => (
        <div key={k} className="diag-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function outboundRows(s: OutboundVideoStats): [string, string][] {
  return [
    [
      'Capture',
      s.captureWidth ? `${s.captureWidth}×${s.captureHeight} @ ${val(s.captureFps, ' fps')}` : '—'
    ],
    ['Sent', s.width ? `${s.width}×${s.height} @ ${val(s.fps, ' fps')}` : '—'],
    ['Bitrate', mbps(s.bitrateKbps)],
    ['Codec', s.codec ?? '—'],
    ['Encoder', s.encoder ?? 'Not reported'],
    ['Hardware encoder', hw(s.powerEfficient)],
    ['Encode time', val(s.encodeMsPerFrame, ' ms/frame')],
    ['Quality limited by', s.qualityLimitation ?? '—'],
    ['Active layers', String(s.layers)],
    ['Round trip', val(s.rttMs, ' ms')],
    ['Packet loss', val(s.packetLossPct, '%')]
  ]
}

function inboundRows(s: InboundVideoStats): [string, string][] {
  return [
    ['Received', s.width ? `${s.width}×${s.height} @ ${val(s.fps, ' fps')}` : '—'],
    ['Bitrate', mbps(s.bitrateKbps)],
    ['Codec', s.codec ?? '—'],
    ['Decoder', s.decoder ?? 'Not reported'],
    ['Hardware decoder', hw(s.powerEfficient)],
    ['Dropped frames', val(s.framesDropped)],
    ['Jitter', val(s.jitterMs, ' ms')],
    ['Packet loss', val(s.packetLossPct, '%')],
    ['Round trip', val(s.rttMs, ' ms')]
  ]
}

/** Live media diagnostics. Sampling only runs while this panel is mounted. */
function DiagnosticsPanel({ session, state, userName }: DiagnosticsPanelProps): React.JSX.Element {
  const targets = session.getStatsTargets()
  const outbound = useTrackStats(targets.localScreen, 'outbound', 1000)
  const inbound = useTrackStats(targets.watched, 'inbound', 1000)
  const [metrics, setMetrics] = useState<AppMetrics | null>(null)
  const [caps, setCaps] = useState<ScreenCaptureCapabilities | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const bridge = window.d2
    if (!bridge) return
    let cancelled = false
    const poll = (): void => {
      void bridge.diagnostics.getAppMetrics().then((m) => {
        if (!cancelled) setMetrics(m)
      })
    }
    poll()
    const timer = setInterval(poll, 2000)
    void bridge.screen.getCapabilities().then((c) => {
      if (!cancelled) setCaps(c)
    })
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const totalCpu = metrics?.processes.reduce((sum, p) => sum + p.cpuPercent, 0)
  const totalMem = metrics?.processes.reduce((sum, p) => sum + p.memoryMB, 0)
  const share = state.screenShare

  const sections: { title: string; rows: [string, string][] }[] = [
    {
      title: 'Voice',
      rows: [
        ['Status', state.status],
        ['Connection quality', state.connectionQuality],
        ['Participants', String(state.participants.length)],
        ['Microphone capturing', session.isCapturing() ? 'Yes' : 'No']
      ]
    },
    {
      title: 'Your stream',
      rows: [
        ['Status', share.status],
        ['Source', share.sourceName ?? '—'],
        ['Profile', share.options?.profileId ?? '—'],
        [
          'System audio',
          share.audio === 'live'
            ? share.audioEchoProtected
              ? 'Live (Discord 2.0 voices excluded)'
              : 'Live (may include voices — not excluded)'
            : share.audio
        ],
        ...(outbound ? outboundRows(outbound) : [])
      ]
    },
    {
      title: 'Watching',
      rows: [
        ['Stream', state.watching ? userName(state.watching) : 'None'],
        ...(inbound ? inboundRows(inbound) : [])
      ]
    },
    {
      title: 'App & GPU',
      rows: [
        ['CPU (all processes)', totalCpu === undefined ? '—' : `${totalCpu.toFixed(1)}%`],
        ['Memory (all processes)', totalMem === undefined ? '—' : `${Math.round(totalMem)} MB`],
        ['GPU vendor', metrics?.gpuVendor ?? '—'],
        ['GPU video encode', metrics?.videoEncode ?? '—'],
        ['GPU video decode', metrics?.videoDecode ?? '—'],
        ['System audio capture', caps ? (caps.systemAudio ? 'Supported' : 'Not supported') : '—'],
        [
          'Own-audio exclusion',
          caps
            ? caps.excludeOwnAudio
              ? 'Supported (Windows 11)'
              : 'Not supported by this OS'
            : '—'
        ],
        ['Logical CPUs', String(navigator.hardwareConcurrency ?? '—')]
      ]
    }
  ]

  const copyReport = (): void => {
    const text = sections
      .map((s) => `## ${s.title}\n${s.rows.map(([k, v]) => `${k}: ${v}`).join('\n')}`)
      .join('\n\n')
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <>
      <h2>Diagnostics</h2>
      <p className="settings-note">
        Live numbers from WebRTC and Electron, refreshed every 1–2 seconds while this page is open.
        &ldquo;Hardware encoder&rdquo; is only shown as Yes when Chromium reports it.
      </p>
      {!window.d2 && (
        <p className="settings-note">App and GPU metrics are only available in the desktop app.</p>
      )}
      <div className="diag-grid">
        {sections.map((s) => (
          <section key={s.title} className="diag-card">
            <h3>{s.title}</h3>
            <Rows rows={s.rows} />
          </section>
        ))}
      </div>
      <button type="button" className="button secondary" onClick={copyReport}>
        {copied ? 'Copied' : 'Copy report'}
      </button>
    </>
  )
}

export default DiagnosticsPanel
