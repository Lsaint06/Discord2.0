/**
 * Turns raw WebRTC getStats() reports into compact numbers for the diagnostics UI.
 * Works on plain arrays of stats objects so it can be unit tested without a browser.
 */

type Stat = Record<string, unknown> & { id: string; type: string; timestamp: number }

export interface OutboundVideoStats {
  width?: number
  height?: number
  fps?: number
  bitrateKbps?: number
  codec?: string
  /** e.g. "MediaFoundationVideoEncodeAccelerator", "NvEnc", "libvpx", "OpenH264". */
  encoder?: string
  /** True when Chromium reports a power-efficient (hardware) encoder. */
  powerEfficient?: boolean
  encodeMsPerFrame?: number
  qualityLimitation?: string
  rttMs?: number
  packetLossPct?: number
  captureWidth?: number
  captureHeight?: number
  captureFps?: number
  layers: number
}

export interface InboundVideoStats {
  width?: number
  height?: number
  fps?: number
  bitrateKbps?: number
  codec?: string
  decoder?: string
  powerEfficient?: boolean
  packetLossPct?: number
  jitterMs?: number
  framesDropped?: number
  rttMs?: number
}

/** Cumulative counters from the previous sample, used to compute rates. */
export interface StatsSample {
  timestamp: number
  bytes: number
  framesEncoded?: number
  totalEncodeTime?: number
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function byId(stats: Stat[]): Map<string, Stat> {
  return new Map(stats.map((s) => [s.id, s]))
}

function codecName(index: Map<string, Stat>, codecId: unknown): string | undefined {
  const codec = typeof codecId === 'string' ? index.get(codecId) : undefined
  const mime = str(codec?.mimeType)
  return mime?.split('/')[1]
}

function rate(bytes: number, timestamp: number, prev?: StatsSample): number | undefined {
  if (!prev || timestamp <= prev.timestamp || bytes < prev.bytes) return undefined
  return Math.round(((bytes - prev.bytes) * 8) / (timestamp - prev.timestamp)) // bits/ms = kbps
}

function selectedPairRtt(stats: Stat[], index: Map<string, Stat>): number | undefined {
  const transport = stats.find((s) => s.type === 'transport')
  const pair =
    (typeof transport?.selectedCandidatePairId === 'string'
      ? index.get(transport.selectedCandidatePairId)
      : undefined) ?? stats.find((s) => s.type === 'candidate-pair' && s.nominated === true)
  const rtt = num(pair?.currentRoundTripTime)
  return rtt === undefined ? undefined : Math.round(rtt * 1000)
}

export function summarizeOutboundVideo(
  stats: Stat[],
  prev?: StatsSample
): { summary: OutboundVideoStats; sample: StatsSample } {
  const index = byId(stats)
  const layers = stats.filter((s) => s.type === 'outbound-rtp' && s.kind === 'video')
  const timestamp = Math.max(0, ...layers.map((l) => l.timestamp))
  const bytes = layers.reduce((sum, l) => sum + (num(l.bytesSent) ?? 0), 0)
  // The active top layer is the one with the largest frame size.
  const top = [...layers].sort((a, b) => (num(b.frameWidth) ?? 0) - (num(a.frameWidth) ?? 0))[0]

  const framesEncoded = num(top?.framesEncoded)
  const totalEncodeTime = num(top?.totalEncodeTime)
  let encodeMsPerFrame: number | undefined
  if (
    prev?.framesEncoded !== undefined &&
    prev.totalEncodeTime !== undefined &&
    framesEncoded !== undefined &&
    totalEncodeTime !== undefined &&
    framesEncoded > prev.framesEncoded
  ) {
    encodeMsPerFrame =
      Math.round(
        ((totalEncodeTime - prev.totalEncodeTime) / (framesEncoded - prev.framesEncoded)) * 10000
      ) / 10
  }

  const remote = stats.find((s) => s.type === 'remote-inbound-rtp' && s.kind === 'video')
  const source = stats.find((s) => s.type === 'media-source' && s.kind === 'video')
  const fractionLost = num(remote?.fractionLost)
  const remoteRtt = num(remote?.roundTripTime)

  return {
    summary: {
      width: num(top?.frameWidth),
      height: num(top?.frameHeight),
      fps: num(top?.framesPerSecond),
      bitrateKbps: rate(bytes, timestamp, prev),
      codec: codecName(index, top?.codecId),
      encoder: str(top?.encoderImplementation),
      powerEfficient:
        typeof top?.powerEfficientEncoder === 'boolean' ? top.powerEfficientEncoder : undefined,
      encodeMsPerFrame,
      qualityLimitation: str(top?.qualityLimitationReason),
      rttMs: remoteRtt !== undefined ? Math.round(remoteRtt * 1000) : selectedPairRtt(stats, index),
      packetLossPct: fractionLost !== undefined ? Math.round(fractionLost * 1000) / 10 : undefined,
      captureWidth: num(source?.width),
      captureHeight: num(source?.height),
      captureFps: num(source?.framesPerSecond),
      layers: layers.filter((l) => l.active !== false).length
    },
    sample: { timestamp, bytes, framesEncoded, totalEncodeTime }
  }
}

export function summarizeInboundVideo(
  stats: Stat[],
  prev?: StatsSample
): { summary: InboundVideoStats; sample: StatsSample } {
  const index = byId(stats)
  const inbound = stats.find((s) => s.type === 'inbound-rtp' && s.kind === 'video')
  const timestamp = inbound?.timestamp ?? 0
  const bytes = num(inbound?.bytesReceived) ?? 0
  const lost = num(inbound?.packetsLost) ?? 0
  const received = num(inbound?.packetsReceived) ?? 0
  const jitter = num(inbound?.jitter)
  return {
    summary: {
      width: num(inbound?.frameWidth),
      height: num(inbound?.frameHeight),
      fps: num(inbound?.framesPerSecond),
      bitrateKbps: rate(bytes, timestamp, prev),
      codec: codecName(index, inbound?.codecId),
      decoder: str(inbound?.decoderImplementation),
      powerEfficient:
        typeof inbound?.powerEfficientDecoder === 'boolean'
          ? inbound.powerEfficientDecoder
          : undefined,
      packetLossPct:
        received + lost > 0 ? Math.round((lost / (received + lost)) * 1000) / 10 : undefined,
      jitterMs: jitter !== undefined ? Math.round(jitter * 1000) : undefined,
      framesDropped: num(inbound?.framesDropped),
      rttMs: selectedPairRtt(stats, index)
    },
    sample: { timestamp, bytes }
  }
}

/** Collects the values of an RTCStatsReport (Map-like) into an array. */
export function reportToArray(report: { forEach: (cb: (value: unknown) => void) => void }): Stat[] {
  const out: Stat[] = []
  report.forEach((value) => out.push(value as Stat))
  return out
}
