/**
 * Turns raw WebRTC getStats() reports into per-stage numbers for the diagnostics UI.
 *
 * Every rate and average is computed from the *difference* of cumulative counters between two
 * samples (e.g. Δframes / Δtime), never from a single instantaneous value. Counters that go
 * backwards (stream restarted, layer switched) or a stat object that disappears produce
 * `undefined` for that window instead of a bogus number.
 *
 * Pure: works on plain arrays of stats objects so it can be unit tested without a browser.
 */

export type Stat = Record<string, unknown> & { id: string; type: string; timestamp: number }

export interface OutboundLayer {
  rid?: string
  codec?: string
  width?: number
  height?: number
  /** Frames the encoder produced per second (Δ framesEncoded). */
  encodedFps?: number
  /** Frames handed to the network per second (Δ framesSent). */
  sentFps?: number
  bitrateKbps?: number
  /** Average encoder time per frame in this window (Δ totalEncodeTime / Δ framesEncoded). */
  encodeMs?: number
  /** Average time packets waited in the send pacer (Δ totalPacketSendDelay / Δ packetsSent). */
  pacerMs?: number
  keyFrames?: number
  scalabilityMode?: string
  /** e.g. "MediaFoundationVideoEncodeAccelerator (NVIDIA AV1 Encoder MFT)", "libaom", "OpenH264". */
  encoder?: string
  /** Chromium's own hardware flag; undefined when not exposed. */
  powerEfficient?: boolean
  qualityLimitation?: string
  targetKbps?: number
  active: boolean
}

export interface OutboundVideoStats {
  layers: OutboundLayer[]
  /** The active layer with the largest frame (what a full-quality viewer receives). */
  top?: OutboundLayer
  /** Frames delivered by screen capture per second (Δ media-source.frames). */
  captureFps?: number
  captureWidth?: number
  captureHeight?: number
  totalBitrateKbps?: number
  /** Sender bandwidth estimate (estimated by WebRTC, not measured throughput). */
  estimatedUplinkKbps?: number
  rttMs?: number
  packetLossPct?: number
}

