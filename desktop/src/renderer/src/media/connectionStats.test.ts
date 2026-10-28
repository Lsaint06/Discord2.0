import { describe, expect, it } from 'vitest'
import { gradeConnection, summarizeConnection, type ConnectionSample } from './connectionStats'
import type { Stat } from './stats'

const s = (id: string, type: string, timestamp: number, fields: Record<string, unknown>): Stat => ({
  id,
  type,
  timestamp,
  ...fields
})

/** Microphone sender stats at time t (ms) with cumulative counters. */
function outbound(
  t: number,
  c: { bytes: number; sent: number; lost: number; protocol?: string }
): Stat[] {
  return [
    s('OT', 'outbound-rtp', t, { kind: 'audio', bytesSent: c.bytes, packetsSent: c.sent }),
    s('RI', 'remote-inbound-rtp', t, {
      kind: 'audio',
      packetsLost: c.lost,
      jitter: 0.004,
      roundTripTime: 0.05,
      fractionLost: 0
    }),
    s('T', 'transport', t, { selectedCandidatePairId: 'CP' }),
    s('CP', 'candidate-pair', t, {
      nominated: true,
      state: 'succeeded',
      currentRoundTripTime: 0.042,
      localCandidateId: 'LC'
    }),
    s('LC', 'local-candidate', t, { protocol: c.protocol ?? 'udp', candidateType: 'srflx' })
  ]
}

/** One remote voice's receiver stats. */
function inbound(
  t: number,
  c: { bytes: number; received: number; lost: number; jitter?: number }
): Stat[] {
  return [
    s('IT', 'inbound-rtp', t, {
      kind: 'audio',
      bytesReceived: c.bytes,
      packetsReceived: c.received,
      packetsLost: c.lost,
      jitter: c.jitter ?? 0.012
    }),
    s('T2', 'transport', t, { selectedCandidatePairId: 'CP2' }),
    s('CP2', 'candidate-pair', t, {
      nominated: true,
      state: 'succeeded',
      currentRoundTripTime: 0.06,
      localCandidateId: 'LC2'
    }),
    s('LC2', 'local-candidate', t, { protocol: 'udp', candidateType: 'host' })
  ]
}

describe('voice connection telemetry', () => {
  it('computes rates and loss from the difference between two samples', () => {
    const prev: ConnectionSample = {
      outbound: outbound(0, { bytes: 0, sent: 0, lost: 0 }),
      inbound: new Map([['a', inbound(0, { bytes: 0, received: 0, lost: 0 })]])
    }
    const cur: ConnectionSample = {
      // 2 s: 8000 bytes = 32 kbit/s; 100 sent, 2 lost = 2 %.
      outbound: outbound(2000, { bytes: 8000, sent: 100, lost: 2 }),
      // 2 s: 10000 bytes = 40 kbit/s; 99 received, 1 lost = 1 %.
      inbound: new Map([['a', inbound(2000, { bytes: 10_000, received: 99, lost: 1 })]])
    }
    expect(summarizeConnection(cur, prev)).toEqual({
      rttMs: 42,
      jitterMs: 12,
      uploadLossPct: 2,
      downloadLossPct: 1,
      sendKbps: 32,
      receiveKbps: 40,
      transport: { protocol: 'udp', candidateType: 'srflx' }
    })
  })

  it('reports nothing it cannot measure: first sample has no rates or Δ-based loss', () => {
    const first = summarizeConnection({
      outbound: outbound(0, { bytes: 5000, sent: 50, lost: 1 }),
      inbound: new Map([['a', inbound(0, { bytes: 5000, received: 50, lost: 0 })]])
    })
    expect(first.sendKbps).toBeUndefined()
    expect(first.receiveKbps).toBeUndefined()
    expect(first.downloadLossPct).toBeUndefined()
    // The server's own last-interval report is a measurement and is used.
    expect(first.uploadLossPct).toBe(0)
    expect(first.rttMs).toBe(42)
  })

  it('keeps a real zero loss distinct from unknown', () => {
    const prev = { inbound: new Map([['a', inbound(0, { bytes: 0, received: 0, lost: 0 })]]) }
    const cur = { inbound: new Map([['a', inbound(1000, { bytes: 4000, received: 50, lost: 0 })]]) }
    const summary = summarizeConnection(cur, prev)
    expect(summary.downloadLossPct).toBe(0)
    expect(summary.uploadLossPct).toBeUndefined()
    expect(summary.sendKbps).toBeUndefined()
  })

  it('ignores counters that went backwards (a stream restarted)', () => {
    const prev = { inbound: new Map([['a', inbound(0, { bytes: 9000, received: 90, lost: 3 })]]) }
    const cur = { inbound: new Map([['a', inbound(1000, { bytes: 100, received: 1, lost: 0 })]]) }
    const summary = summarizeConnection(cur, prev)
    expect(summary.receiveKbps).toBeUndefined()
    expect(summary.downloadLossPct).toBeUndefined()
  })

  it('works while your microphone is not published (muted or listening only)', () => {
    const prev = { inbound: new Map([['a', inbound(0, { bytes: 0, received: 0, lost: 0 })]]) }
    const cur = { inbound: new Map([['a', inbound(1000, { bytes: 5000, received: 50, lost: 0 })]]) }
    const summary = summarizeConnection(cur, prev)
    expect(summary.rttMs).toBe(60)
    expect(summary.transport).toEqual({ protocol: 'udp', candidateType: 'host' })
  })

  it('alone and muted: everything is unavailable', () => {
    const summary = summarizeConnection({ inbound: new Map() })
    expect(summary).toEqual({})
    expect(gradeConnection(summary)).toBe('unknown')
  })

  it('sums several voices and reports the worst jitter', () => {
    const prev = {
      inbound: new Map([
        ['a', inbound(0, { bytes: 0, received: 0, lost: 0 })],
        ['b', inbound(0, { bytes: 0, received: 0, lost: 0 })]
      ])
    }
    const cur = {
      inbound: new Map([
        ['a', inbound(1000, { bytes: 4000, received: 48, lost: 2, jitter: 0.01 })],
        ['b', inbound(1000, { bytes: 4000, received: 50, lost: 0, jitter: 0.035 })]
      ])
    }
    const summary = summarizeConnection(cur, prev)
    expect(summary.receiveKbps).toBe(64)
    expect(summary.downloadLossPct).toBe(2)
    expect(summary.jitterMs).toBe(35)
  })

  it('shows a TCP fallback path', () => {
    const summary = summarizeConnection({
      outbound: outbound(0, { bytes: 0, sent: 0, lost: 0, protocol: 'tcp' }),
      inbound: new Map()
    })
    expect(summary.transport?.protocol).toBe('tcp')
  })

  it('grades only from measured values', () => {
    expect(gradeConnection({ rttMs: 40, downloadLossPct: 0, jitterMs: 8 })).toBe('good')
    expect(gradeConnection({ rttMs: 200 })).toBe('fair')
    expect(gradeConnection({ rttMs: 60, uploadLossPct: 12 })).toBe('poor')
    expect(gradeConnection({ jitterMs: 150 })).toBe('poor')
  })
})
