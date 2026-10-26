import type { InboundVideoStats, OutboundLayer, OutboundVideoStats, PlaybackStats } from './stats'

/**
 * - measured: computed from cumulative counter deltas over the last window
 * - reported: a label/state Chromium reports (encoder name, limitation reason)
 * - estimated: an estimate produced by WebRTC (bandwidth estimate)
 */
export type StatKind = 'measured' | 'reported' | 'estimated'

export interface StatRow {
  label: string
  value: string
  kind: StatKind
}

const dash = '—'
const fps = (v: number | undefined): string => (v === undefined ? dash : `${Math.round(v)}`)
const msv = (v: number | undefined): string =>
  v === undefined ? dash : `${Math.round(v * 10) / 10} ms`
const mbps = (kbps: number | undefined): string =>
  kbps === undefined ? dash : `${(kbps / 1000).toFixed(kbps >= 10_000 ? 1 : 2)} Mbps`
const size = (w?: number, h?: number): string => (w && h ? `${w}×${h}` : dash)

export function hardwareLabel(powerEfficient: boolean | undefined): string {
  if (powerEfficient === true) return 'hardware'
  if (powerEfficient === false) return 'software'
  return 'not reported'
}

function layerName(l: OutboundLayer): string {
  return `Layer ${l.rid ?? 'single'} ${size(l.width, l.height)}`
}

export function senderRows(s: OutboundVideoStats): StatRow[] {
  const top = s.top
  const rows: StatRow[] = [
    {
      label: 'Capture',
      value: `${size(s.captureWidth, s.captureHeight)} · ${fps(s.captureFps)} fps`,
      kind: 'measured'
    }
  ]
  const layers = [...s.layers].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
  for (const l of layers) {
    rows.push({
      label: layerName(l),
      value: l.active
        ? `encoded ${fps(l.encodedFps)} · sent ${fps(l.sentFps)} fps · ${mbps(l.bitrateKbps)}`
        : 'paused (no viewer needs it)',
      kind: 'measured'
    })
  }
  rows.push(
    {
      label: 'Codec',
      value: [top?.codec?.toUpperCase(), top?.scalabilityMode].filter(Boolean).join(' · ') || dash,
      kind: 'reported'
    },
    {
      label: 'Encoder',
      value: top?.encoder
        ? `${top.encoder} (${hardwareLabel(top.powerEfficient)})`
        : 'not reported',
      kind: 'reported'
    },
    { label: 'Encode time', value: top ? `${msv(top.encodeMs)} / frame` : dash, kind: 'measured' },
    { label: 'Send pacer delay', value: msv(top?.pacerMs), kind: 'measured' },
    { label: 'Limited by', value: top?.qualityLimitation ?? dash, kind: 'reported' },
    { label: 'Total upload', value: mbps(s.totalBitrateKbps), kind: 'measured' },
    { label: 'Uplink estimate', value: mbps(s.estimatedUplinkKbps), kind: 'estimated' },
    { label: 'Round trip', value: msv(s.rttMs), kind: 'measured' },
    {
      label: 'Packet loss',
      value: s.packetLossPct === undefined ? dash : `${s.packetLossPct}%`,
      kind: 'measured'
    }
  )
  return rows
}

export function receiverRows(s: InboundVideoStats, p: PlaybackStats): StatRow[] {
  return [
    { label: 'Decoded size', value: size(s.width, s.height), kind: 'measured' },
    {
      label: 'Frame rate',
      value: `received ${fps(s.receivedFps)} · decoded ${fps(s.decodedFps)} · shown ${fps(p.presentedFps)} fps`,
      kind: 'measured'
    },
    {
      label: 'Dropped frames',
      value:
        s.droppedFps === undefined
          ? dash
          : `${fps(s.droppedFps)}/s (total ${s.framesDroppedTotal ?? 0})`,
      kind: 'measured'
    },
    {
      label: 'Freezes',
      value:
        s.freezesTotal === undefined
          ? dash
          : `${s.freezesTotal} total${s.freezeMs ? ` (${s.freezeMs} ms just now)` : ''}`,
      kind: 'measured'
    },
    {
      label: 'Jitter buffer',
      value: `${msv(s.jitterBufferMs)} (target ${msv(s.jitterTargetMs)}, min ${msv(s.jitterMinimumMs)})`,
      kind: 'measured'
    },
    { label: 'Decode time', value: `${msv(s.decodeMs)} / frame`, kind: 'measured' },
    { label: 'Arrival → display', value: msv(p.receiveToDisplayMs), kind: 'measured' },
    {
      label: 'Decoder',
      value: s.decoder ? `${s.decoder} (${hardwareLabel(s.powerEfficient)})` : 'not reported',
      kind: 'reported'
    },
    { label: 'Codec', value: s.codec?.toUpperCase() ?? dash, kind: 'reported' },
    { label: 'Bitrate', value: mbps(s.bitrateKbps), kind: 'measured' },
    {
      label: 'Packet loss',
      value: s.packetLossPct === undefined ? dash : `${s.packetLossPct}%`,
      kind: 'measured'
    },
    { label: 'Round trip', value: msv(s.rttMs), kind: 'measured' }
  ]
}

export interface ShareHealth {
  /** Short text for the sharer's voice panel when the stream is held back, else null. */
  warning: string | null
}

/**
 * Tells the sharer when what's sent falls short of the chosen profile because of a real,
 * reported constraint (CPU or bandwidth) — never silently.
 */
export function shareHealth(
  s: OutboundVideoStats | undefined,
  target: { width: number; height: number; fps: number }
): ShareHealth {
  const top = s?.top
  if (!top || !top.active) return { warning: null }
  const reason = top.qualityLimitation
  const limited = reason === 'cpu' || reason === 'bandwidth'
  const shortFps = top.encodedFps !== undefined && top.encodedFps < target.fps * 0.8
  const capturedSmaller =
    (s?.captureWidth ?? 0) > 0 &&
    (top.width ?? 0) < Math.min(s?.captureWidth ?? 0, target.width) * 0.95
  if (!limited || (!shortFps && !capturedSmaller)) return { warning: null }
  const what = `${size(top.width, top.height)} @ ${fps(top.encodedFps)} fps`
  return {
    warning: `Limited by ${reason === 'cpu' ? 'encoder/CPU' : 'bandwidth'}: sending ${what}`
  }
}
