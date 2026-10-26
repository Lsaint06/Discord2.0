import { describe, expect, it } from 'vitest'
import {
  captureConstraints,
  degradationPreference,
  fitWithin,
  lowLayerFor,
  projectedEgressMbps,
  recommendedProfile,
  SCREEN_PROFILES,
  scaledBitrate,
  sourceSupportsProfile
} from './screenProfiles'
import { shouldSubscribe } from './subscriptions'
import { summarizeInboundVideo, summarizeOutboundVideo } from './stats'
import {
  CaptureSelectionStore,
  isValidSourceId,
  SELECTION_TTL_MS
} from '../../../main/captureSelection'

type RawStat = Record<string, unknown> & { id: string; type: string; timestamp: number }

describe('quality profiles', () => {
  it('uses max-only capture constraints (never upscales)', () => {
    expect(captureConstraints(SCREEN_PROFILES.smooth)).toEqual({
      width: { max: 1920 },
      height: { max: 1080 },
      frameRate: { ideal: 60, max: 60 }
    })
  })

  it('fits sources without upscaling and keeps aspect ratio', () => {
    expect(fitWithin({ width: 3840, height: 2160 }, SCREEN_PROFILES.high)).toEqual({
      width: 2560,
      height: 1440
    })
    expect(fitWithin({ width: 1920, height: 1080 }, SCREEN_PROFILES.high)).toEqual({
      width: 1920,
      height: 1080
    })
    expect(fitWithin({ width: 3440, height: 1440 }, SCREEN_PROFILES.smooth)).toEqual({
      width: 1920,
      height: 804
    })
  })

  it('only claims 1440p for genuinely large sources', () => {
    expect(sourceSupportsProfile({ width: 2560, height: 1440 }, SCREEN_PROFILES.high)).toBe(true)
    expect(sourceSupportsProfile({ width: 1920, height: 1080 }, SCREEN_PROFILES.high)).toBe(false)
    expect(sourceSupportsProfile(undefined, SCREEN_PROFILES.high)).toBeUndefined()
  })

  it('scales bitrate to what is actually sent', () => {
    expect(scaledBitrate(SCREEN_PROFILES.smooth, { width: 1920, height: 1080, fps: 60 })).toBe(
      8_000_000
    )
    expect(scaledBitrate(SCREEN_PROFILES.smooth, { width: 1920, height: 1080, fps: 30 })).toBe(
      4_000_000
    )
    // Floors at 25% so tiny windows still look decent.
    expect(scaledBitrate(SCREEN_PROFILES.high, { width: 640, height: 360, fps: 60 })).toBe(
      3_500_000
    )
  })

  it('adds a 720p backup layer only for larger streams', () => {
    expect(lowLayerFor({ width: 1920, height: 1080 })).toEqual({
      width: 1280,
      height: 720,
      fps: 30,
      maxBitrate: 1_800_000
    })
    expect(lowLayerFor({ width: 1280, height: 720 })).toBeNull()
  })

  it('maps content hints and defaults sensibly', () => {
    expect(degradationPreference('motion')).toBe('maintain-framerate')
    expect(degradationPreference('detail')).toBe('maintain-resolution')
    expect(recommendedProfile(16)).toBe('smooth')
    expect(recommendedProfile(2)).toBe('balanced')
    expect(projectedEgressMbps(SCREEN_PROFILES.smooth, 5)).toBe(40)
  })
})

describe('subscription policy', () => {
  const base = { identity: 'bob', deafened: false, watching: null as string | null }

  it('always receives microphones unless deafened', () => {
    expect(shouldSubscribe('microphone', base)).toBe(true)
    expect(shouldSubscribe('microphone', { ...base, deafened: true })).toBe(false)
  })

  it('only decodes a screen share while watching that person', () => {
    expect(shouldSubscribe('screen_share', base)).toBe(false)
    expect(shouldSubscribe('screen_share', { ...base, watching: 'bob' })).toBe(true)
    expect(shouldSubscribe('screen_share', { ...base, watching: 'carol' })).toBe(false)
  })

  it('plays shared audio only while watching and not deafened', () => {
    expect(shouldSubscribe('screen_share_audio', { ...base, watching: 'bob' })).toBe(true)
    expect(
      shouldSubscribe('screen_share_audio', { ...base, watching: 'bob', deafened: true })
    ).toBe(false)
    expect(shouldSubscribe('screen_share_audio', base)).toBe(false)
  })

  it('never subscribes to cameras or unknown sources', () => {
    expect(shouldSubscribe('camera', { ...base, watching: 'bob' })).toBe(false)
    expect(shouldSubscribe('unknown', base)).toBe(false)
  })
})

