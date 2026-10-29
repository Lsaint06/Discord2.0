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
  sourceSupportsProfile,
  videoPublishPlan
} from './screenProfiles'
import { shouldSubscribe } from './subscriptions'
import {
  CaptureSelectionStore,
  isValidSourceId,
  SELECTION_TTL_MS
} from '../../../main/captureSelection'
import {
  ENCODER_FLAG_DEFAULTS,
  mergeFeatureList,
  parseEncoderFlags
} from '../../../main/encoderFlagsLogic'

describe('codec and layering selection', () => {
  const qhd = { width: 2560, height: 1440 }

  it('H.264 sends full resolution plus a 720p30 backup layer', () => {
    const plan = videoPublishPlan('h264', 'simulcast', qhd)
    expect(plan.simulcast).toBe(true)
    expect(plan.scalabilityMode).toBeUndefined()
    expect(plan.layers).toEqual([{ width: 1280, height: 720, fps: 30, maxBitrate: 1_800_000 }])
  })

  it('AV1/VP9 default to single-layer (L1T1) simulcast so GPU encoders can be used', () => {
    for (const codec of ['av1', 'vp9'] as const) {
      expect(videoPublishPlan(codec, 'simulcast', qhd)).toMatchObject({
        simulcast: true,
        scalabilityMode: 'L1T1'
      })
    }
  })

  it('keeps LiveKit’s L1T3 SVC available as an explicit option', () => {
    expect(videoPublishPlan('av1', 'svc', qhd)).toEqual({
      simulcast: false,
      scalabilityMode: 'L1T3',
      layers: []
    })
  })

  it('can drop the backup layer, and never adds one at or below 720p', () => {
    expect(videoPublishPlan('h264', 'simulcast', qhd, false)).toEqual({
      simulcast: false,
      layers: []
    })
    expect(videoPublishPlan('h264', 'simulcast', { width: 1280, height: 720 })).toEqual({
      simulcast: false,
      layers: []
    })
    // AV1 still uses the simulcast path (with one layer) so it stays L1T1, not L1T3.
    expect(videoPublishPlan('av1', 'simulcast', { width: 1280, height: 720 })).toEqual({
      simulcast: true,
      scalabilityMode: 'L1T1',
      layers: []
    })
  })
})

describe('encoder flags (main process)', () => {
  it('defaults to allowing hardware AV1 and ignores junk', () => {
    expect(ENCODER_FLAG_DEFAULTS.av1HardwareEncode).toBe(true)
    expect(parseEncoderFlags('not json')).toEqual(ENCODER_FLAG_DEFAULTS)
    expect(parseEncoderFlags('{"av1HardwareEncode":"yes"}')).toEqual(ENCODER_FLAG_DEFAULTS)
    expect(parseEncoderFlags('{"av1HardwareEncode":false}')).toEqual({ av1HardwareEncode: false })
  })

  it('merges into an existing --enable-features list without duplicates', () => {
    expect(mergeFeatureList('', 'WebRtcAV1HWEncode')).toBe('WebRtcAV1HWEncode')
    expect(mergeFeatureList('A, B', 'WebRtcAV1HWEncode')).toBe('A,B,WebRtcAV1HWEncode')
    expect(mergeFeatureList('WebRtcAV1HWEncode', 'WebRtcAV1HWEncode')).toBe('WebRtcAV1HWEncode')
  })
})

describe('quality profiles', () => {
  it('offers 720p30, 1080p30, 1080p60 and 1440p60 manual presets', () => {
    expect(Object.values(SCREEN_PROFILES).map((p) => `${p.height}p${p.fps}`)).toEqual([
      '720p30',
      '1080p30',
      '1080p60',
      '1440p60'
    ])
  })

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

  it('receives cameras only when camera viewing is on (deafening does not affect video)', () => {
    expect(shouldSubscribe('camera', base)).toBe(false)
    expect(shouldSubscribe('camera', { ...base, cameras: true })).toBe(true)
    expect(shouldSubscribe('camera', { ...base, cameras: true, deafened: true })).toBe(true)
    expect(shouldSubscribe('camera', { ...base, cameras: false, watching: 'bob' })).toBe(false)
  })

  it('camera and screen share are independent sources', () => {
    // Watching someone's stream never pulls in their camera by accident, and vice versa.
    expect(shouldSubscribe('screen_share', { ...base, cameras: true })).toBe(false)
    expect(shouldSubscribe('camera', { ...base, watching: 'bob' })).toBe(false)
  })

  it('never subscribes to unknown sources', () => {
    expect(shouldSubscribe('unknown', { ...base, cameras: true, watching: 'bob' })).toBe(false)
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
