import { describe, expect, it, vi } from 'vitest'
import {
  SoundService,
  volumeToGain,
  type AudioBufferLike,
  type AudioContextLike,
  type BufferSourceLike,
  type GainNodeLike
} from './SoundService'
import { DEFAULT_SOUND_EVENTS, type SoundPreferences } from './soundPolicy'

class FakeSource implements BufferSourceLike {
  buffer: AudioBufferLike | null = null
  onended: (() => void) | null = null
  startedAt: number | null = null
  stopped = false
  connect = vi.fn()
  disconnect = vi.fn()
  start(when = 0): void {
    this.startedAt = when
  }
  stop(): void {
    this.stopped = true
  }
  end(): void {
    this.onended?.()
  }
}

class FakeContext implements AudioContextLike {
  state: string
  sampleRate = 48_000
  currentTime = 10
  destination = {}
  sources: FakeSource[] = []
  gains: GainNodeLike[] = []
  buffers = 0
  sinkIds: string[] = []
  resumeFails = false
  sinkFails = new Set<string>()
  closed = false
  suspended = 0
  constructor(state = 'running', withSink = true) {
    this.state = state
    if (!withSink) this.setSinkId = undefined
  }
  createBuffer(): AudioBufferLike {
    this.buffers++
    return { copyToChannel: () => undefined }
  }
  createBufferSource(): BufferSourceLike {
    const s = new FakeSource()
    this.sources.push(s)
    return s
  }
  createGain(): GainNodeLike {
    const g = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
    this.gains.push(g)
    return g
  }
  async resume(): Promise<void> {
    if (this.resumeFails) throw new Error('blocked')
    this.state = 'running'
  }
  async suspend(): Promise<void> {
    this.suspended++
    this.state = 'suspended'
  }
  async close(): Promise<void> {
    this.closed = true
    this.state = 'closed'
  }
  setSinkId?: (id: string) => Promise<void> = async (id) => {
    this.sinkIds.push(id)
    if (this.sinkFails.has(id)) throw new Error('NotFoundError')
  }
}

const prefs = (patch: Partial<SoundPreferences> = {}): SoundPreferences => ({
  enabled: true,
  volume: 60,
  events: { ...DEFAULT_SOUND_EVENTS },
  ...patch
})
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

interface Setup {
  service: SoundService
  ctx: FakeContext
  timers: (() => void)[]
  contexts: FakeContext[]
  now: { t: number }
}

function setup(ctx = new FakeContext(), now = { t: 0 }): Setup {
  const timers: (() => void)[] = []
  const contexts: FakeContext[] = []
  const service = new SoundService({
    createContext: () => {
      contexts.push(ctx)
      return ctx
    },
    now: () => now.t,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => undefined
  })
  service.setPreferences(prefs())
  return { service, ctx, timers, contexts, now }
}

describe('SoundService playback', () => {
  it('plays through one shared context and caches rendered buffers', () => {
    const { service, ctx, contexts, now } = setup()
    expect(service.play('mute')).toBe('played')
    now.t = 1000
    expect(service.play('mute')).toBe('played')
    expect(contexts).toHaveLength(1)
    expect(ctx.buffers).toBe(1)
    expect(ctx.sources).toHaveLength(2)
    expect(ctx.sources[0]!.startedAt).toBe(10)
  })

  it('applies the master volume on a perceptual curve', () => {
    const { service, ctx } = setup()
    service.play('mute')
    expect(ctx.gains[0]!.gain.value).toBeCloseTo(volumeToGain(60))
    service.setPreferences(prefs({ volume: 25 }))
    expect(ctx.gains[0]!.gain.value).toBeCloseTo(0.0625)
    expect(volumeToGain(0)).toBe(0)
    expect(volumeToGain(100)).toBe(1)
    expect(volumeToGain(150)).toBe(1)
  })

  it('global mute, volume 0 and per-event toggles produce no sound', () => {
    const { service, ctx } = setup()
    service.setPreferences(prefs({ enabled: false }))
    expect(service.play('message')).toBe('skipped')
    expect(service.preview('message')).toBe('skipped')
    service.setPreferences(prefs({ volume: 0 }))
    expect(service.play('message')).toBe('skipped')
    service.setPreferences(prefs({ events: { ...DEFAULT_SOUND_EVENTS, voiceJoin: false } }))
    expect(service.play('voiceJoin')).toBe('skipped')
    expect(ctx.sources).toHaveLength(0)
  })

  it('previews ignore the event toggle (but not the global switch) and are never rate limited', () => {
    const { service, ctx } = setup()
    service.setPreferences(prefs({ events: { ...DEFAULT_SOUND_EVENTS, message: false } }))
    expect(service.preview('message')).toBe('played')
    expect(service.preview('message')).toBe('played')
    expect(ctx.sources).toHaveLength(2)
  })

  it('turning sounds off stops anything still playing', () => {
    const { service, ctx } = setup()
    service.play('connect')
    service.setPreferences(prefs({ enabled: false }))
    expect(ctx.sources[0]!.stopped).toBe(true)
  })

  it('schedules queued mentions on the audio clock instead of dropping them', () => {
    const { service, ctx } = setup()
    expect(service.play('mention')).toBe('played')
    expect(service.play('mention')).toBe('played')
    expect(ctx.sources[1]!.startedAt).toBeCloseTo(10.35)
  })
})

