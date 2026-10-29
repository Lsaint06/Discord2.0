import { describe, expect, it } from 'vitest'
import { parseCameraSettings } from './session'
import { DEFAULT_OVERLAY } from '../lib/overlay'

describe('camera settings (Milestone 14.5)', () => {
  it('defaults safely for older saved settings', () => {
    expect(parseCameraSettings({})).toEqual({
      cameraDeviceId: '',
      cameraPreset: 'balanced',
      cameraMirror: true,
      cameraHideSelf: false,
      receiveCameras: true,
      overlay: DEFAULT_OVERLAY
    })
  })

  it('keeps valid choices and rejects junk', () => {
    const parsed = parseCameraSettings({
      cameraDeviceId: 'abc123',
      cameraPreset: 'high',
      cameraMirror: false,
      cameraHideSelf: true,
      receiveCameras: false
    })
    expect(parsed).toMatchObject({
      cameraDeviceId: 'abc123',
      cameraPreset: 'high',
      cameraMirror: false,
      cameraHideSelf: true,
      receiveCameras: false
    })
    const junk = parseCameraSettings({
      cameraDeviceId: 'x'.repeat(1000),
      cameraPreset: 'ultra-8k',
      cameraMirror: 'yes',
      receiveCameras: 0
    })
    expect(junk.cameraDeviceId).toBe('')
    expect(junk.cameraPreset).toBe('balanced')
    expect(junk.cameraMirror).toBe(true)
    expect(junk.receiveCameras).toBe(true)
  })

  it('never restores a camera that was on: there is no stored camera-on state', () => {
    const parsed = parseCameraSettings({ cameraOn: true, camera: { status: 'on' } }) as Record<
      string,
      unknown
    >
    expect(parsed.cameraOn).toBeUndefined()
    expect(parsed.camera).toBeUndefined()
  })

  it('never restores the overlay as already enabled from a malformed value', () => {
    expect(parseCameraSettings({ overlay: 'on' }).overlay.enabled).toBe(false)
    expect(parseCameraSettings({ overlay: { enabled: 'true' } }).overlay.enabled).toBe(false)
  })
})
