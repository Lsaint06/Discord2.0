/**
 * Milestone 14: turns any audio clip Chromium can decode into the soundboard's upload format —
 * 16-bit PCM mono WAV at 48 kHz, at most 5 s, with short fades and a loudness cap so nobody's
 * clip is much louder than the rest. The server re-checks the format and length.
 */
import { SOUNDBOARD_LIMITS } from '../net/protocol'

export const SOUNDBOARD_RATE = 48000
const PEAK_CEILING = 10 ** (-1 / 20) // -1 dBFS
const RMS_CEILING = 10 ** (-16 / 20) // never louder than -16 dBFS RMS

/** 16-bit PCM mono WAV bytes for the given samples (-1…1). */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, Math.round(s * 32767), true)
  }
  return bytes
}

/** Trims, fades and caps a mono clip in place; returns the (possibly shorter) samples. */
export function prepareClip(samples: Float32Array, sampleRate: number): Float32Array {
  const max = Math.floor((SOUNDBOARD_LIMITS.maxDurationMs / 1000) * sampleRate)
  // Skip leading silence (below -50 dBFS) so the clip starts when the sound does.
  let start = 0
  while (start < samples.length && Math.abs(samples[start]!) < 0.003) start++
  const out = samples.slice(start, Math.min(samples.length, start + max))
  const fadeIn = Math.min(out.length, Math.round(0.005 * sampleRate))
  const fadeOut = Math.min(out.length, Math.round(0.02 * sampleRate))
  for (let i = 0; i < fadeIn; i++) out[i] = out[i]! * (i / fadeIn)
  for (let i = 0; i < fadeOut; i++)
    out[out.length - 1 - i] = out[out.length - 1 - i]! * (i / fadeOut)
  let peak = 0
  let sum = 0
  for (const s of out) {
    peak = Math.max(peak, Math.abs(s))
    sum += s * s
  }
  const rms = out.length ? Math.sqrt(sum / out.length) : 0
  // Only ever turn clips down (never amplify noise).
  let gain = 1
  if (peak > PEAK_CEILING) gain = Math.min(gain, PEAK_CEILING / peak)
  if (rms > RMS_CEILING) gain = Math.min(gain, RMS_CEILING / rms)
  if (gain < 1) for (let i = 0; i < out.length; i++) out[i] = out[i]! * gain
  return out
}

/** Decodes a picked file and converts it to the upload format. */
export async function clipToWav(file: Blob): Promise<{ wav: Blob; durationMs: number }> {
  const data = await file.arrayBuffer()
  // An offline context resamples to 48 kHz while decoding.
  const decoder = new OfflineAudioContext(1, SOUNDBOARD_RATE, SOUNDBOARD_RATE)
  const buffer = await decoder.decodeAudioData(data)
  const mono = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c)
    for (let i = 0; i < buffer.length; i++)
      mono[i] = mono[i]! + channel[i]! / buffer.numberOfChannels
  }
  const clip = prepareClip(mono, buffer.sampleRate)
  if (clip.length === 0) throw new Error('This clip is silent.')
  const wav = encodeWav(clip, buffer.sampleRate)
  return {
    wav: new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }),
    durationMs: Math.round((clip.length / buffer.sampleRate) * 1000)
  }
}
