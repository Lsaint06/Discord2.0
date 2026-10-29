/**
 * The single place that plays sound effects. Components never create audio themselves.
 *
 * - One AudioContext, created lazily, separate from LiveKit's voice audio (which it never
 *   touches). It suspends itself after a few seconds of silence so the device isn't kept busy.
 * - Milestone 14: sounds come from the selected sound pack (bundled WAV files, packs.ts), each
 *   decoded once per audio context. If a file can't be loaded, the event's fallback recipe
 *   (sounds.ts) is rendered instead, so a sound is never silently lost.
 * - Follows the selected output device (AudioContext.setSinkId); falls back to the default
 *   device if that fails or isn't supported.
 * - If audio is blocked (no user gesture yet) play() reports 'unavailable' so the caller can
 *   fall back (e.g. let Windows play its notification sound); the next gesture unlocks audio.
 */
import type { SoundEvent } from './sounds'
import { RECIPES, renderRecipe } from './sounds'
import { DEFAULT_SOUND_PACK, packSoundUrl } from './packs'
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
  /** Where a pack's file for an event is (null = none: use the fallback recipe). */
  urlFor?: (pack: string, event: SoundEvent) => string | null
  /** Loads a bundled sound file. */
  loadAsset?: (url: string) => Promise<ArrayBuffer>
}

