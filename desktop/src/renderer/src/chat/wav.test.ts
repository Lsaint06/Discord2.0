import { describe, expect, it, vi } from 'vitest'
import { encodeWav, prepareClip, SOUNDBOARD_RATE } from './wav'
import { SoundService, type AudioBufferLike, type BufferSourceLike } from '../sound/SoundService'
import { DEFAULT_SOUND_EVENTS } from '../sound/soundPolicy'

describe('soundboard clip conversion', () => {
  it('encodes 16-bit PCM mono WAV with a correct header', () => {
    const bytes = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1, 2]), 48000)
    const view = new DataView(bytes.buffer)
    const ascii = (o: number, n: number): string => String.fromCharCode(...bytes.subarray(o, o + n))
    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(12)
    expect(view.getInt16(44 + 2, true)).toBe(16384)
    // Out-of-range samples are clipped, not wrapped.
    expect(view.getInt16(44 + 10, true)).toBe(32767)
  })

  it('trims leading silence, caps the length at 5 s and fades the edges', () => {
    const rate = SOUNDBOARD_RATE
    const input = new Float32Array(rate * 7)
    for (let i = rate; i < input.length; i++) input[i] = 0.2 * Math.sin(i / 10)
    const out = prepareClip(input, rate)
    expect(out.length).toBe(rate * 5)
    expect(Math.abs(out[0]!)).toBeCloseTo(0, 6)
    expect(Math.abs(out[out.length - 1]!)).toBeCloseTo(0, 6)
  })

  it('turns loud clips down (never up)', () => {
    const loud = new Float32Array(48000).map((_, i) => (i % 2 ? 1 : -1))
    const out = prepareClip(loud, 48000)
    const peak = Math.max(...out.map(Math.abs))
    expect(peak).toBeLessThan(0.9)
    const quiet = new Float32Array(48000).map((_, i) => 0.05 * Math.sin(i / 5))
    const q = prepareClip(quiet, 48000)
    expect(Math.max(...q.map(Math.abs))).toBeLessThanOrEqual(0.0500001)
  })
})

describe('soundboard playback', () => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  function setup() {
    const destination = { name: 'speakers' }
    const gains: {
      gain: { value: number }
      connect: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
    }[] = []
    const sources: BufferSourceLike[] = []
    const decoded: AudioBufferLike = { copyToChannel: () => undefined }
    const decode = vi.fn(async () => decoded)
    const ctx = {
      state: 'running',
      sampleRate: 48000,
      currentTime: 0,
      destination,
      createBuffer: () => ({ copyToChannel: () => undefined }),
      createBufferSource: () => {
        const s: BufferSourceLike = {
          buffer: null,
          onended: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn()
        }
        sources.push(s)
        return s
      },
      createGain: () => {
        const g = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
        gains.push(g)
        return g
      },
      resume: async () => undefined,
      suspend: async () => undefined,
      close: async () => undefined,
      decodeAudioData: decode
    }
    const service = new SoundService({ createContext: () => ctx })
    service.setPreferences({ enabled: true, volume: 20, events: { ...DEFAULT_SOUND_EVENTS } })
    return { service, ctx, gains, sources, decode, destination }
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('plays at its own volume, straight to the output (not the sound-effects volume)', async () => {
    const { service, gains, sources, destination } = setup()
    const load = vi.fn(async () => new ArrayBuffer(16))
    expect(service.playClip('s1', load, 50)).toBe('played')
    await flush()
    expect(sources).toHaveLength(1)
    const clipGain = gains.at(-1)!
    expect(clipGain.gain.value).toBeCloseTo(0.25)
    expect(clipGain.connect).toHaveBeenCalledWith(destination)
  })

  it('decodes each clip once; volume 0 plays nothing', async () => {
    const { service, decode } = setup()
    const load = vi.fn(async () => new ArrayBuffer(16))
    service.playClip('s1', load, 70)
    service.playClip('s1', load, 70)
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
    expect(decode).toHaveBeenCalledTimes(1)
    expect(service.playClip('s2', load, 0)).toBe('skipped')
  })

  it('a clip that fails to load is silent and doesn’t break later clips', async () => {
    const { service, sources } = setup()
    service.playClip(
      'bad',
      async () => {
        throw new Error('404')
      },
      70
    )
    await flush()
    expect(sources).toHaveLength(0)
    service.playClip('good', async () => new ArrayBuffer(8), 70)
    await flush()
    expect(sources).toHaveLength(1)
  })
})
