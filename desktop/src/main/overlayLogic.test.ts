import { describe, expect, it } from 'vitest'
import {
  clampToDisplays,
  isOverlayOpenRequest,
  mediaCheckAllowed,
  mediaRequestAllowed,
  parseOverlayCommand
} from './overlayLogic'

const main = { appUrl: true, isMainFrame: true, isMainWindow: true }

describe('camera permission', () => {
  it('the app window may use the microphone and (now) the camera', () => {
    expect(mediaRequestAllowed({ ...main, mediaTypes: ['audio'] })).toBe(true)
    expect(mediaRequestAllowed({ ...main, mediaTypes: ['video'] })).toBe(true)
    expect(mediaRequestAllowed({ ...main, mediaTypes: ['audio', 'video'] })).toBe(true)
  })

  it('no camera for other windows (the overlay), subframes or foreign pages', () => {
    expect(mediaRequestAllowed({ ...main, isMainWindow: false, mediaTypes: ['video'] })).toBe(false)
    expect(mediaRequestAllowed({ ...main, isMainFrame: false, mediaTypes: ['video'] })).toBe(false)
    expect(mediaRequestAllowed({ ...main, appUrl: false, mediaTypes: ['video'] })).toBe(false)
    expect(mediaRequestAllowed({ ...main, appUrl: false, mediaTypes: ['audio'] })).toBe(false)
  })

  it('display capture (no media types) and unknown types are not decided here', () => {
    expect(mediaRequestAllowed({ ...main, mediaTypes: [] })).toBe(false)
    expect(mediaRequestAllowed({ ...main, mediaTypes: ['video', 'screen'] })).toBe(false)
  })

  it('device checks: cameras are listed for the app window only', () => {
    expect(mediaCheckAllowed({ appUrl: true, mediaType: 'video', isMainWindow: true })).toBe(true)
    expect(mediaCheckAllowed({ appUrl: true, mediaType: 'video', isMainWindow: false })).toBe(false)
    expect(mediaCheckAllowed({ appUrl: false, mediaType: 'audio', isMainWindow: true })).toBe(false)
  })
})

describe('overlay window requests', () => {
  it('only our named about:blank window from the app may be created', () => {
    expect(isOverlayOpenRequest({ url: 'about:blank', frameName: 'd2-camera-overlay' }, true)).toBe(
      true
    )
    expect(
      isOverlayOpenRequest({ url: 'about:blank', frameName: 'd2-camera-overlay' }, false)
    ).toBe(false)
    expect(
      isOverlayOpenRequest({ url: 'https://evil.example', frameName: 'd2-camera-overlay' }, true)
    ).toBe(false)
    expect(isOverlayOpenRequest({ url: 'about:blank', frameName: 'popup' }, true)).toBe(false)
  })

  it('validates updates from the renderer', () => {
    expect(
      parseOverlayCommand({
        visible: true,
        mode: 'view',
        bounds: { x: 10.4, y: 20, width: 470, height: 270 }
      })
    ).toEqual({
      visible: true,
      mode: 'view',
      bounds: { x: 10, y: 20, width: 470, height: 270 }
    })
    for (const bad of [
      null,
      [],
      'x',
      { visible: 'yes', mode: 'view', bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { visible: true, mode: 'click', bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { visible: true, mode: 'edit', bounds: { x: 0, y: 0, width: 10, height: 100 } },
      { visible: true, mode: 'edit', bounds: { x: Number.NaN, y: 0, width: 100, height: 100 } },
      { visible: true, mode: 'edit', bounds: { x: 1e9, y: 0, width: 100, height: 100 } },
      { visible: true, mode: 'edit' }
    ]) {
      expect(parseOverlayCommand(bad)).toBeNull()
    }
  })
})

describe('overlay bounds', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 }
  const second = { x: 1920, y: 0, width: 1280, height: 680 }
  it('stays on the display that holds its centre', () => {
    expect(
      clampToDisplays({ x: 3000, y: 400, width: 300, height: 200 }, [primary, second], primary)
    ).toEqual({
      x: 2900,
      y: 400,
      width: 300,
      height: 200
    })
  })
  it('a window left on an unplugged monitor comes back to the primary one', () => {
    expect(
      clampToDisplays({ x: 5000, y: 100, width: 300, height: 200 }, [primary], primary)
    ).toEqual({
      x: 1620,
      y: 100,
      width: 300,
      height: 200
    })
  })
  it('is never larger than the display', () => {
    expect(
      clampToDisplays({ x: 0, y: 0, width: 5000, height: 5000 }, [second], primary)
    ).toMatchObject({
      width: 1920,
      height: 1040
    })
  })
})