describe('WebRTC stats parsing', () => {
  const outbound = (
    bytesSent: number,
    timestamp: number,
    framesEncoded: number,
    totalEncodeTime: number
  ): RawStat[] => [
    { id: 'c1', type: 'codec', timestamp, mimeType: 'video/H264' },
    {
      id: 'o-hi',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp,
      bytesSent,
      frameWidth: 1920,
      frameHeight: 1080,
      framesPerSecond: 60,
      codecId: 'c1',
      encoderImplementation: 'MediaFoundationVideoEncodeAccelerator',
      powerEfficientEncoder: true,
      framesEncoded,
      totalEncodeTime,
      qualityLimitationReason: 'none'
    },
    {
      id: 'o-lo',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp,
      bytesSent: 0,
      frameWidth: 1280,
      frameHeight: 720
    },
    {
      id: 'r1',
      type: 'remote-inbound-rtp',
      kind: 'video',
      timestamp,
      roundTripTime: 0.004,
      fractionLost: 0.01
    },
    {
      id: 'm1',
      type: 'media-source',
      kind: 'video',
      timestamp,
      width: 2560,
      height: 1440,
      framesPerSecond: 60
    }
  ]

  it('summarizes the top outbound layer, bitrate and encode time', () => {
    const first = summarizeOutboundVideo(outbound(0, 1000, 0, 0))
    const second = summarizeOutboundVideo(outbound(1_000_000, 2000, 60, 0.3), first.sample)
    expect(second.summary).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 60,
      codec: 'H264',
      bitrateKbps: 8000,
      encoder: 'MediaFoundationVideoEncodeAccelerator',
      powerEfficient: true,
      encodeMsPerFrame: 5,
      rttMs: 4,
      packetLossPct: 1,
      captureWidth: 2560,
      captureFps: 60,
      layers: 2
    })
  })

  it('summarizes inbound video including loss and decoder', () => {
    const stats = (bytesReceived: number, timestamp: number): RawStat[] => [
      { id: 'c1', type: 'codec', timestamp, mimeType: 'video/VP9' },
      {
        id: 'i1',
        type: 'inbound-rtp',
        kind: 'video',
        timestamp,
        bytesReceived,
        packetsReceived: 990,
        packetsLost: 10,
        frameWidth: 2560,
        frameHeight: 1440,
        framesPerSecond: 59,
        codecId: 'c1',
        jitter: 0.002,
        decoderImplementation: 'D3D11VideoDecoder',
        powerEfficientDecoder: true,
        framesDropped: 3
      },
      { id: 't1', type: 'transport', timestamp, selectedCandidatePairId: 'p1' },
      { id: 'p1', type: 'candidate-pair', timestamp, currentRoundTripTime: 0.012 }
    ]
    const first = summarizeInboundVideo(stats(0, 0))
    const { summary } = summarizeInboundVideo(stats(500_000, 1000), first.sample)
    expect(summary).toMatchObject({
      width: 2560,
      fps: 59,
      codec: 'VP9',
      bitrateKbps: 4000,
      packetLossPct: 1,
      jitterMs: 2,
      decoder: 'D3D11VideoDecoder',
      powerEfficient: true,
      framesDropped: 3,
      rttMs: 12
    })
  })
})

describe('capture selection (main process)', () => {
  it('validates desktopCapturer source ids', () => {
    expect(isValidSourceId('screen:0:0')).toBe(true)
    expect(isValidSourceId('window:132456:0')).toBe(true)
    expect(isValidSourceId('screen:0:0; rm -rf')).toBe(false)
    expect(isValidSourceId(42)).toBe(false)
    expect(isValidSourceId('camera:0:0')).toBe(false)
  })

  it('grants an armed selection exactly once to the same window', () => {
    const store = new CaptureSelectionStore(() => 0)
    store.arm({ sourceId: 'screen:0:0', name: 'Screen', audio: true, senderId: 7 })
    const granted = store.consume(7)
    expect(granted).toMatchObject({ ok: true, selection: { sourceId: 'screen:0:0', audio: true } })
    expect(store.consume(7)).toEqual({ ok: false, reason: 'none' })
  })

  it('denies capture with no explicit selection (no auto-grant)', () => {
    expect(new CaptureSelectionStore().consume(1)).toEqual({ ok: false, reason: 'none' })
  })

  it('denies expired selections and other windows', () => {
    let now = 0
    const store = new CaptureSelectionStore(() => now)
    store.arm({ sourceId: 'screen:0:0', name: 'Screen', audio: false, senderId: 1 })
    now = SELECTION_TTL_MS + 1
    expect(store.consume(1)).toEqual({ ok: false, reason: 'expired' })

    now = 0
    store.arm({ sourceId: 'screen:0:0', name: 'Screen', audio: false, senderId: 1 })
    expect(store.consume(2)).toEqual({ ok: false, reason: 'wrong-sender' })
    // A failed attempt also clears the selection.
    expect(store.consume(1)).toEqual({ ok: false, reason: 'none' })
  })

  it('cancelling the picker clears any armed selection', () => {
    const store = new CaptureSelectionStore(() => 0)
    store.arm({ sourceId: 'window:5:0', name: 'Game', audio: false, senderId: 1 })
    store.clear()
    expect(store.consume(1)).toEqual({ ok: false, reason: 'none' })
  })

  it('grants the display-capture media permission once, only for an armed selection', () => {
    let now = 0
    const store = new CaptureSelectionStore(() => now)
    expect(store.takePermission(1)).toBe(false)
    store.arm({ sourceId: 'screen:0:0', name: 'Screen', audio: false, senderId: 1 })
    expect(store.takePermission(2)).toBe(false)
    expect(store.takePermission(1)).toBe(true)
    // A second (e.g. legacy chromeMediaSource) request can't reuse it.
    expect(store.takePermission(1)).toBe(false)
    // The capture handler still consumes the selection afterwards.
    expect(store.consume(1)).toMatchObject({ ok: true })

    store.arm({ sourceId: 'screen:0:0', name: 'Screen', audio: false, senderId: 1 })
    now = SELECTION_TTL_MS + 1
    expect(store.takePermission(1)).toBe(false)
  })
})
