/** Pure helpers for encoderFlags.ts (no Electron imports, unit tested). */

export interface EncoderFlags {
  /** Let Chromium use the GPU AV1 encoder for WebRTC on Windows (WebRtcAV1HWEncode). */
  av1HardwareEncode: boolean
}

export const ENCODER_FLAG_DEFAULTS: EncoderFlags = { av1HardwareEncode: true }

export function parseEncoderFlags(json: string): EncoderFlags {
  try {
    const raw = JSON.parse(json) as Record<string, unknown> | null
    return {
      av1HardwareEncode:
        typeof raw?.av1HardwareEncode === 'boolean'
          ? raw.av1HardwareEncode
          : ENCODER_FLAG_DEFAULTS.av1HardwareEncode
    }
  } catch {
    return { ...ENCODER_FLAG_DEFAULTS }
  }
}

/** Adds a feature to a comma-separated --enable-features value without duplicating it. */
export function mergeFeatureList(existing: string, feature: string): string {
  const list = existing
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
  if (!list.includes(feature)) list.push(feature)
  return list.join(',')
}
