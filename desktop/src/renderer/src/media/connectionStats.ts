/**
 * Voice connection telemetry from WebRTC getStats() (pure, unit-tested).
 *
 * Sources:
 * - your microphone's sender stats: outbound-rtp (bytes sent), remote-inbound-rtp (what the
 *   server reported back over RTCP: jitter, loss, round trip), and the selected candidate pair
 *   of the publisher connection (round trip, UDP/TCP, relayed or not);
 * - the receiver stats of every voice you hear: inbound-rtp (jitter, packets lost/received,
 *   bytes) and the subscriber connection's candidate pair.
 *
 * Every value is either measured or `undefined` ("unavailable"): nothing is estimated, and a
 * missing counter is never reported as 0. Rates and loss use the difference between two samples.
 */
import { counterDelta, perSecond, type Stat } from './stats'

export interface ConnectionTransport {
  /** Transport of the selected path: 'udp' normally, 'tcp' when UDP is blocked. */
  protocol?: 'udp' | 'tcp'
  /** Local candidate type: 'host', 'srflx', 'prflx' or 'relay' (TURN). */
  candidateType?: string
}

export interface ConnectionSummary {
  /** Round trip to the voice server (ms). */
  rttMs?: number
  /** Jitter of the audio you receive (ms); falls back to what the server sees from you. */
  jitterMs?: number
  /** Packets of yours lost on the way to the server (%), from the server's reports. */
  uploadLossPct?: number
  /** Packets lost on the way to you (%), across everyone you hear. */
  downloadLossPct?: number
  /** Your microphone's sending bitrate (kbit/s). */
  sendKbps?: number
  /** Voice audio you receive (kbit/s), all participants together. */
  receiveKbps?: number
  transport?: ConnectionTransport
}

