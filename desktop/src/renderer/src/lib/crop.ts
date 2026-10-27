/**
 * Crop geometry for the profile image cropper (pure, unit-tested). The image is scaled to cover
 * the frame (`zoom` = 1) or more, and can be panned but never leaves a gap inside the frame.
 */

export interface Size {
  width: number
  height: number
}

export interface CropState {
  /** 1 = the image just covers the frame. */
  zoom: number
  /** Image top-left relative to the frame top-left, in frame pixels (always ≤ 0). */
  x: number
  y: number
}

export const MIN_ZOOM = 1
export const MAX_ZOOM = 4

export function coverScale(image: Size, frame: Size): number {
  return Math.max(frame.width / image.width, frame.height / image.height)
}

/** Keeps the zoom in range and the image covering the frame. */
export function clampCrop(image: Size, frame: Size, state: CropState): CropState {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.zoom))
  const scale = coverScale(image, frame) * zoom
  const minX = frame.width - image.width * scale
  const minY = frame.height - image.height * scale
  return {
    zoom,
    x: Math.min(0, Math.max(minX, state.x)),
    y: Math.min(0, Math.max(minY, state.y))
  }
}

/** Centered crop at zoom 1. */
export function initialCrop(image: Size, frame: Size): CropState {
  const scale = coverScale(image, frame)
  return {
    zoom: 1,
    x: (frame.width - image.width * scale) / 2,
    y: (frame.height - image.height * scale) / 2
  }
}

/** Zooms around the frame center (what stays in the middle stays in the middle). */
export function zoomCrop(image: Size, frame: Size, state: CropState, nextZoom: number): CropState {
  const scale = coverScale(image, frame) * state.zoom
  const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom))
  const nextScale = coverScale(image, frame) * target
  const cx = (frame.width / 2 - state.x) / scale
  const cy = (frame.height / 2 - state.y) / scale
  return clampCrop(image, frame, {
    zoom: target,
    x: frame.width / 2 - cx * nextScale,
    y: frame.height / 2 - cy * nextScale
  })
}

/** The rectangle of the original image (natural pixels) that is visible in the frame. */
export function sourceRect(
  image: Size,
  frame: Size,
  state: CropState
): { sx: number; sy: number; sw: number; sh: number } {
  const scale = coverScale(image, frame) * state.zoom
  const sw = Math.min(image.width, frame.width / scale)
  const sh = Math.min(image.height, frame.height / scale)
  return {
    sx: Math.max(0, Math.min(image.width - sw, -state.x / scale)),
    sy: Math.max(0, Math.min(image.height - sh, -state.y / scale)),
    sw,
    sh
  }
}
