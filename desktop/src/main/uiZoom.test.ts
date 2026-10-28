import { describe, expect, it } from 'vitest'
import {
  UI_ZOOM_DEFAULT,
  UI_ZOOM_STEPS,
  normalizeZoom,
  parseZoomFile,
  stepZoom,
  zoomKeyAction,
  type ZoomKeyInput
} from './uiZoomLogic'

const key = (
  k: string,
  mods: Partial<{ control: boolean; meta: boolean; alt: boolean }> = {}
): ZoomKeyInput => ({
  type: 'keyDown',
  key: k,
  control: false,
  meta: false,
  alt: false,
  ...mods
})

describe('ui zoom', () => {
  it('has sorted steps that include the default', () => {
    expect([...UI_ZOOM_STEPS].sort((a, b) => a - b)).toEqual(UI_ZOOM_STEPS)
    expect(UI_ZOOM_STEPS).toContain(UI_ZOOM_DEFAULT)
    expect(Math.min(...UI_ZOOM_STEPS)).toBeGreaterThanOrEqual(0.5)
    expect(Math.max(...UI_ZOOM_STEPS)).toBeLessThanOrEqual(2)
  })

  it('accepts only listed steps', () => {
    expect(normalizeZoom(1.25)).toBe(1.25)
    expect(normalizeZoom(1.2500001)).toBe(1.25)
    expect(normalizeZoom(1.3)).toBe(UI_ZOOM_DEFAULT)
    expect(normalizeZoom(5)).toBe(UI_ZOOM_DEFAULT)
    expect(normalizeZoom(Number.NaN)).toBe(UI_ZOOM_DEFAULT)
    expect(normalizeZoom('1.25')).toBe(UI_ZOOM_DEFAULT)
    expect(normalizeZoom(undefined)).toBe(UI_ZOOM_DEFAULT)
  })

  it('parses the saved file defensively', () => {
    expect(parseZoomFile('{"zoomFactor":1.1}')).toBe(1.1)
    expect(parseZoomFile('{"zoomFactor":9}')).toBe(UI_ZOOM_DEFAULT)
    expect(parseZoomFile('null')).toBe(UI_ZOOM_DEFAULT)
    expect(parseZoomFile('not json')).toBe(UI_ZOOM_DEFAULT)
    expect(parseZoomFile('')).toBe(UI_ZOOM_DEFAULT)
  })

  it('steps and clamps at the ends', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(UI_ZOOM_STEPS[0], -1)).toBe(UI_ZOOM_STEPS[0])
    const last = UI_ZOOM_STEPS[UI_ZOOM_STEPS.length - 1]
    expect(stepZoom(last, 1)).toBe(last)
    expect(stepZoom(1.12, 1)).toBe(1.25) // snaps to 1.1, then steps
  })

  it('maps Ctrl shortcuts (Cmd on macOS) and ignores everything else', () => {
    expect(zoomKeyAction(key('=', { control: true }), false)).toBe('in')
    expect(zoomKeyAction(key('+', { control: true }), false)).toBe('in')
    expect(zoomKeyAction(key('-', { control: true }), false)).toBe('out')
    expect(zoomKeyAction(key('0', { control: true }), false)).toBe('reset')
    expect(zoomKeyAction(key('=', { meta: true }), true)).toBe('in')
    expect(zoomKeyAction(key('=', { control: true }), true)).toBeNull()
    expect(zoomKeyAction(key('='), false)).toBeNull()
    expect(zoomKeyAction(key('=', { control: true, alt: true }), false)).toBeNull()
    expect(zoomKeyAction({ ...key('=', { control: true }), type: 'keyUp' }, false)).toBeNull()
    expect(zoomKeyAction(key('a', { control: true }), false)).toBeNull()
  })
})
