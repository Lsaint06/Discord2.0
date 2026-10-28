/**
 * The single place that plays sound effects. Components never create audio themselves.
 *
 * - One AudioContext, created lazily, separate from LiveKit's voice audio (which it never
 *   touches). It suspends itself after a few seconds of silence so the device isn't kept busy.
 * - Each sound is rendered once per sample rate (sounds.ts) and cached as an AudioBuffer.
 * - Follows the selected output device (AudioContext.setSinkId); falls back to the default
 *   device if that fails or isn't supported.
 * - If audio is blocked (no user gesture yet) play() reports 'unavailable' so the caller can
 *   fall back (e.g. let Windows play its notification sound); the next gesture unlocks audio.
 */
import type { SoundEvent } from './sounds'
import { RECIPES, renderRecipe } from './sounds'
import {
  eventEnabled,
  eventGain,
  SoundGate,
  type SoundPreferences,
  DEFAULT_SOUND_EVENTS,
  DEFAULT_SOUND_VOLUME
} from './soundPolicy'

// Minimal structural types so tests can provide a fake context.
export interface AudioBufferLike {
  copyToChannel: (source: Float32Array, channel: number) => void
}
export interface AudioNodeLike {
  connect: (destination: unknown) => unknown
  disconnect: () => void
}
export interface GainNodeLike extends AudioNodeLike {
  gain: { value: number; setValueAtTime?: (value: number, time: number) => void }
}
export interface BufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null
  start: (when?: number) => void
  stop: (when?: number) => void
  onended: (() => void) | null
}
export interface AudioContextLike {
  readonly state: string
  readonly sampleRate: number
  readonly currentTime: number
  readonly destination: unknown
  createBuffer: (channels: number, length: number, sampleRate: number) => AudioBufferLike
  createBufferSource: () => BufferSourceLike
  createGain: () => GainNodeLike
  resume: () => Promise<void>
  suspend: () => Promise<void>
  close: () => Promise<void>
  setSinkId?: (sinkId: string) => Promise<void>
  /** Needed for your own (imported) sounds. */
  decodeAudioData?: (data: ArrayBuffer) => Promise<AudioBufferLike>
}

export type PlayResult =
  /** Started (or scheduled to start shortly). */
  | 'played'
  /** Deliberately not played: off, coalesced into a recent sound, or too many at once. */
  | 'skipped'
  /** Wanted, but audio can't play right now (blocked or failed): the caller may fall back. */
  | 'unavailable'

interface Options {
  createContext?: () => AudioContextLike
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Suspend the context after this long without sound. */
  idleSuspendMs?: number
}

const MAX_VOICES = 6

/** Perceptual volume curve: 0–100 % → linear gain. */
export function volumeToGain(percent: number): number {
  const v = Math.min(100, Math.max(0, percent)) / 100
  return v * v
}

export class SoundService {
  private context: AudioContextLike | null = null
  private master: GainNodeLike | null = null
  private everRan = false
  private failed = false
  private readonly buffers = new Map<SoundEvent, AudioBufferLike>()
  /** Imported sounds: raw file bytes and their loudness-matching gain (customSounds.ts). */
  private readonly customData = new Map<string, { data: ArrayBuffer; gain: number }>()
  /** Decoded imported sounds for the current context (null = couldn't be decoded). */
  private readonly customBuffers = new Map<string, Promise<AudioBufferLike | null>>()
  private readonly active = new Set<BufferSourceLike>()
  private readonly gate = new SoundGate()
  private idleTimer: unknown = null
  private sinkId = ''
  /** The selected output device couldn't be used; sound goes to the default device. */
  deviceFallback = false
  private prefs: SoundPreferences = {
    enabled: true,
    volume: DEFAULT_SOUND_VOLUME,
    events: { ...DEFAULT_SOUND_EVENTS }
  }
  private readonly createContext: () => AudioContextLike
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly idleSuspendMs: number

  constructor(options: Options = {}) {
    this.createContext =
      options.createContext ??
      (() => new AudioContext({ latencyHint: 'interactive' }) as unknown as AudioContextLike)
    this.now = options.now ?? (() => performance.now())
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer =
      options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.idleSuspendMs = options.idleSuspendMs ?? 8000
  }

