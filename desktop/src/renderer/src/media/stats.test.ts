import { describe, expect, it } from 'vitest'
import {
  counterDelta,
  elapsedSeconds,
  perSecond,
  summarizeInboundVideo,
  summarizeOutboundVideo,
  summarizePlayback,
  windowAverage,
  type Stat
} from './stats'
import { hardwareLabel, receiverRows, senderRows, shareHealth } from './statsFormat'

const s = (id: string, type: string, timestamp: number, fields: Record<string, unknown>): Stat => ({
  id,
  type,
  timestamp,
  ...fields
})

describe('interval counters', () => {
  it('computes deltas and per-second rates from cumulative counters', () => {
    const a = s('x', 'outbound-rtp', 1000, { framesEncoded: 100 })
    const b = s('x', 'outbound-rtp', 3000, { framesEncoded: 220 })
    expect(counterDelta(b, a, 'framesEncoded')).toBe(120)
    expect(elapsedSeconds(b, a)).toBe(2)
    expect(perSecond(b, a, 'framesEncoded')).toBe(60)
  })

  it('treats a counter that went backwards as a reset (no bogus negative rate)', () => {
    const a = s('x', 'inbound-rtp', 1000, { framesDecoded: 5000 })
    const b = s('x', 'inbound-rtp', 2000, { framesDecoded: 30 })
    expect(counterDelta(b, a, 'framesDecoded')).toBeUndefined()
    expect(perSecond(b, a, 'framesDecoded')).toBeUndefined()
  })

  it('handles missing metrics, zero elapsed time and divide-by-zero', () => {
    const a = s('x', 'inbound-rtp', 1000, { jitterBufferDelay: 1, jitterBufferEmittedCount: 10 })
    const same = s('x', 'inbound-rtp', 1000, { jitterBufferDelay: 1, jitterBufferEmittedCount: 10 })
    expect(perSecond(same, a, 'jitterBufferEmittedCount')).toBeUndefined()
    expect(windowAverage(same, a, 'jitterBufferDelay', 'jitterBufferEmittedCount')).toBeUndefined()
    expect(perSecond(a, undefined, 'framesDecoded')).toBeUndefined()
    expect(counterDelta(a, a, 'notAStat')).toBeUndefined()
  })

  it('averages over the window, not since the stream started', () => {
    // 10 ms average for the first 1000 frames, then 50 ms for the next 60.
    const a = s('x', 'inbound-rtp', 0, { jitterBufferDelay: 10, jitterBufferEmittedCount: 1000 })
    const b = s('x', 'inbound-rtp', 1000, { jitterBufferDelay: 13, jitterBufferEmittedCount: 1060 })
    expect(windowAverage(b, a, 'jitterBufferDelay', 'jitterBufferEmittedCount')).toBeCloseTo(50)
  })
})

const codec = (id: string, mime: string, t: number): Stat => s(id, 'codec', t, { mimeType: mime })

function sender(t: number, n: number): Stat[] {
  return [
    codec('c1', 'video/AV1', t),
    s('src', 'media-source', t, { kind: 'video', frames: 58 * n, width: 2560, height: 1440 }),
    s('o-q', 'outbound-rtp', t, {
      kind: 'video',
      rid: 'q',
      codecId: 'c1',
      frameWidth: 1280,
      frameHeight: 720,
      framesEncoded: 30 * n,
      framesSent: 30 * n,
      bytesSent: 225_000 * n,
      totalEncodeTime: 0.12 * n,
      packetsSent: 200 * n,
      totalPacketSendDelay: 0.2 * n,
      scalabilityMode: 'L1T1',
      encoderImplementation:
        'SimulcastEncoderAdapter (MediaFoundationVideoEncodeAccelerator (NVIDIA AV1 Encoder MFT))',
      powerEfficientEncoder: true,
      qualityLimitationReason: 'none',
      active: true
    }),
    s('o-h', 'outbound-rtp', t, {
      kind: 'video',
      rid: 'h',
      codecId: 'c1',
      frameWidth: 2560,
      frameHeight: 1440,
      framesEncoded: 58 * n,
      framesSent: 57 * n,
      bytesSent: 1_500_000 * n,
      totalEncodeTime: 0.58 * n,
      packetsSent: 1000 * n,
      totalPacketSendDelay: 2 * n,
      keyFramesEncoded: 1,
      scalabilityMode: 'L1T1',
      encoderImplementation:
        'SimulcastEncoderAdapter (MediaFoundationVideoEncodeAccelerator (NVIDIA AV1 Encoder MFT))',
      powerEfficientEncoder: true,
      qualityLimitationReason: 'none',
      targetBitrate: 12_000_000,
      active: true
    }),
    s('cp', 'candidate-pair', t, {
      nominated: true,
      currentRoundTripTime: 0.004,
      availableOutgoingBitrate: 30_000_000
    })
  ]
}