const MAX_VOICES = 6
const MAX_CLIPS = 32

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
  /** Decoded pack files for the current context, keyed pack/event (null = unusable). */
  private readonly packBuffers = new Map<string, Promise<AudioBufferLike | null>>()
  private readonly packReady = new Map<string, AudioBufferLike | null>()
  /** Decoded soundboard clips (Milestone 14), most recent last; at most MAX_CLIPS. */
  private readonly clips = new Map<string, Promise<AudioBufferLike | null>>()
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
  private readonly urlFor: (pack: string, event: SoundEvent) => string | null
  private readonly loadAsset: (url: string) => Promise<ArrayBuffer>

  constructor(options: Options = {}) {
    this.createContext =
      options.createContext ??
      (() => new AudioContext({ latencyHint: 'interactive' }) as unknown as AudioContextLike)
    this.now = options.now ?? (() => performance.now())
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer =
      options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.idleSuspendMs = options.idleSuspendMs ?? 8000
    this.urlFor = options.urlFor ?? packSoundUrl
    this.loadAsset =
      options.loadAsset ??
      (async (url) => {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`sound ${res.status}`)
        return res.arrayBuffer()
      })
  }

  /** The selected pack (unknown ids fall back to the default pack's files). */
  private pack(): string {
    return this.prefs.pack || DEFAULT_SOUND_PACK
  }

  setPreferences(prefs: SoundPreferences): void {
    const packChanged = (prefs.pack || DEFAULT_SOUND_PACK) !== this.pack()
    this.prefs = prefs
    if (packChanged && this.context && this.context.state === 'running') this.preload()
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
    if (ctx && this.packBuffers.size === 0) this.preload()
  }

  /** Plays an event if the preferences allow it (and it isn't part of a burst). */
  play(event: SoundEvent): PlayResult {
    if (!eventEnabled(this.prefs, event)) return 'skipped'
    return this.start(event, true)
  }

  /**
   * Auditions a sound from Settings: ignores the event toggle, but not the global switch.
   * pack previews another pack's sound without changing your choice.
   */
  preview(event: SoundEvent, pack?: string): PlayResult {
    if (!this.prefs.enabled || this.prefs.volume <= 0) return 'skipped'
    return this.start(event, false, undefined, pack)
  }

  /** Decodes the selected pack's files ahead of time (so the first sound has no delay). */
  preload(): void {
    const ctx = this.context
    if (!ctx || typeof ctx.decodeAudioData !== 'function') return
    for (const event of Object.keys(RECIPES) as SoundEvent[]) {
      const url = this.urlFor(this.pack(), event)
      if (url) void this.packBuffer(ctx, `${this.pack()}/${event}`, url)
    }
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

  /**
   * Milestone 14: a soundboard clip someone played in your voice channel (or your own preview).
   * It has its own volume and goes straight to the output: the sound-effects volume, event
   * toggles and burst rules don't apply (it isn't a notification).
   */
  playClip(id: string, load: () => Promise<ArrayBuffer>, volumePercent: number): PlayResult {
    if (volumePercent <= 0) return 'skipped'
    if (this.active.size >= MAX_VOICES) return 'skipped'
    const ctx = this.ensureContext()
    if (!ctx || typeof ctx.decodeAudioData !== 'function') return 'unavailable'
    let pending = this.clips.get(id)
    if (!pending) {
      pending = load()
        .then((data) => ctx.decodeAudioData!(data))
        .catch(() => null)
      this.clips.set(id, pending)
      while (this.clips.size > MAX_CLIPS) {
        const oldest = this.clips.keys().next().value
        if (oldest === undefined) break
        this.clips.delete(oldest)
      }
    }
    const gain = volumeToGain(volumePercent)
    const play = (): void => {
      void pending.then((buffer) => {
        if (buffer) this.schedule(ctx, buffer, gain, 0, true)
      })
    }
    if (ctx.state === 'running') {
      play()
      return 'played'
    }
    void this.resume(ctx).then((ok) => ok && play())
    return this.everRan ? 'played' : 'unavailable'
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
    this.packBuffers.clear()
    this.packReady.clear()
    this.clips.clear()
    this.everRan = false
    this.failed = false
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
  }

  /**
   * `event` null = a library preview of `customId`. Imported sounds play through their own
   * loudness gain × the event's category/event volume; built-in ones through the volume only.
   */
  private start(
    event: SoundEvent | null,
    gated: boolean,
    previewId?: string,
    pack?: string
  ): PlayResult {
    let delayMs = 0
    if (gated && event) {
      const decision = this.gate.admit(event, this.now())
      if (!decision.play) return 'skipped'
      delayMs = decision.delayMs
    }
    if (this.active.size >= MAX_VOICES) return 'skipped'
    const ctx = this.ensureContext()
    if (!ctx) return 'unavailable'

    // Previewing another pack plays that pack's sound, not your own replacement.
    const customId = previewId ?? (event && !pack ? this.prefs.custom?.[event] : undefined)
    const play = (): boolean => this.playVoice(ctx, event, customId, delayMs, pack)

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
    delayMs: number,
    pack?: string
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
    const packId = pack ?? this.pack()
    const url = this.urlFor(packId, event)
    if (url && typeof ctx.decodeAudioData === 'function') {
      const key = `${packId}/${event}`
      const ready = this.packReady.get(key)
      if (ready) return this.schedule(ctx, ready, volume, delayMs)
      if (ready === undefined) {
        void this.packBuffer(ctx, key, url).then((buffer) =>
          this.schedule(ctx, buffer ?? this.bufferFor(ctx, event), volume, delayMs)
        )
        return true
      }
      // The file couldn't be decoded before: the fallback recipe plays.
    }
    return this.schedule(ctx, this.bufferFor(ctx, event), volume, delayMs)
  }

  private packBuffer(
    ctx: AudioContextLike,
    key: string,
    url: string
  ): Promise<AudioBufferLike | null> {
    let pending = this.packBuffers.get(key)
    if (!pending) {
      pending = this.loadAsset(url)
        .then((data) => ctx.decodeAudioData!(data))
        .catch(() => null)
        .then((buffer) => {
          if (ctx === this.context) this.packReady.set(key, buffer)
          return buffer
        })
      this.packBuffers.set(key, pending)
    }
    return pending
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
      this.packBuffers.clear()
      this.packReady.clear()
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
    delayMs: number,
    /** Soundboard clips bypass the sound-effects master volume. */
    direct = false
  ): boolean {
    const master = this.master
    if (!master || ctx !== this.context) return false
    try {
      const source = ctx.createBufferSource()
      source.buffer = buffer
      // Category / event volume (and an imported file's loudness match) for this voice only.
      let output: AudioNodeLike = master
      let voiceGain: GainNodeLike | null = null
      if (volume !== 1 || direct) {
        voiceGain = ctx.createGain()
        voiceGain.gain.value = Math.max(0, volume)
        voiceGain.connect(direct ? ctx.destination : master)
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
