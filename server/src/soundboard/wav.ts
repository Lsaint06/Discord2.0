/**
 * Milestone 14: soundboard clip validation. Only uncompressed 16-bit PCM WAV (RIFF/WAVE) is
 * accepted — the desktop app converts whatever clip it can decode before uploading — so the
 * server can check the format and duration exactly from the header, with no decoder involved.
 */

export interface WavInfo {
  channels: number
  sampleRate: number
  bitsPerSample: number
  /** Bytes of PCM data. */
  dataBytes: number
  durationMs: number
}

export class WavError extends Error {
  constructor(
    readonly code: 'not_wav' | 'unsupported_wav' | 'too_long' | 'empty',
    message: string
  ) {
    super(message)
  }
}

/** Parses and checks a WAV file (the whole file in memory: clips are capped at a few hundred KB). */
export function parseWav(buf: Buffer, maxDurationMs: number): WavInfo {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavError('not_wav', 'Sounds must be WAV files.')
  }
  let offset = 12
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null
  let dataBytes = -1
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (body + size > buf.length && id !== 'data') {
      throw new WavError('not_wav', 'This WAV file is damaged.')
    }
    if (id === 'fmt ') {
      if (size < 16) throw new WavError('not_wav', 'This WAV file is damaged.')
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14)
      }
    } else if (id === 'data') {
      dataBytes = Math.min(size, buf.length - body)
      break
    }
    offset = body + size + (size % 2)
  }
  if (!fmt || dataBytes < 0) throw new WavError('not_wav', 'This WAV file is damaged.')
  if (
    fmt.format !== 1 ||
    fmt.bits !== 16 ||
    fmt.channels < 1 ||
    fmt.channels > 2 ||
    fmt.sampleRate < 8000 ||
    fmt.sampleRate > 48000
  ) {
    throw new WavError('unsupported_wav', 'Use 16-bit PCM WAV (mono or stereo, up to 48 kHz).')
  }
  const frameBytes = fmt.channels * 2
  if (dataBytes < frameBytes) throw new WavError('empty', 'This sound is empty.')
  const durationMs = Math.round((dataBytes / frameBytes / fmt.sampleRate) * 1000)
  if (durationMs > maxDurationMs) {
    throw new WavError('too_long', `Sounds can be at most ${maxDurationMs / 1000} seconds long.`)
  }
  return {
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bits,
    dataBytes,
    durationMs
  }
}