export interface InboundVideoStats {
  codec?: string
  width?: number
  height?: number
  /** Δ framesReceived / Δt — frames that arrived (complete) from the network. */
  receivedFps?: number
  /** Δ framesDecoded / Δt. */
  decodedFps?: number
  /** Δ framesDropped / Δt — dropped by the receiver before rendering. */
  droppedFps?: number
  framesDroppedTotal?: number
  decodeMs?: number
  /** Average time frames waited in the jitter buffer in this window. */
  jitterBufferMs?: number
  jitterTargetMs?: number
  jitterMinimumMs?: number
  /** Average receive → decoded time (assembly + jitter buffer + decode). */
  processingMs?: number
  /** Freezes (≥ ~3 frame gaps) that started in this window, and their total duration. */
  freezes?: number
  freezeMs?: number
  freezesTotal?: number
  bitrateKbps?: number
  packetLossPct?: number
  decoder?: string
  powerEfficient?: boolean
  keyFrames?: number
  rttMs?: number
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const round = (n: number, digits = 1): number => {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/** Δ of a cumulative counter, or undefined if missing or it went backwards (reset). */
export function counterDelta(
  cur: Stat | undefined,
  prev: Stat | undefined,
  key: string
): number | undefined {
  const a = num(cur?.[key])
  const b = num(prev?.[key])
  if (a === undefined || b === undefined || a < b) return undefined
  return a - b
}

/** Seconds between two samples of the same stat object, or undefined if not positive. */
export function elapsedSeconds(cur: Stat | undefined, prev: Stat | undefined): number | undefined {
  if (!cur || !prev) return undefined
  const dt = (cur.timestamp - prev.timestamp) / 1000
  return dt > 0 ? dt : undefined
}

/** Δkey / Δt. */
export function perSecond(
  cur: Stat | undefined,
  prev: Stat | undefined,
  key: string
): number | undefined {
  const d = counterDelta(cur, prev, key)
  const dt = elapsedSeconds(cur, prev)
  return d === undefined || dt === undefined ? undefined : d / dt
}

/** Δnum / Δden × scale (e.g. seconds → ms), or undefined when Δden is 0. */
export function windowAverage(
  cur: Stat | undefined,
  prev: Stat | undefined,
  numKey: string,
  denKey: string,
  scale = 1000
): number | undefined {
  const n = counterDelta(cur, prev, numKey)
  const d = counterDelta(cur, prev, denKey)
  if (n === undefined || d === undefined || d === 0) return undefined
  return (n / d) * scale
}

function byId(stats: Stat[]): Map<string, Stat> {
  return new Map(stats.map((s) => [s.id, s]))
}

function codecName(index: Map<string, Stat>, codecId: unknown): string | undefined {
  const codec = typeof codecId === 'string' ? index.get(codecId) : undefined
  return str(codec?.mimeType)?.split('/')[1]
}

function selectedPair(stats: Stat[], index: Map<string, Stat>): Stat | undefined {
  const transport = stats.find((s) => s.type === 'transport')
  return (
    (typeof transport?.selectedCandidatePairId === 'string'
      ? index.get(transport.selectedCandidatePairId)
      : undefined) ?? stats.find((s) => s.type === 'candidate-pair' && s.nominated === true)
  )
}

const ms = (seconds: number | undefined): number | undefined =>
  seconds === undefined ? undefined : Math.round(seconds * 1000)

export function summarizeOutboundVideo(stats: Stat[], prevStats?: Stat[]): OutboundVideoStats {
  const index = byId(stats)
  const prev = prevStats ? byId(prevStats) : new Map<string, Stat>()
  const raw = stats.filter((s) => s.type === 'outbound-rtp' && s.kind === 'video')

  const layers: OutboundLayer[] = raw.map((s) => {
    const p = prev.get(s.id)
    const bytes = perSecond(s, p, 'bytesSent')
    const target = num(s.targetBitrate)
    return {
      rid: str(s.rid),
      codec: codecName(index, s.codecId),
      width: num(s.frameWidth),
      height: num(s.frameHeight),
      encodedFps: opt(perSecond(s, p, 'framesEncoded')),
      sentFps: opt(perSecond(s, p, 'framesSent')),
      bitrateKbps: bytes === undefined ? undefined : Math.round((bytes * 8) / 1000),
      encodeMs: opt(windowAverage(s, p, 'totalEncodeTime', 'framesEncoded')),
      pacerMs: opt(windowAverage(s, p, 'totalPacketSendDelay', 'packetsSent')),
      keyFrames: counterDelta(s, p, 'keyFramesEncoded'),
      scalabilityMode: str(s.scalabilityMode),
      encoder: str(s.encoderImplementation),
      powerEfficient:
        typeof s.powerEfficientEncoder === 'boolean' ? s.powerEfficientEncoder : undefined,
      qualityLimitation: str(s.qualityLimitationReason),
      targetKbps: target === undefined ? undefined : Math.round(target / 1000),
      active: s.active !== false
    }
  })

  const active = layers.filter((l) => l.active && (l.width ?? 0) > 0)
  const top = [...(active.length ? active : layers)].sort(
    (a, b) => (b.width ?? 0) - (a.width ?? 0)
  )[0]

  const source = stats.find((s) => s.type === 'media-source' && s.kind === 'video')
  const remote = stats.find((s) => s.type === 'remote-inbound-rtp' && s.kind === 'video')
  const pair = selectedPair(stats, index)
  const fractionLost = num(remote?.fractionLost)
  const uplink = num(pair?.availableOutgoingBitrate)
  const totals = layers.map((l) => l.bitrateKbps)

  return {
    layers,
    top,
    captureFps: opt(perSecond(source, source && prev.get(source.id), 'frames')),
    captureWidth: num(source?.width),
    captureHeight: num(source?.height),
    totalBitrateKbps:
      totals.every((t) => t !== undefined) && totals.length
        ? totals.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)
        : undefined,
    estimatedUplinkKbps: uplink === undefined ? undefined : Math.round(uplink / 1000),
    rttMs: ms(num(remote?.roundTripTime) ?? num(pair?.currentRoundTripTime)),
    packetLossPct: fractionLost === undefined ? undefined : round(fractionLost * 100)
  }
}

export function summarizeInboundVideo(stats: Stat[], prevStats?: Stat[]): InboundVideoStats {
  const index = byId(stats)
  const prev = prevStats ? byId(prevStats) : new Map<string, Stat>()
  // A receiver has one inbound video stream; prefer the one that is actually decoding.
  const candidates = stats.filter((s) => s.type === 'inbound-rtp' && s.kind === 'video')
  const s = [...candidates].sort(
    (a, b) => (num(b.framesDecoded) ?? 0) - (num(a.framesDecoded) ?? 0)
  )[0]
  if (!s) return {}
  const p = prev.get(s.id)
  const bytes = perSecond(s, p, 'bytesReceived')
  const lost = counterDelta(s, p, 'packetsLost')
  const received = counterDelta(s, p, 'packetsReceived')
  const pair = selectedPair(stats, index)
  const freezeSeconds = counterDelta(s, p, 'totalFreezesDuration')

  return {
    codec: codecName(index, s.codecId),
    width: num(s.frameWidth),
    height: num(s.frameHeight),
    receivedFps: opt(perSecond(s, p, 'framesReceived')),
    decodedFps: opt(perSecond(s, p, 'framesDecoded')),
    droppedFps: opt(perSecond(s, p, 'framesDropped')),
    framesDroppedTotal: num(s.framesDropped),
    decodeMs: opt(windowAverage(s, p, 'totalDecodeTime', 'framesDecoded')),
    jitterBufferMs: opt(windowAverage(s, p, 'jitterBufferDelay', 'jitterBufferEmittedCount')),
    jitterTargetMs: opt(windowAverage(s, p, 'jitterBufferTargetDelay', 'jitterBufferEmittedCount')),
    jitterMinimumMs: opt(
      windowAverage(s, p, 'jitterBufferMinimumDelay', 'jitterBufferEmittedCount')
    ),
    processingMs: opt(windowAverage(s, p, 'totalProcessingDelay', 'framesDecoded')),
    freezes: counterDelta(s, p, 'freezeCount'),
    freezeMs: freezeSeconds === undefined ? undefined : Math.round(freezeSeconds * 1000),
    freezesTotal: num(s.freezeCount),
    bitrateKbps: bytes === undefined ? undefined : Math.round((bytes * 8) / 1000),
    packetLossPct:
      lost !== undefined && received !== undefined && lost + received > 0
        ? round((lost / (lost + received)) * 100)
        : undefined,
    decoder: str(s.decoderImplementation),
    powerEfficient:
      typeof s.powerEfficientDecoder === 'boolean' ? s.powerEfficientDecoder : undefined,
    keyFrames: counterDelta(s, p, 'keyFramesDecoded'),
    rttMs: ms(num(pair?.currentRoundTripTime))
  }
}

/** Optional rounding to one decimal. */
function opt(v: number | undefined): number | undefined {
  return v === undefined ? undefined : round(v)
}

// ---- Video element (presentation) ----

/** Cumulative presentation counters from a <video> element. */
export interface PlaybackSample {
  /** performance.now() when sampled. */
  t: number
  /** requestVideoFrameCallback presentedFrames (frames handed to the compositor). */
  presentedFrames?: number
  /** getVideoPlaybackQuality() counters (fallback when rVFC is unavailable). */
  totalVideoFrames?: number
  droppedVideoFrames?: number
  /** Sum and count of (expectedDisplayTime − receiveTime) for frames presented so far. */
  receiveToDisplaySumMs: number
  receiveToDisplayCount: number
}

export interface PlaybackStats {
  presentedFps?: number
  /** Which counter presentedFps came from. */
  presentedSource?: 'frame-callback' | 'playback-quality'
  /**
   * Frames the video element reports dropped (getVideoPlaybackQuality). Only meaningful when
   * frame callbacks are unavailable: for WebRTC streams Chromium's counter disagrees with the
   * presented-frame count, so the UI shows WebRTC's own framesDropped instead.
   */
  elementDroppedFps?: number
  /** Average time from the last packet of a frame arriving to its expected display. */
  receiveToDisplayMs?: number
}

export function summarizePlayback(cur: PlaybackSample, prev?: PlaybackSample): PlaybackStats {
  if (!prev) return {}
  const dt = (cur.t - prev.t) / 1000
  if (!(dt > 0)) return {}
  const delta = (a?: number, b?: number): number | undefined =>
    a === undefined || b === undefined || a < b ? undefined : a - b
  const presented = delta(cur.presentedFrames, prev.presentedFrames)
  const total = delta(cur.totalVideoFrames, prev.totalVideoFrames)
  const dropped = delta(cur.droppedVideoFrames, prev.droppedVideoFrames)
  const r2dCount = delta(cur.receiveToDisplayCount, prev.receiveToDisplayCount)
  const r2dSum = cur.receiveToDisplaySumMs - prev.receiveToDisplaySumMs
  let presentedFps: number | undefined
  let presentedSource: PlaybackStats['presentedSource']
  if (presented !== undefined) {
    presentedFps = round(presented / dt)
    presentedSource = 'frame-callback'
  } else if (total !== undefined) {
    presentedFps = round((total - (dropped ?? 0)) / dt)
    presentedSource = 'playback-quality'
  }
  return {
    presentedFps,
    presentedSource,
    elementDroppedFps: dropped === undefined ? undefined : round(dropped / dt),
    receiveToDisplayMs: r2dCount ? round(r2dSum / r2dCount) : undefined
  }
}

/** Collects the values of an RTCStatsReport (Map-like) into an array. */
export function reportToArray(report: { forEach: (cb: (value: unknown) => void) => void }): Stat[] {
  const out: Stat[] = []
  report.forEach((value) => out.push(value as Stat))
  return out
}