  setPreferences(prefs: SoundPreferences): void {
    this.prefs = prefs
    if (this.master) this.master.gain.value = volumeToGain(prefs.volume)
    if (!prefs.enabled) this.stopAll()
  }

  /** '' = system default. Applied now if audio is running, otherwise when it starts. */
  setOutputDevice(deviceId: string): void {
    if (deviceId === this.sinkId) return
    this.sinkId = deviceId
    this.deviceFallback = false
    if (this.context) void this.applySink(this.context)
  }

  /** Call from a user gesture: creates/resumes audio so later sounds aren't blocked. */
  unlock(): void {
    const ctx = this.ensureContext()
    if (ctx && ctx.state === 'suspended') void this.resume(ctx)
  }

  /** Plays an event if the preferences allow it (and it isn't part of a burst). */
  play(event: SoundEvent): PlayResult {
    if (!eventEnabled(this.prefs, event)) return 'skipped'
    return this.start(event, true)
  }

  /** Auditions a sound from Settings: ignores the event toggle, but not the global switch. */
  preview(event: SoundEvent): PlayResult {
    if (!this.prefs.enabled || this.prefs.volume <= 0) return 'skipped'
    return this.start(event, false)
  }

  /** Registers (or, with null, forgets) one of your own sounds by its library id. */
  setCustomSound(id: string, sound: { data: ArrayBuffer; gain: number } | null): void {
    this.customBuffers.delete(id)
    if (sound) this.customData.set(id, sound)
    else this.customData.delete(id)
  }

  /** Auditions one of your own sounds (from the library list), at the global volume. */
  previewCustom(id: string): PlayResult {
    if (!this.prefs.enabled || this.prefs.volume <= 0) return 'skipped'
    if (!this.customData.has(id)) return 'unavailable'
    return this.start(null, false, id)
  }

  /** Releases the audio device and cached buffers (sign-out, window close). Reusable later. */
  dispose(): void {
    this.stopAll()
    if (this.idleTimer !== null) this.clearTimer(this.idleTimer)
    this.idleTimer = null
    const ctx = this.context
    this.context = null
    this.master = null
    this.buffers.clear()
    this.customBuffers.clear()
    this.everRan = false
    this.failed = false
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
  }

  /**
   * `event` null = a library preview of `customId`. Imported sounds play through their own
   * loudness gain × the event's category/event volume; built-in ones through the volume only.
   */
  private start(event: SoundEvent | null, gated: boolean, previewId?: string): PlayResult {
    let delayMs = 0
    if (gated && event) {
      const decision = this.gate.admit(event, this.now())
      if (!decision.play) return 'skipped'
      delayMs = decision.delayMs
    }
    if (this.active.size >= MAX_VOICES) return 'skipped'
    const ctx = this.ensureContext()
    if (!ctx) return 'unavailable'

    const customId = previewId ?? (event ? this.prefs.custom?.[event] : undefined)
    const play = (): boolean => this.playVoice(ctx, event, customId, delayMs)

    if (ctx.state === 'running') {
      return play() ? 'played' : 'unavailable'
    }
    if (ctx.state === 'suspended' && this.everRan) {
      // We suspended it ourselves while idle: resume and play right after.
      void this.resume(ctx).then((ok) => {
        if (ok) play()
      })
      return 'played'
    }
    // Never ran: autoplay is blocked until a user gesture. Try, but report it unavailable.
    void this.resume(ctx)
    return 'unavailable'
  }

  /** Schedules one voice; imported sounds are decoded first (then cached for this context). */
  private playVoice(
    ctx: AudioContextLike,
    event: SoundEvent | null,
    customId: string | undefined,
    delayMs: number
  ): boolean {
    const volume = event ? eventGain(this.prefs, event) : 1
    const custom = customId ? this.customData.get(customId) : undefined
    if (custom && customId && typeof ctx.decodeAudioData === 'function') {
      void this.customBuffer(ctx, customId).then((buffer) => {
        if (buffer) this.schedule(ctx, buffer, volume * custom.gain, delayMs)
        // A file that no longer decodes falls back to the built-in sound.
        else if (event) this.schedule(ctx, this.bufferFor(ctx, event), volume, delayMs)
      })
      return true
    }
    if (!event) return false
    return this.schedule(ctx, this.bufferFor(ctx, event), volume, delayMs)
  }

