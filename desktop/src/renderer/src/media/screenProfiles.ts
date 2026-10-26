/**
 * Screen-share quality profiles and the math that turns them into capture constraints and
 * encoder settings. Pure (no DOM / LiveKit objects) so it can be unit tested.
 *
 * Profiles are *targets*: capture uses max-only constraints, so a smaller source is never
 * upscaled, and the encoder may reduce resolution/frame rate under CPU or network pressure.
 */

export type ScreenProfileId = 'balanced' | 'smooth' | 'high'
export type ScreenContentHint = 'motion' | 'detail'
export type ScreenCodec = 'h264' | 'vp9' | 'av1'

export interface ScreenProfile {
  id: ScreenProfileId
  label: string
  description: string
  width: number
  height: number
  fps: number
  /** Encoder ceiling at the full target resolution/frame rate, bits per second. */
  maxBitrate: number
}

export const SCREEN_PROFILES: Record<ScreenProfileId, ScreenProfile> = {
  balanced: {
    id: 'balanced',
    label: '1080p 30fps',
    description: 'Lower bandwidth; good for documents and slower content.',
    width: 1920,
    height: 1080,
    fps: 30,
    maxBitrate: 4_500_000
  },
  smooth: {
    id: 'smooth',
    label: '1080p 60fps (Smooth)',
    description: 'Recommended for games and motion.',
    width: 1920,
    height: 1080,
    fps: 60,
    maxBitrate: 8_000_000
  },
  high: {
    id: 'high',
    label: '1440p 60fps (High Quality)',
    description: 'Needs a 1440p+ source, a hardware encoder and a fast network.',
    width: 2560,
    height: 1440,
    fps: 60,
    maxBitrate: 14_000_000
  }
}

export const DEFAULT_SCREEN_PROFILE: ScreenProfileId = 'smooth'
export const DEFAULT_SCREEN_CODEC: ScreenCodec = 'h264'

export const SCREEN_CODEC_LABELS: Record<ScreenCodec, string> = {
  h264: 'H.264 (widest hardware support)',
  vp9: 'VP9',
  av1: 'AV1 (newest GPUs only)'
}

export interface Size {
  width: number
  height: number
}

/** getDisplayMedia constraints: caps only, never minimums, so sources are not upscaled. */
export function captureConstraints(profile: ScreenProfile): MediaTrackConstraints {
  return {
    width: { max: profile.width },
    height: { max: profile.height },
    frameRate: { ideal: profile.fps, max: profile.fps }
  }
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/** Output size for a source under a profile: aspect preserved, scale never above 1. */
export function fitWithin(source: Size, profile: Pick<ScreenProfile, 'width' | 'height'>): Size {
  const scale = Math.min(1, profile.width / source.width, profile.height / source.height)
  return { width: even(source.width * scale), height: even(source.height * scale) }
}

/**
 * Whether a source can genuinely deliver the profile's resolution. 1440p from a 1080p monitor
 * would just be upscaled, so the UI warns instead of claiming 1440p. Unknown size ⇒ undefined.
 */
export function sourceSupportsProfile(
  source: Size | undefined,
  profile: ScreenProfile
): boolean | undefined {
  if (!source?.width || !source?.height) return undefined
  // Allow portrait/ultrawide sources: compare the long and short edges.
  const long = Math.max(source.width, source.height)
  const short = Math.min(source.width, source.height)
  return long >= profile.width * 0.95 && short >= profile.height * 0.95
}

/** Scale the bitrate ceiling by the pixels/second actually being sent (min 25% of the ceiling). */
export function scaledBitrate(profile: ScreenProfile, actual: Size & { fps: number }): number {
  const target = profile.width * profile.height * profile.fps
  const sending = actual.width * actual.height * Math.min(actual.fps || profile.fps, profile.fps)
  const ratio = Math.min(1, Math.max(0.25, sending / target))
  return Math.round(profile.maxBitrate * ratio)
}

export interface SimulcastLayer extends Size {
  fps: number
  maxBitrate: number
}

/**
 * One low-resolution backup layer for viewers on weak links (the SFU picks per viewer and
 * dynacast pauses it when nobody needs it). Only worth it above 720p.
 */
export function lowLayerFor(actual: Size): SimulcastLayer | null {
  if (actual.height <= 720) return null
  const size = fitWithin(actual, { width: 1280, height: 720 })
  return { ...size, fps: 30, maxBitrate: 1_800_000 }
}

/** Games want frame rate; text/slides want sharpness. */
export function degradationPreference(hint: ScreenContentHint): RTCDegradationPreference {
  return hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution'
}

/** Safe default: 1080p60 unless the machine looks underpowered. */
export function recommendedProfile(hardwareConcurrency: number | undefined): ScreenProfileId {
  return hardwareConcurrency !== undefined && hardwareConcurrency < 4 ? 'balanced' : 'smooth'
}

/** Projected viewer-side egress from the SFU for N viewers (one full-quality copy each). */
export function projectedEgressMbps(profile: ScreenProfile, viewers: number): number {
  return Math.round(((profile.maxBitrate * viewers) / 1_000_000) * 10) / 10
}
