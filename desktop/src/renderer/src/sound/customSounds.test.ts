import { describe, expect, it } from 'vitest'
import {
  CUSTOM_SOUND_MAX_BYTES,
  MAX_CUSTOM_SOUNDS,
  checkDecoded,
  checkImport,
  normalizationGain,
  sniffAudioFormat,
  soundNameFromFile
} from './customSounds'
import { PEAK_LIMIT, TARGET_RMS, audibleRms, peakOf } from './sounds'

const bytes = (...parts: (string | number[])[]): Uint8Array => {
  const out: number[] = []
  for (const p of parts)
    out.push(...(typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p))
  while (out.length < 16) out.push(0)
  return new Uint8Array(out)
}
const WAV = bytes('RIFF', [0, 0, 0, 0], 'WAVE')
const OGG = bytes('OggS')
const MP3_ID3 = bytes('ID3')
const MP3_FRAME = bytes([0xff, 0xfb, 0x90, 0x00])

describe('custom sound files', () => {
  it('recognizes WAV, OGG and MP3 by their bytes, not the name', () => {
    expect(sniffAudioFormat(WAV)).toBe('wav')
    expect(sniffAudioFormat(OGG)).toBe('ogg')
    expect(sniffAudioFormat(MP3_ID3)).toBe('mp3')
    expect(sniffAudioFormat(MP3_FRAME)).toBe('mp3')
    expect(sniffAudioFormat(bytes('MZ'))).toBeNull() // a Windows program
    expect(sniffAudioFormat(bytes('%PDF-1.7'))).toBeNull()
    expect(sniffAudioFormat(bytes([0x89], 'PNG'))).toBeNull()
    expect(sniffAudioFormat(new Uint8Array(4))).toBeNull()
  })

  it('checks count, emptiness, size and format before decoding', () => {
    const file = (size: number): { name: string; size: number } => ({ name: 'ding.wav', size })
    expect(checkImport(file(5000), WAV, 0)).toEqual({ ok: true, format: 'wav' })
    expect(checkImport(file(0), WAV, 0)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/empty/)
    })
    expect(checkImport(file(CUSTOM_SOUND_MAX_BYTES + 1), WAV, 0)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/1 MB/)
    })
    expect(checkImport(file(5000), bytes('MZ'), 0)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/WAV, MP3 and OGG/)
    })
    expect(checkImport(file(5000), WAV, MAX_CUSTOM_SOUNDS)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/up to 20/)
    })
  })

  it('rejects long, empty or silent audio after decoding', () => {
    const tone = new Float32Array(4800).map((_, i) => 0.5 * Math.sin(i / 5))
    expect(checkDecoded(0.1, tone)).toBeNull()
    expect(checkDecoded(5, tone)).toBeNull()
    expect(checkDecoded(6.2, tone)).toMatch(/6\.2 seconds/)
    expect(checkDecoded(0, tone)).toMatch(/no audio/)
    expect(checkDecoded(0.1, new Float32Array(4800))).toMatch(/silent/)
  })

  it('matches the built-in loudness without clipping or over-boosting', () => {
    const loud = new Float32Array(48_000).map((_, i) => 0.95 * Math.sin(i / 7))
    const gain = normalizationGain(loud)
    const gained = loud.map((s) => s * gain)
    expect(peakOf(gained)).toBeLessThanOrEqual(PEAK_LIMIT + 1e-6)
    expect(audibleRms(gained)).toBeLessThanOrEqual(TARGET_RMS + 1e-6)
    const whisper = new Float32Array(48_000).map((_, i) => 0.001 * Math.sin(i / 7))
    expect(normalizationGain(whisper)).toBe(4) // capped boost
  })

  it('makes safe display names from file names', () => {
    expect(soundNameFromFile('My Ding.wav')).toBe('My Ding')
    expect(soundNameFromFile('\u202Eevil\u0007.mp3')).toBe('evil')
    expect(soundNameFromFile('.ogg')).toBe('Custom sound')
    expect(soundNameFromFile('x'.repeat(80) + '.wav')).toHaveLength(40)
  })
})
