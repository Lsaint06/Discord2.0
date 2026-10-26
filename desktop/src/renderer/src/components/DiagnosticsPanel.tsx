import { useEffect, useState } from 'react'
import type {
  AppMetrics,
  EncoderFlagsState,
  ScreenCaptureCapabilities
} from '../../../preload/types'
import type { MediaSession, MediaSnapshot } from '../media/MediaSession'
import { receiverRows, senderRows, type StatRow } from '../media/statsFormat'
import { useTrackStats } from '../hooks/useTrackStats'

interface DiagnosticsPanelProps {
  session: MediaSession
  state: MediaSnapshot
  userName: (userId: string) => string
}

const KIND_MARK: Record<StatRow['kind'], string> = { measured: '', reported: '', estimated: '≈ ' }

function Rows({ rows }: { rows: StatRow[] }): React.JSX.Element {
  return (
    <dl className="diag-rows">
      {rows.map((r) => (
        <div key={r.label} className={`diag-row ${r.kind}`} title={r.kind}>
          <dt>{r.label}</dt>
          <dd>
            {KIND_MARK[r.kind]}
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

const row = (label: string, value: string, kind: StatRow['kind'] = 'reported'): StatRow => ({
  label,
  value,
  kind
})

/** Live media diagnostics. Sampling only runs while this panel is mounted. */
function DiagnosticsPanel({ session, state, userName }: DiagnosticsPanelProps): React.JSX.Element {
  const targets = session.getStatsTargets()
  const outbound = useTrackStats(targets.localScreen, 'outbound', 1000)
  const inbound = useTrackStats(targets.watched, 'inbound', 1000)
  const [metrics, setMetrics] = useState<AppMetrics | null>(null)
  const [caps, setCaps] = useState<ScreenCaptureCapabilities | null>(null)
  const [flags, setFlags] = useState<EncoderFlagsState | null>(null)
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
    void bridge.diagnostics.getEncoderFlags().then((f) => {
      if (!cancelled) setFlags(f)
    })
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const totalCpu = metrics?.processes.reduce((sum, p) => sum + p.cpuPercent, 0)
  const totalMem = metrics?.processes.reduce((sum, p) => sum + p.memoryMB, 0)
  const share = state.screenShare

  const sections: { title: string; rows: StatRow[] }[] = [
    {
      title: 'Voice',
      rows: [
        row('Status', state.status),
        row('Connection quality', state.connectionQuality, 'estimated'),
        row('Participants', String(state.participants.length)),
        row('Microphone capturing', session.isCapturing() ? 'Yes' : 'No')
      ]
    },
    {
      title: 'Your stream (sender)',
      rows: [
        row('Status', share.status),
        row('Source', share.sourceName ?? '—'),
        row(
          'Settings',
          share.options
            ? `${share.options.profileId} · ${share.options.hint === 'motion' ? 'Smooth Gaming' : 'Sharp Desktop'} · ${share.options.codec.toUpperCase()}`
            : '—'
        ),
        row(
          'System audio',
          share.audio === 'live'
            ? share.audioEchoProtected
              ? 'Live (Discord 2.0 voices excluded)'
              : 'Live (may include voices — not excluded)'
            : share.audio
        ),
        ...(outbound ? senderRows(outbound.rtc) : [])
      ]
    },
    {
      title: 'Watching (receiver)',
      rows: [
        row('Stream', state.watching ? userName(state.watching) : 'None'),
        ...(inbound ? receiverRows(inbound.rtc, inbound.playback) : [])
      ]
    },
    {
      title: 'App & GPU',
      rows: [
        row(
          'CPU (all processes)',
          totalCpu === undefined ? '—' : `${totalCpu.toFixed(1)}%`,
          'measured'
        ),
        row(
          'Memory (all processes)',
          totalMem === undefined ? '—' : `${Math.round(totalMem)} MB`,
          'measured'
        ),
        row('GPU vendor', metrics?.gpuVendor ?? '—'),
        row('GPU video encode', metrics?.videoEncode ?? '—'),
        row('GPU video decode', metrics?.videoDecode ?? '—'),
        row(
          'Hardware AV1 encoding',
          flags
            ? `${flags.active.av1HardwareEncode ? 'allowed' : 'off'} this session${flags.saved.av1HardwareEncode !== flags.active.av1HardwareEncode ? ' (changes on restart)' : ''}`
            : '—'
        ),
        row(
          'System audio capture',
          caps ? (caps.systemAudio ? 'Supported' : 'Not supported') : '—'
        ),
        row(
          'Own-audio exclusion',
          caps
            ? caps.excludeOwnAudio
              ? 'Supported (Windows 11)'
              : 'Not supported by this OS'
            : '—'
        ),
        row('Logical CPUs', String(navigator.hardwareConcurrency ?? '—'))
      ]
    }
  ]

  const copyReport = (): void => {
    const text = sections
      .map(
        (s) =>
          `## ${s.title}\n${s.rows.map((r) => `${r.label}: ${KIND_MARK[r.kind]}${r.value}`).join('\n')}`
      )
      .join('\n\n')
    void navigator.clipboard.writeText(`${text}\n\n(≈ = estimate)`).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <>
      <h2>Diagnostics</h2>
      <p className="settings-note">
        Updated every second while this page is open. Rates are measured from WebRTC counters over
        the last second; values marked ≈ are WebRTC estimates. &ldquo;hardware&rdquo; is shown only
        when Chromium reports it. Frame rate is split by stage: <em>encoded</em> and <em>sent</em>{' '}
        on the sharer, <em>received</em>, <em>decoded</em> and <em>shown</em> on the viewer.
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