describe('SoundService reliability', () => {
  it('reports blocked audio as unavailable (caller falls back) and recovers after a gesture', async () => {
    const ctx = new FakeContext('suspended')
    ctx.resumeFails = true
    const { service } = setup(ctx)
    expect(service.play('message')).toBe('unavailable')
    expect(ctx.sources).toHaveLength(0)
    ctx.resumeFails = false
    service.unlock()
    await flush()
    expect(ctx.state).toBe('running')
    expect(service.preview('message')).toBe('played')
  })

  it('a context that cannot be created reports unavailable without retrying on every event', () => {
    let attempts = 0
    const service = new SoundService({
      createContext: () => {
        attempts++
        throw new Error('no audio device')
      }
    })
    expect(service.play('message')).toBe('unavailable')
    expect(service.preview('mute')).toBe('unavailable')
    expect(attempts).toBe(1)
  })

  it('follows the selected output device and falls back to the default when it fails', async () => {
    const ctx = new FakeContext()
    ctx.sinkFails.add('usb-headset')
    const { service } = setup(ctx)
    service.setOutputDevice('usb-headset')
    service.play('mute')
    await flush()
    expect(ctx.sinkIds).toEqual(['usb-headset', ''])
    expect(service.deviceFallback).toBe(true)
    service.setOutputDevice('speakers')
    await flush()
    expect(ctx.sinkIds.at(-1)).toBe('speakers')
    expect(service.deviceFallback).toBe(false)
  })

  it('without setSinkId support, a selected device is reported as a fallback', async () => {
    const ctx = new FakeContext('running', false)
    const { service } = setup(ctx)
    service.setOutputDevice('usb-headset')
    expect(service.play('mute')).toBe('played')
    await flush()
    expect(service.deviceFallback).toBe(true)
  })

  it('suspends when idle and resumes for the next sound', async () => {
    const { service, ctx, timers, now } = setup()
    service.play('mute')
    ctx.sources[0]!.end()
    expect(timers).toHaveLength(1)
    timers[0]!()
    await flush()
    expect(ctx.suspended).toBe(1)
    now.t = 5000
    expect(service.play('unmute')).toBe('played')
    await flush()
    expect(ctx.state).toBe('running')
    expect(ctx.sources).toHaveLength(2)
  })

  it('limits simultaneous sounds', () => {
    const { service, ctx } = setup()
    const results = Array.from({ length: 8 }, () => service.preview('mute'))
    expect(results.filter((r) => r === 'played')).toHaveLength(6)
    expect(ctx.sources).toHaveLength(6)
  })

  it('dispose releases the device and the service can be used again (sign-in after sign-out)', async () => {
    const first = new FakeContext()
    const second = new FakeContext()
    const queue = [first, second]
    const service = new SoundService({ createContext: () => queue.shift()! })
    service.setPreferences(prefs())
    service.play('connect')
    service.dispose()
    await flush()
    expect(first.closed).toBe(true)
    expect(first.sources[0]!.stopped).toBe(true)
    expect(service.preview('connect')).toBe('played')
    expect(second.sources).toHaveLength(1)
  })
})
