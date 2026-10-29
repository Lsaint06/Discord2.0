/**
 * Milestone 14: the bundled sound packs. These tests read the real WAV files and manifest, so a
 * missing, silent, clipped, too loud or tampered file fails the build.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SOUND_EVENTS } from './sounds'
import {
  DEFAULT_SOUND_PACK,
  packFileCount,
  packSoundUrl,
  SOUND_PACKS,
  soundPackById
} from './packs'
import { DEFAULT_SOUND_EVENTS, migrateSoundSettings, type SoundPreferences } from './soundPolicy'
import {
  SoundService,
  type AudioBufferLike,
  type AudioContextLike,
  type BufferSourceLike
} from './SoundService'

const DIR = join(__dirname, '..', 'assets', 'sounds')
interface FileInfo {
  file: string
  class: 'alert' | 'standard' | 'control'
  bytes: number
  sha256: string
  durationMs: number
  peakDbfs: number
  truePeakDbfsApprox: number
  momentaryMaxLufs: number
  dcOffset: number
  leadingSilenceMs: number
  trailingSilenceMs: number
  clippedSamples: number
  edgeSamples: [number, number]
}
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as {
  license: string
  format: { sampleRate: number; channels: number }
  loudnessTargetsLufs: Record<FileInfo['class'], number>
  packs: Record<string, Record<string, FileInfo>>
}

describe('sound packs: bundled files', () => {
  it('six complete packs, every event in every pack, Signature by default', () => {
    expect(SOUND_PACKS.map((p) => p.id)).toEqual([
      'signature',
      'classic',
      'minimal',
      'cyber',
      'cozy',
      'arcade'
    ])
    expect(DEFAULT_SOUND_PACK).toBe('signature')
    for (const pack of SOUND_PACKS) {
      expect(packFileCount(pack.id), pack.id).toBe(SOUND_EVENTS.length)
      for (const event of SOUND_EVENTS) {
        expect(packSoundUrl(pack.id, event), `${pack.id}/${event}`).toBeTruthy()
        expect(manifest.packs[pack.id]?.[event], `${pack.id}/${event} in manifest`).toBeTruthy()
      }
    }
    expect(packSoundUrl('nope', 'message')).toBeNull()
    expect(soundPackById('removed-pack').id).toBe('signature')
  })

  it('no stray or unlisted files in the sounds folder', () => {
    const listed = new Set(
      Object.values(manifest.packs).flatMap((p) => Object.values(p).map((f) => f.file))
    )
    for (const pack of readdirSync(DIR)) {
      const path = join(DIR, pack)
      if (!statSync(path).isDirectory()) {
        expect(['manifest.json', 'LICENSE.md']).toContain(pack)
        continue
      }
      for (const name of readdirSync(path))
        expect(listed.has(`${pack}/${name}`), `${pack}/${name}`).toBe(true)
    }
  })

  it('every file is a 48 kHz mono 16-bit WAV whose hash matches the manifest', () => {
    for (const pack of Object.values(manifest.packs)) {
      for (const info of Object.values(pack)) {
        const bytes = readFileSync(join(DIR, info.file))
        expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
        expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE')
        expect(bytes.readUInt16LE(20)).toBe(1) // PCM
        expect(bytes.readUInt16LE(22)).toBe(1) // mono
        expect(bytes.readUInt32LE(24)).toBe(48000)
        expect(bytes.readUInt16LE(34)).toBe(16)
        expect(bytes.length).toBe(info.bytes)
        expect(createHash('sha256').update(bytes).digest('hex'), info.file).toBe(info.sha256)
      }
    }
  })

  it('objective QA: loudness on target, headroom, no clipping, no clicks, no dead air', () => {
    for (const [packId, pack] of Object.entries(manifest.packs)) {
      for (const [event, f] of Object.entries(pack)) {
        const where = `${packId}/${event}`
        const target = manifest.loudnessTargetsLufs[f.class]
        // Minimal and Arcade are deliberately up to 2 LU quieter.
        expect(f.momentaryMaxLufs, where).toBeLessThanOrEqual(target + 1)
        expect(f.momentaryMaxLufs, where).toBeGreaterThanOrEqual(target - 3)
        expect(f.peakDbfs, where).toBeLessThanOrEqual(-1.5)
        expect(f.truePeakDbfsApprox, where).toBeLessThanOrEqual(-1)
        expect(f.clippedSamples, where).toBe(0)
        expect(Math.abs(f.dcOffset), where).toBeLessThan(0.002)
        expect(f.edgeSamples, where).toEqual([0, 0])
        expect(f.leadingSilenceMs, where).toBeLessThanOrEqual(30)
        expect(f.trailingSilenceMs, where).toBeLessThanOrEqual(25)
        expect(f.durationMs, where).toBeGreaterThanOrEqual(40)
        expect(f.durationMs, where).toBeLessThanOrEqual(2000)
      }
    }
  })

  it('alerts are louder than standard sounds, which are louder than controls', () => {
    const t = manifest.loudnessTargetsLufs
    expect(t.alert).toBeGreaterThan(t.standard)
    expect(t.standard).toBeGreaterThan(t.control)
  })

  it('every sound in a pack is different, and packs sound different from each other', () => {
    for (const pack of Object.values(manifest.packs)) {
      const hashes = Object.values(pack).map((f) => f.sha256)
      expect(new Set(hashes).size).toBe(hashes.length)
    }
    const all = Object.values(manifest.packs).flatMap((p) => Object.values(p).map((f) => f.sha256))
    expect(new Set(all).size).toBe(all.length)
  })

  it('the whole library stays small (under 10 MB) and is original work', () => {
    const total = Object.values(manifest.packs)
      .flatMap((p) => Object.values(p))
      .reduce((sum, f) => sum + f.bytes, 0)
    expect(total).toBeLessThan(10 * 1024 * 1024)
    expect(manifest.license).toMatch(/Original work/)
  })
})

// ---- Playback from pack files ----

class Source implements BufferSourceLike {
  buffer: AudioBufferLike | null = null
  onended: (() => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
}

function context(decode: (data: ArrayBuffer) => Promise<AudioBufferLike>): AudioContextLike & {
  sources: Source[]
  rendered: number
} {
  const ctx = {
    state: 'running',
    sampleRate: 48000,
    currentTime: 0,
    destination: {},
    sources: [] as Source[],
    rendered: 0,
    createBuffer: () => {
      ctx.rendered++
      return { copyToChannel: () => undefined }
    },
    createBufferSource: () => {
      const s = new Source()
      ctx.sources.push(s)
      return s
    },
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
    resume: async () => undefined,
    suspend: async () => undefined,
    close: async () => undefined,
    decodeAudioData: decode
  }
  return ctx
}

const prefs = (patch: Partial<SoundPreferences> = {}): SoundPreferences => ({
  enabled: true,
  volume: 60,
  events: { ...DEFAULT_SOUND_EVENTS },
  ...patch
})
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('sound packs: playback', () => {
  it('plays the selected pack’s file (decoded once), not the fallback recipe', async () => {
    const decoded: AudioBufferLike = { copyToChannel: () => undefined }
    const decode = vi.fn(async () => decoded)
    const ctx = context(decode)
    const loads: string[] = []
    const service = new SoundService({
      createContext: () => ctx,
      urlFor: (pack, event) => `/sounds/${pack}/${event}.wav`,
      loadAsset: async (url) => {
        loads.push(url)
        return new ArrayBuffer(8)
      }
    })
    service.setPreferences(prefs({ pack: 'cozy' }))
    expect(service.play('message')).toBe('played')
    await flush()
    expect(loads).toEqual(['/sounds/cozy/message.wav'])
    expect(ctx.sources[0]?.buffer).toBe(decoded)
    expect(ctx.rendered).toBe(0)
    // Second time: straight from the cache.
    service.play('mention')
    await flush()
    vi.useFakeTimers()
    vi.advanceTimersByTime(2000)
    vi.useRealTimers()
    service.play('message')
    await flush()
    expect(loads.filter((u) => u.endsWith('/message.wav'))).toHaveLength(1)
    expect(decode).toHaveBeenCalledTimes(2)
  })

  it('a file that can’t be loaded falls back to the built-in recipe (never silent)', async () => {
    const ctx = context(async () => {
      throw new Error('corrupt')
    })
    const service = new SoundService({
      createContext: () => ctx,
      urlFor: () => '/broken.wav',
      loadAsset: async () => new ArrayBuffer(4)
    })
    service.setPreferences(prefs())
    expect(service.play('connect')).toBe('played')
    await flush()
    expect(ctx.rendered).toBe(1)
    expect(ctx.sources).toHaveLength(1)
  })

  it('previewing another pack plays that pack and leaves your choice alone', async () => {
    const ctx = context(async () => ({ copyToChannel: () => undefined }))
    const loads: string[] = []
    const service = new SoundService({
      createContext: () => ctx,
      urlFor: (pack, event) => `/sounds/${pack}/${event}.wav`,
      loadAsset: async (url) => {
        loads.push(url)
        return new ArrayBuffer(8)
      }
    })
    service.setPreferences(prefs({ pack: 'signature' }))
    service.preview('mention', 'arcade')
    await flush()
    service.play('message')
    await flush()
    expect(loads).toEqual(['/sounds/arcade/mention.wav', '/sounds/signature/message.wav'])
  })

  it('your imported sound still replaces the pack’s sound for its event', async () => {
    const own: AudioBufferLike = { copyToChannel: () => undefined }
    const ctx = context(async () => own)
    const loads: string[] = []
    const service = new SoundService({
      createContext: () => ctx,
      urlFor: (pack, event) => `/sounds/${pack}/${event}.wav`,
      loadAsset: async (url) => {
        loads.push(url)
        return new ArrayBuffer(8)
      }
    })
    service.setCustomSound('11111111-1111-1111-1111-111111111111', {
      data: new ArrayBuffer(8),
      gain: 1
    })
    service.setPreferences(prefs({ custom: { mention: '11111111-1111-1111-1111-111111111111' } }))
    service.play('mention')
    await flush()
    expect(loads).toEqual([])
    expect(ctx.sources[0]?.buffer).toBe(own)
  })
})

describe('sound settings migration (Milestone 14 events)', () => {
  it('new events follow the choice you made for the event that used to cover them', () => {
    const migrated = migrateSoundSettings({
      soundEvents: { mention: false, streamStart: false, streamStop: true, connect: false }
    })
    expect(migrated.soundEvents.directMessage).toBe(false)
    expect(migrated.soundEvents.streamRemoteStart).toBe(false)
    expect(migrated.soundEvents.streamRemoteStop).toBe(true)
    expect(migrated.soundEvents.reconnect).toBe(false)
    // Push-to-talk cues are off unless you turn them on.
    expect(migrated.soundEvents.pttOn).toBe(false)
    expect(migrated.soundEvents.pttOff).toBe(false)
  })

  it('a value you set for a new event is kept; the old "no notification sounds" silences DMs too', () => {
    expect(
      migrateSoundSettings({ soundEvents: { mention: false, directMessage: true } }).soundEvents
        .directMessage
    ).toBe(true)
    const legacy = migrateSoundSettings({ notificationSounds: false })
    expect(legacy.soundEvents.directMessage).toBe(false)
    expect(legacy.soundEvents.message).toBe(false)
  })
})
