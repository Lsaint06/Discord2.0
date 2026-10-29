import { describe, expect, it } from 'vitest'
import {
  CAMERA_PRESETS,
  cameraAllowedBy,
  cameraConstraints,
  cameraEncodings,
  classifyCameraError,
  namedError,
  parseCameraPreset
} from './cameraProfiles'

describe('camera presets', () => {
  it('offers data saver, balanced, high and an advanced 60 fps choice', () => {
    expect(Object.keys(CAMERA_PRESETS)).toEqual(['data-saver', 'balanced', 'high', 'smooth'])
    expect(CAMERA_PRESETS['data-saver']).toMatchObject({ width: 640, height: 360, fps: 15 })
    expect(CAMERA_PRESETS.balanced).toMatchObject({ width: 1280, height: 720, fps: 30 })
    expect(CAMERA_PRESETS.high).toMatchObject({ width: 1920, height: 1080, fps: 30 })
    expect(CAMERA_PRESETS.smooth.advanced).toBe(true)
  })

  it('stored values are validated (unknown → balanced)', () => {
    expect(parseCameraPreset('high')).toBe('high')
    expect(parseCameraPreset('4k-120')).toBe('balanced')
    expect(parseCameraPreset(undefined)).toBe('balanced')
    expect(parseCameraPreset('__proto__')).toBe('balanced')
  })

  it('asks for the preset as an ideal (never exact), with an exact device only when chosen', () => {
    const c = cameraConstraints(CAMERA_PRESETS.high)
    expect(c).toMatchObject({
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 }
    })
    expect(c.deviceId).toBeUndefined()
    expect(cameraConstraints(CAMERA_PRESETS.balanced, 'abc').deviceId).toEqual({ exact: 'abc' })
  })

  it('a camera that can only do 720p at 1080p settings sends fewer, smaller layers and less bitrate', () => {
    const full = cameraEncodings(CAMERA_PRESETS.high, { width: 1920, height: 1080, fps: 30 })
    expect(full.layers.map((l) => l.height)).toEqual([360, 720])
    expect(full.maxBitrate).toBe(3_000_000)
    const limited = cameraEncodings(CAMERA_PRESETS.high, { width: 1280, height: 720, fps: 30 })
    expect(limited.layers.map((l) => l.height)).toEqual([360])
    expect(limited.maxBitrate).toBeLessThan(full.maxBitrate)
  })

  it('a 60 fps preset on a 30 fps camera never claims 60', () => {
    const e = cameraEncodings(CAMERA_PRESETS.smooth, { width: 1280, height: 720, fps: 30 })
    expect(e.maxFramerate).toBe(30)
    expect(e.layers.every((l) => l.fps <= 30)).toBe(true)
  })
})

describe('camera errors', () => {
  it('maps browser errors to clear categories', () => {
    expect(classifyCameraError(namedError('NotAllowedError', ''))).toBe('permission')
    expect(classifyCameraError(namedError('NotFoundError', ''))).toBe('not-found')
    expect(classifyCameraError(namedError('NotReadableError', ''))).toBe('in-use')
    expect(classifyCameraError(namedError('OverconstrainedError', ''))).toBe('constraints')
    expect(classifyCameraError(namedError('TimeoutError', ''))).toBe('timeout')
    expect(classifyCameraError({ name: 'NotAllowedError' })).toBe('permission')
    expect(classifyCameraError('weird')).toBe('unknown')
  })
})

describe('camera grant', () => {
  it('reads LiveKit participant permissions (unknown before connecting)', () => {
    expect(cameraAllowedBy(undefined)).toBeNull()
    expect(cameraAllowedBy({ canPublish: false, canPublishSources: [] })).toBe(false)
    // An empty list means LiveKit allows every source.
    expect(cameraAllowedBy({ canPublish: true, canPublishSources: [] })).toBe(true)
    // Today's production server (API 4): microphone and screen share only.
    expect(
      cameraAllowedBy({
        canPublish: true,
        canPublishSources: ['microphone', 'screen_share', 'screen_share_audio']
      })
    ).toBe(false)
    expect(cameraAllowedBy({ canPublish: true, canPublishSources: ['microphone', 'camera'] })).toBe(
      true
    )
  })
})