describe('sender (outbound) stats', () => {
  it('reports capture, encoded and sent fps separately per layer', () => {
    const out = summarizeOutboundVideo(sender(2000, 2), sender(1000, 1))
    expect(out.captureFps).toBe(58)
    expect(out.top).toMatchObject({
      rid: 'h',
      codec: 'AV1',
      width: 2560,
      encodedFps: 58,
      sentFps: 57,
      bitrateKbps: 12000,
      encodeMs: 10,
      pacerMs: 2,
      scalabilityMode: 'L1T1',
      powerEfficient: true,
      keyFrames: 0,
      targetKbps: 12000
    })
    expect(out.layers.find((l) => l.rid === 'q')?.encodedFps).toBe(30)
    expect(out.totalBitrateKbps).toBe(13800)
    expect(out.estimatedUplinkKbps).toBe(30000)
    expect(out.rttMs).toBe(4)
  })

  it('gives no rates on the first sample instead of guessing', () => {
    const out = summarizeOutboundVideo(sender(1000, 1))
    expect(out.top?.encodedFps).toBeUndefined()
    expect(out.captureFps).toBeUndefined()
    expect(out.top?.encoder).toContain('NVIDIA AV1')
  })

  it('picks the largest active layer as top, ignoring paused layers', () => {
    const cur = sender(2000, 2)
    const prev = sender(1000, 1)
    for (const st of [cur, prev]) {
      const h = st.find((x) => x.id === 'o-h')
      if (h) h.active = false
    }
    const out = summarizeOutboundVideo(cur, prev)
    expect(out.top?.rid).toBe('q')
    expect(out.layers.find((l) => l.rid === 'h')?.active).toBe(false)
  })

  it('survives a report with no video at all', () => {
    expect(summarizeOutboundVideo([], [])).toMatchObject({ layers: [], top: undefined })
  })
})

function receiver(t: number, n: number, id = 'in'): Stat[] {
  return [
    codec('c1', 'video/AV1', t),
    s(id, 'inbound-rtp', t, {
      kind: 'video',
      codecId: 'c1',
      frameWidth: 2560,
      frameHeight: 1440,
      framesReceived: 60 * n,
      framesDecoded: 59 * n,
      framesDropped: n,
      totalDecodeTime: 0.118 * n,
      jitterBufferDelay: 0.59 * n,
      jitterBufferTargetDelay: 0.708 * n,
      jitterBufferMinimumDelay: 0.708 * n,
      jitterBufferEmittedCount: 59 * n,
      totalProcessingDelay: 0.885 * n,
      freezeCount: n > 1 ? 1 : 0,
      totalFreezesDuration: n > 1 ? 0.25 : 0,
      bytesReceived: 1_500_000 * n,
      packetsReceived: 990 * n,
      packetsLost: 10 * n,
      decoderImplementation: 'D3D11VideoDecoder',
      powerEfficientDecoder: true
    }),
    s('cp', 'candidate-pair', t, { nominated: true, currentRoundTripTime: 0.012 })
  ]
}

describe('receiver (inbound) stats', () => {
  it('separates received, decoded and dropped fps and averages per window', () => {
    const r = summarizeInboundVideo(receiver(2000, 2), receiver(1000, 1))
    expect(r).toMatchObject({
      codec: 'AV1',
      width: 2560,
      receivedFps: 60,
      decodedFps: 59,
      droppedFps: 1,
      decodeMs: 2,
      jitterBufferMs: 10,
      jitterTargetMs: 12,
      processingMs: 15,
      freezes: 1,
      freezeMs: 250,
      bitrateKbps: 12000,
      packetLossPct: 1,
      decoder: 'D3D11VideoDecoder',
      powerEfficient: true,
      rttMs: 12
    })
  })

  it('resets cleanly when the inbound stream changes (new track / layer switch)', () => {
    const r = summarizeInboundVideo(receiver(2000, 2, 'in-new'), receiver(1000, 1, 'in-old'))
    expect(r.receivedFps).toBeUndefined()
    expect(r.jitterBufferMs).toBeUndefined()
    expect(r.width).toBe(2560)
  })

  it('shows a reduced temporal layer as a real received-fps drop, not a display bug', () => {
    // Sender encodes 60 fps (L1T3) but the SFU forwards only the 30 fps base+T1 layers.
    const prev = receiver(1000, 1)
    const cur = receiver(2000, 1)
    const p = prev.find((x) => x.type === 'inbound-rtp')!
    const c = cur.find((x) => x.type === 'inbound-rtp')!
    c.framesReceived = (p.framesReceived as number) + 30
    c.framesDecoded = (p.framesDecoded as number) + 30
    c.jitterBufferEmittedCount = (p.jitterBufferEmittedCount as number) + 30
    expect(summarizeInboundVideo(cur, prev)).toMatchObject({ receivedFps: 30, decodedFps: 30 })
  })

  it('returns an empty summary when there is no inbound video', () => {
    expect(summarizeInboundVideo([])).toEqual({})
  })
})