export interface ConnectionSample {
  /** Sender stats of your microphone track (undefined while it isn't published). */
  outbound?: Stat[]
  /** Receiver stats per remote audio track, keyed by a stable id (e.g. track sid). */
  inbound: Map<string, Stat[]>
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const round = (n: number, digits = 0): number => {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function selectedPair(stats: Stat[]): Stat | undefined {
  const transport = stats.find((s) => s.type === 'transport')
  const id = transport?.selectedCandidatePairId
  return (
    (typeof id === 'string' ? stats.find((s) => s.id === id) : undefined) ??
    stats.find(
      (s) => s.type === 'candidate-pair' && s.nominated === true && s.state === 'succeeded'
    )
  )
}

function transportOf(stats: Stat[], pair: Stat | undefined): ConnectionTransport | undefined {
  if (!pair) return undefined
  const local = stats.find((s) => s.id === pair.localCandidateId)
  if (!local) return undefined
  const protocol = local.protocol === 'udp' || local.protocol === 'tcp' ? local.protocol : undefined
  const candidateType = typeof local.candidateType === 'string' ? local.candidateType : undefined
  return protocol || candidateType ? { protocol, candidateType } : undefined
}

const firstOfKind = (stats: Stat[] | undefined, type: string): Stat | undefined =>
  stats?.find((s) => s.type === type && (s.kind === 'audio' || s.mediaType === 'audio'))

export function summarizeConnection(
  cur: ConnectionSample,
  prev?: ConnectionSample
): ConnectionSummary {
  const summary: ConnectionSummary = {}

  // ---- Upload (your microphone) ----
  const out = cur.outbound
  const outPrev = prev?.outbound
  const outRtp = firstOfKind(out, 'outbound-rtp')
  const outRtpPrev = firstOfKind(outPrev, 'outbound-rtp')
  const remoteIn = firstOfKind(out, 'remote-inbound-rtp')
  const remoteInPrev = firstOfKind(outPrev, 'remote-inbound-rtp')
  const outPair = out ? selectedPair(out) : undefined

  const bytesPerS = perSecond(outRtp, outRtpPrev, 'bytesSent')
  if (bytesPerS !== undefined) summary.sendKbps = round((bytesPerS * 8) / 1000)

  const lost = counterDelta(remoteIn, remoteInPrev, 'packetsLost')
  const sent = counterDelta(outRtp, outRtpPrev, 'packetsSent')
  if (lost !== undefined && sent !== undefined && sent > 0) {
    summary.uploadLossPct = round(Math.min(100, (lost / sent) * 100), 1)
  } else if (num(remoteIn?.fractionLost) !== undefined) {
    summary.uploadLossPct = round(num(remoteIn!.fractionLost)! * 100, 1)
  }

  // ---- Download (everyone you hear) ----
  let recvBytesPerS: number | undefined
  let lostSum = 0
  let receivedSum = 0
  let lossKnown = false
  let jitterMax: number | undefined
  let inPair: Stat | undefined
  let inStatsForPair: Stat[] | undefined
  for (const [key, stats] of cur.inbound) {
    const rtp = firstOfKind(stats, 'inbound-rtp')
    const rtpPrev = firstOfKind(prev?.inbound.get(key), 'inbound-rtp')
    const b = perSecond(rtp, rtpPrev, 'bytesReceived')
    if (b !== undefined) recvBytesPerS = (recvBytesPerS ?? 0) + b
    const l = counterDelta(rtp, rtpPrev, 'packetsLost')
    const r = counterDelta(rtp, rtpPrev, 'packetsReceived')
    if (l !== undefined && r !== undefined) {
      lostSum += l
      receivedSum += r
      lossKnown = true
    }
    const j = num(rtp?.jitter)
    if (j !== undefined) jitterMax = Math.max(jitterMax ?? 0, j)
    if (!inPair) {
      inPair = selectedPair(stats)
      inStatsForPair = stats
    }
  }
  if (recvBytesPerS !== undefined) summary.receiveKbps = round((recvBytesPerS * 8) / 1000)
  if (lossKnown && lostSum + receivedSum > 0) {
    summary.downloadLossPct = round((lostSum / (lostSum + receivedSum)) * 100, 1)
  }

  // ---- Jitter: what you hear first; otherwise what the server reports about your audio ----
  const upJitter = num(remoteIn?.jitter)
  if (jitterMax !== undefined) summary.jitterMs = round(jitterMax * 1000)
  else if (upJitter !== undefined) summary.jitterMs = round(upJitter * 1000)

  // ---- Round trip: ICE consent checks on the selected path, else RTCP ----
  const pairRtt = num(outPair?.currentRoundTripTime) ?? num(inPair?.currentRoundTripTime)
  const rtcpRtt = num(remoteIn?.roundTripTime)
  const rtt = pairRtt ?? rtcpRtt
  if (rtt !== undefined) summary.rttMs = round(rtt * 1000)

  const transport =
    (out ? transportOf(out, outPair) : undefined) ??
    (inStatsForPair ? transportOf(inStatsForPair, inPair) : undefined)
  if (transport) summary.transport = transport

  return summary
}

export type ConnectionGrade = 'good' | 'fair' | 'poor' | 'unknown'

/**
 * A plain grade from measured values only (unknown when nothing is measured). Thresholds are
 * typical for interactive voice: round trip, then loss, then jitter.
 */
export function gradeConnection(s: ConnectionSummary): ConnectionGrade {
  const loss = Math.max(s.uploadLossPct ?? 0, s.downloadLossPct ?? 0)
  const known =
    s.rttMs !== undefined ||
    s.uploadLossPct !== undefined ||
    s.downloadLossPct !== undefined ||
    s.jitterMs !== undefined
  if (!known) return 'unknown'
  if ((s.rttMs ?? 0) > 400 || loss > 10 || (s.jitterMs ?? 0) > 100) return 'poor'
  if ((s.rttMs ?? 0) > 150 || loss > 2 || (s.jitterMs ?? 0) > 30) return 'fair'
  return 'good'
}