  private customBuffer(ctx: AudioContextLike, id: string): Promise<AudioBufferLike | null> {
    let pending = this.customBuffers.get(id)
    if (!pending) {
      const source = this.customData.get(id)
      pending =
        source && ctx.decodeAudioData
          ? ctx.decodeAudioData(source.data.slice(0)).catch(() => null)
          : Promise.resolve(null)
      this.customBuffers.set(id, pending)
    }
    return pending
  }

  private ensureContext(): AudioContextLike | null {
    if (this.context && this.context.state !== 'closed') return this.context
    if (this.failed) return null
    try {
      const ctx = this.createContext()
      const master = ctx.createGain()
      master.gain.value = volumeToGain(this.prefs.volume)
      master.connect(ctx.destination)
      this.context = ctx
      this.master = master
      this.buffers.clear()
      this.customBuffers.clear()
      if (ctx.state === 'running') this.everRan = true
      if (this.sinkId) void this.applySink(ctx)
      return ctx
    } catch {
      // No audio support at all (or the device is gone); don't retry on every message.
      this.failed = true
      return null
    }
  }

  private async resume(ctx: AudioContextLike): Promise<boolean> {
    try {
      await ctx.resume()
    } catch {
      return false
    }
    if (ctx.state === 'running') this.everRan = true
    return ctx.state === 'running'
  }

  private async applySink(ctx: AudioContextLike): Promise<void> {
    if (typeof ctx.setSinkId !== 'function') {
      this.deviceFallback = this.sinkId !== ''
      return
    }
    const wanted = this.sinkId
    try {
      await ctx.setSinkId(wanted)
      this.deviceFallback = false
    } catch {
      // Unplugged or not allowed: use the default device rather than going silent.
      this.deviceFallback = wanted !== ''
      await ctx.setSinkId('').catch(() => undefined)
    }
  }

  private bufferFor(ctx: AudioContextLike, event: SoundEvent): AudioBufferLike {
    let buffer = this.buffers.get(event)
    if (!buffer) {
      const samples = renderRecipe(RECIPES[event], ctx.sampleRate)
      buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
      buffer.copyToChannel(samples, 0)
      this.buffers.set(event, buffer)
    }
    return buffer
  }

  private schedule(
    ctx: AudioContextLike,
    buffer: AudioBufferLike,
    volume: number,
    delayMs: number
  ): boolean {
    const master = this.master
    if (!master || ctx !== this.context) return false
    try {
      const source = ctx.createBufferSource()
      source.buffer = buffer
      // Category / event volume (and an imported file's loudness match) for this voice only.
      let output: AudioNodeLike = master
      let voiceGain: GainNodeLike | null = null
      if (volume !== 1) {
        voiceGain = ctx.createGain()
        voiceGain.gain.value = Math.max(0, volume)
        voiceGain.connect(master)
        output = voiceGain
      }
      source.connect(output)
      this.active.add(source)
      source.onended = () => {
        this.active.delete(source)
        source.disconnect()
        voiceGain?.disconnect()
        this.armIdleSuspend()
      }
      source.start(ctx.currentTime + delayMs / 1000)
      if (this.idleTimer !== null) this.clearTimer(this.idleTimer)
      this.idleTimer = null
      return true
    } catch {
      return false
    }
  }

  private armIdleSuspend(): void {
    if (this.active.size > 0) return
    if (this.idleTimer !== null) this.clearTimer(this.idleTimer)
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null
      const ctx = this.context
      if (ctx && ctx.state === 'running' && this.active.size === 0)
        void ctx.suspend().catch(() => undefined)
    }, this.idleSuspendMs)
  }

  private stopAll(): void {
    for (const source of this.active) {
      try {
        source.onended = null
        source.stop()
        source.disconnect()
      } catch {
        // Already stopped.
      }
    }
    this.active.clear()
  }
}