describe('presentation (video element) stats', () => {
  it('uses requestVideoFrameCallback counters for shown fps and arrival→display', () => {
    const p = summarizePlayback(
      { t: 2000, presentedFrames: 160, receiveToDisplaySumMs: 3000, receiveToDisplayCount: 160 },
      { t: 1000, presentedFrames: 100, receiveToDisplaySumMs: 1200, receiveToDisplayCount: 100 }
    )
    expect(p).toMatchObject({
      presentedFps: 60,
      presentedSource: 'frame-callback',
      receiveToDisplayMs: 30
    })
  })

  it('falls back to getVideoPlaybackQuality when frame callbacks are unavailable', () => {
    const p = summarizePlayback(
      {
        t: 2000,
        totalVideoFrames: 160,
        droppedVideoFrames: 4,
        receiveToDisplaySumMs: 0,
        receiveToDisplayCount: 0
      },
      {
        t: 1000,
        totalVideoFrames: 100,
        droppedVideoFrames: 2,
        receiveToDisplaySumMs: 0,
        receiveToDisplayCount: 0
      }
    )
    expect(p).toMatchObject({
      presentedFps: 58,
      presentedSource: 'playback-quality',
      elementDroppedFps: 2
    })
    expect(p.receiveToDisplayMs).toBeUndefined()
  })

  it('returns nothing for the first sample, zero elapsed time or a reset element', () => {
    const a = { t: 1000, presentedFrames: 100, receiveToDisplaySumMs: 0, receiveToDisplayCount: 0 }
    expect(summarizePlayback(a)).toEqual({})
    expect(summarizePlayback(a, a)).toEqual({})
    expect(summarizePlayback({ ...a, t: 2000, presentedFrames: 3 }, a).presentedFps).toBeUndefined()
  })
})

describe('diagnostics rows', () => {
  it('labels encoder hardware only from Chromium’s flag', () => {
    expect(hardwareLabel(true)).toBe('hardware')
    expect(hardwareLabel(false)).toBe('software')
    expect(hardwareLabel(undefined)).toBe('not reported')
  })

  it('never shows one ambiguous fps number', () => {
    const rows = receiverRows(summarizeInboundVideo(receiver(2000, 2), receiver(1000, 1)), {
      presentedFps: 57
    })
    const fpsRow = rows.find((r) => r.label === 'Frame rate')
    expect(fpsRow?.value).toBe('received 60 · decoded 59 · shown 57 fps')
    expect(rows.find((r) => r.label === 'Decoder')?.value).toBe('D3D11VideoDecoder (hardware)')
    // WebRTC's framesDropped only; the element's playback-quality counter is not trusted.
    const dropped = receiverRows(summarizeInboundVideo(receiver(2000, 2), receiver(1000, 1)), {
      presentedFps: 57,
      elementDroppedFps: 47
    }).find((r) => r.label === 'Dropped frames')
    expect(dropped?.value).toBe('1/s (total 2)')
  })

  it('marks the bandwidth estimate as an estimate', () => {
    const rows = senderRows(summarizeOutboundVideo(sender(2000, 2), sender(1000, 1)))
    expect(rows.find((r) => r.label === 'Uplink estimate')?.kind).toBe('estimated')
    expect(rows.find((r) => r.label === 'Capture')?.value).toBe('2560×1440 · 58 fps')
    expect(rows.find((r) => r.label === 'Codec')?.value).toBe('AV1 · L1T1')
  })
})

describe('share health (no silent downgrades)', () => {
  const target = { width: 2560, height: 1440, fps: 60 }

  it('warns when CPU or bandwidth actually limits the stream', () => {
    const out = summarizeOutboundVideo(sender(2000, 2), sender(1000, 1))
    out.top = { ...out.top!, qualityLimitation: 'cpu', encodedFps: 31 }
    expect(shareHealth(out, target).warning).toBe(
      'Limited by encoder/CPU: sending 2560×1440 @ 31 fps'
    )
  })

  it('stays quiet when nothing is limited, or the source is simply smaller', () => {
    const out = summarizeOutboundVideo(sender(2000, 2), sender(1000, 1))
    expect(shareHealth(out, target).warning).toBeNull()
    out.captureWidth = 1920
    out.top = { ...out.top!, width: 1920, height: 1080, qualityLimitation: 'bandwidth' }
    expect(shareHealth(out, target).warning).toBeNull()
    expect(shareHealth(undefined, target).warning).toBeNull()
  })
})
