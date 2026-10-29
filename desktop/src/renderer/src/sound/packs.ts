/**
 * Milestone 14: built-in sound packs. Every file is original audio rendered offline by
 * desktop/scripts/sounds/render-sounds.mjs (procedural synthesis, no samples) and bundled with
 * the app — nothing is fetched from the internet. assets/sounds/manifest.json records each
 * file's loudness, peaks, duration and SHA-256.
 */
import type { SoundEvent } from './sounds'

export type SoundPackId = 'signature' | 'classic' | 'minimal' | 'cyber' | 'cozy' | 'arcade'

export interface SoundPackInfo {
  id: SoundPackId
  name: string
  description: string
  /** Every event has a file in this pack. */
  complete: boolean
}

export const SOUND_PACKS: readonly SoundPackInfo[] = [
  {
    id: 'signature',
    name: 'Signature',
    description: 'Discord 2.0’s own sound: glassy bells with a soft room. The default.',
    complete: true
  },
  {
    id: 'classic',
    name: 'Classic',
    description: 'Clean, familiar communication blips. Dry and to the point.',
    complete: true
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Short, quiet sine ticks for people who want to know, not hear.',
    complete: true
  },
  {
    id: 'cyber',
    name: 'Cyber',
    description: 'Resonant synth plucks with a digital echo.',
    complete: true
  },
  {
    id: 'cozy',
    name: 'Cozy',
    description: 'Warm kalimba tines and plucked strings.',
    complete: true
  },
  {
    id: 'arcade',
    name: 'Arcade',
    description: 'Crisp 8-bit chiptune blips.',
    complete: true
  }
]

export const DEFAULT_SOUND_PACK: SoundPackId = 'signature'

export function soundPackById(id: unknown): SoundPackInfo {
  return SOUND_PACKS.find((p) => p.id === id) ?? SOUND_PACKS[0]!
}

// Vite turns each file into a bundled asset URL (hashed in production builds).
const FILES = import.meta.glob('../assets/sounds/*/*.wav', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

const URLS = new Map<string, string>()
for (const [path, url] of Object.entries(FILES)) {
  const match = /sounds\/([a-z]+)\/([A-Za-z]+)\.wav$/.exec(path)
  if (match) URLS.set(`${match[1]}/${match[2]}`, url)
}

/** URL of a pack's file for an event, or null (then the built-in fallback recipe plays). */
export function packSoundUrl(pack: string, event: SoundEvent): string | null {
  return URLS.get(`${pack}/${event}`) ?? null
}

/** How many bundled files each pack has (for tests and diagnostics). */
export function packFileCount(pack: string): number {
  let n = 0
  for (const key of URLS.keys()) if (key.startsWith(`${pack}/`)) n++
  return n
}
