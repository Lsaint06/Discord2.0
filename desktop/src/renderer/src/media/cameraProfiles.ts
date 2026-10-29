/**
 * Camera quality presets and the pure helpers around them (capture constraints, publish
 * encodings, error messages, whether the voice grant allows a camera). No LiveKit or DOM state:
 * MediaSession and CameraController use these.
 */

export type CameraPresetId = 'data-saver' | 'balanced' | 'high' | 'smooth'

export interface SimulcastLayer {
  width: number
  height: number
  fps: number
  maxBitrate: number
}

export interface CameraPreset {
  id: CameraPresetId
  label: string
  description: string
  width: number
  height: number
  fps: number
  /** Top layer bitrate (bits/s). */
  maxBitrate: number
  /** Lower simulcast layers, smallest first (viewers with small tiles or weak links get these). */
  layers: SimulcastLayer[]
  /** Only offered as an advanced choice: needs a camera that really delivers 60 fps. */
  advanced?: boolean
}

export const CAMERA_PRESETS: Record<CameraPresetId, CameraPreset> = {
  'data-saver': {
    id: 'data-saver',
    label: 'Data saver — 360p 15 fps',
    description: 'Lowest bandwidth and CPU. Good on weak connections.',
    width: 640,
    height: 360,
    fps: 15,
    maxBitrate: 400_000,
    layers: [{ width: 320, height: 180, fps: 15, maxBitrate: 120_000 }]
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced — 720p 30 fps',
    description: 'Recommended. Sharp at normal tile sizes.',
    width: 1280,
    height: 720,
    fps: 30,
    maxBitrate: 1_700_000,
    layers: [
      { width: 320, height: 180, fps: 15, maxBitrate: 150_000 },
      { width: 640, height: 360, fps: 30, maxBitrate: 500_000 }
    ]
  },
  high: {
    id: 'high',
    label: 'High quality — 1080p 30 fps',
    description: 'Only if your camera supports 1080p. Uses more upload bandwidth.',
    width: 1920,
    height: 1080,
    fps: 30,
    maxBitrate: 3_000_000,
    layers: [
      { width: 640, height: 360, fps: 30, maxBitrate: 500_000 },
      { width: 1280, height: 720, fps: 30, maxBitrate: 1_500_000 }
    ]
  },
  smooth: {
    id: 'smooth',
    label: 'Smooth motion — 720p 60 fps (advanced)',
    description: 'Only helps if your camera really delivers 60 fps; most webcams don’t.',
    width: 1280,
    height: 720,
    fps: 60,
    maxBitrate: 2_500_000,
    layers: [
      { width: 320, height: 180, fps: 15, maxBitrate: 150_000 },
      { width: 640, height: 360, fps: 30, maxBitrate: 500_000 }
    ],
    advanced: true
  }
}

export const DEFAULT_CAMERA_PRESET: CameraPresetId = 'balanced'

export function parseCameraPreset(raw: unknown): CameraPresetId {
  return typeof raw === 'string' && Object.hasOwn(CAMERA_PRESETS, raw)
    ? (raw as CameraPresetId)
    : DEFAULT_CAMERA_PRESET
}

/**
 * getUserMedia constraints. Size and frame rate are `ideal` (never `exact`), so a camera that
 * can't do 1080p falls back to what it can instead of failing. The device is `exact` only when
 * one was chosen; the caller retries with the default device if that one is gone.
 */
export function cameraConstraints(preset: CameraPreset, deviceId?: string): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: preset.width },
    height: { ideal: preset.height },
    frameRate: { ideal: preset.fps, max: preset.fps },
    aspectRatio: { ideal: 16 / 9 }
  }
}

/**
 * The simulcast layers to send for what the camera actually delivers: lower layers that aren't
 * smaller than the capture are dropped, and the top layer's bitrate scales with the real size.
 */
export function cameraEncodings(
  preset: CameraPreset,
  actual: { width?: number; height?: number; fps?: number }
): { maxBitrate: number; maxFramerate: number; layers: SimulcastLayer[] } {
  const width = actual.width ?? preset.width
  const height = actual.height ?? preset.height
  const fps = Math.min(actual.fps ?? preset.fps, preset.fps)
  const pixels = width * height
  const presetPixels = preset.width * preset.height
  const scale = Math.min(1, pixels / presetPixels) * Math.min(1, fps / preset.fps)
  const maxBitrate = Math.max(150_000, Math.round(preset.maxBitrate * Math.max(scale, 0.25)))
  const layers = preset.layers
    .filter((l) => l.width * l.height < pixels)
    .map((l) => ({ ...l, fps: Math.min(l.fps, fps) }))
  return { maxBitrate, maxFramerate: fps, layers }
}

export type CameraFailure =
  'permission' | 'not-found' | 'in-use' | 'constraints' | 'timeout' | 'unavailable' | 'unknown'

export function classifyCameraError(err: unknown): CameraFailure {
  const name =
    err instanceof Error || (err && typeof err === 'object' && 'name' in err)
      ? String((err as { name?: unknown }).name)
      : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'permission'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'not-found'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'in-use'
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'constraints'
    case 'TimeoutError':
      return 'timeout'
    case 'CameraUnavailableError':
      return 'unavailable'
    default:
      return 'unknown'
  }
}

const FAILURE_MESSAGES: Record<CameraFailure, string> = {
  permission:
    'Camera access is blocked. Allow it in Windows Settings → Privacy & security → Camera (including “Let desktop apps access your camera”).',
  'not-found': 'No camera was found. Connect one, then try again.',
  'in-use':
    'Your camera is busy in another app or its driver failed. Close the other app and try again.',
  constraints: 'Your camera can’t provide that video format. Try another quality setting.',
  timeout: 'Your camera didn’t start in time. Unplug it and plug it back in, then try again.',
  unavailable: 'Cameras aren’t available in this voice channel.',
  unknown: 'The camera couldn’t start.'
}

export function cameraErrorMessage(err: unknown): string {
  const failure = classifyCameraError(err)
  if (failure === 'unknown' && err instanceof Error && err.message) {
    return `${FAILURE_MESSAGES.unknown} (${err.message})`
  }
  return FAILURE_MESSAGES[failure]
}

/** An error with a DOMException-like name (for timeouts and our own refusals). */
export function namedError(name: string, message: string): Error {
  const err = new Error(message)
  err.name = name
  return err
}

/**
 * Whether LiveKit's participant permissions allow publishing a camera. `sources` are already
 * converted to LiveKit source names ('camera', 'microphone', …). An empty list means LiveKit
 * allows every source; undefined permissions mean we don't know yet (not connected).
 */
export function cameraAllowedBy(
  permissions: { canPublish: boolean; canPublishSources: string[] } | undefined
): boolean | null {
  if (!permissions) return null
  if (!permissions.canPublish) return false
  return (
    permissions.canPublishSources.length === 0 || permissions.canPublishSources.includes('camera')
  )
}
