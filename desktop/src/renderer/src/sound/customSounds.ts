/**
 * Your own sound effects (Settings → Sounds → Your sounds). Kept on this PC only, in IndexedDB
 * (never uploaded). Every file is checked before it's kept:
 *   - the bytes really are WAV, MP3 or OGG (by their signature, not the file name);
 *   - at most CUSTOM_SOUND_MAX_BYTES, and at most MAX_CUSTOM_SOUNDS files in total;
 *   - it decodes as audio, lasts at most CUSTOM_SOUND_MAX_SECONDS and isn't silent;
 *   - its loudness is measured once, so it plays at the same level as the built-in sounds.
 */
import { PEAK_LIMIT, TARGET_RMS, audibleRms, peakOf } from './sounds'

export const CUSTOM_SOUND_MAX_BYTES = 1024 * 1024
export const CUSTOM_SOUND_MAX_SECONDS = 5
export const MAX_CUSTOM_SOUNDS = 20
export const CUSTOM_SOUND_ACCEPT = '.wav,.mp3,.ogg,audio/wav,audio/mpeg,audio/ogg'

export type CustomSoundFormat = 'wav' | 'mp3' | 'ogg'

export interface CustomSoundMeta {
  id: string
  name: string
  format: CustomSoundFormat
  size: number
  durationMs: number
  /** Linear gain that brings it to the built-in sounds' loudness (≤ 1 for loud files). */
  gain: number
  createdAt: number
}

const ascii = (bytes: Uint8Array, start: number, text: string): boolean =>
  [...text].every((ch, i) => bytes[start + i] === ch.charCodeAt(0))

/** The audio format from the file's first bytes, or null. */
export function sniffAudioFormat(bytes: Uint8Array): CustomSoundFormat | null {
  if (bytes.length < 12) return null
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) return 'wav'
  if (ascii(bytes, 0, 'OggS')) return 'ogg'
  if (ascii(bytes, 0, 'ID3')) return 'mp3'
  // MPEG audio frame sync (11 bits set) with a valid layer.
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) !== 0) return 'mp3'
  return null
}

/** A safe display name from a file name ("My Sound.wav" → "My Sound"). */
export function soundNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^.]{1,5}$/, '')
  const clean = base
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  return clean || 'Custom sound'
}

/** Checks done before decoding. Returns a user-facing problem, or the detected format. */
export function checkImport(
  file: { name: string; size: number },
  bytes: Uint8Array,
  existingCount: number
): { ok: true; format: CustomSoundFormat } | { ok: false; error: string } {
  if (existingCount >= MAX_CUSTOM_SOUNDS) {
    return { ok: false, error: `You can keep up to ${MAX_CUSTOM_SOUNDS} sounds. Delete one first.` }
  }
  if (file.size === 0) return { ok: false, error: 'That file is empty.' }
  if (file.size > CUSTOM_SOUND_MAX_BYTES) {
    return {
      ok: false,
      error: 'That file is larger than 1 MB. Sound effects should be short clips.'
    }
  }
  const format = sniffAudioFormat(bytes)
  if (!format) return { ok: false, error: 'Only WAV, MP3 and OGG audio files can be used.' }
  return { ok: true, format }
}

/** Checks done after decoding. */
export function checkDecoded(durationSeconds: number, samples: Float32Array): string | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 'That file has no audio.'
  if (durationSeconds > CUSTOM_SOUND_MAX_SECONDS + 0.05) {
    return `That sound is ${durationSeconds.toFixed(1)} seconds long. Use a clip of ${CUSTOM_SOUND_MAX_SECONDS} seconds or less.`
  }
  if (peakOf(samples) < 0.001) return 'That sound is silent.'
  return null
}

/**
 * Gain that matches the built-in sounds' loudness, never boosting quiet files by more than 4×
 * and never letting the peak exceed the built-ins' limit.
 */
export function normalizationGain(samples: Float32Array): number {
  const rms = audibleRms(samples)
  const peak = peakOf(samples)
  if (rms <= 0 || peak <= 0) return 1
  return Math.min(TARGET_RMS / rms, PEAK_LIMIT / peak, 4)
}

// ---- Storage (IndexedDB) ----

const DB_NAME = 'd2-custom-sounds'
const STORE = 'sounds'

interface Row {
  meta: CustomSoundMeta
  data: ArrayBuffer
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'meta.id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const request = fn(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(request.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

export async function listCustomSounds(): Promise<CustomSoundMeta[]> {
  const rows = await withStore<Row[]>('readonly', (s) => s.getAll() as IDBRequest<Row[]>)
  return rows.map((r) => r.meta).sort((a, b) => a.createdAt - b.createdAt)
}

export async function loadCustomSoundData(id: string): Promise<ArrayBuffer | null> {
  const row = await withStore<Row | undefined>(
    'readonly',
    (s) => s.get(id) as IDBRequest<Row | undefined>
  )
  return row?.data ?? null
}

export async function saveCustomSound(meta: CustomSoundMeta, data: ArrayBuffer): Promise<void> {
  await withStore('readwrite', (s) => s.put({ meta, data } satisfies Row))
}

export async function deleteCustomSound(id: string): Promise<void> {
  await withStore('readwrite', (s) => s.delete(id))
}

/**
 * Validates, decodes and stores a file. `decode` turns bytes into mono samples (an
 * OfflineAudioContext in the app; a stub in tests). Resolves to the stored sound or an error.
 */
export async function importCustomSound(
  file: File,
  existingCount: number,
  decode: (data: ArrayBuffer) => Promise<{ duration: number; samples: Float32Array }>,
  now = Date.now()
): Promise<{ ok: true; meta: CustomSoundMeta } | { ok: false; error: string }> {
  if (file.size > CUSTOM_SOUND_MAX_BYTES) {
    return checkImport(file, new Uint8Array(0), existingCount) as { ok: false; error: string }
  }
  const data = await file.arrayBuffer()
  const checked = checkImport(
    file,
    new Uint8Array(data, 0, Math.min(16, data.byteLength)),
    existingCount
  )
  if (!checked.ok) return checked
  let decoded: { duration: number; samples: Float32Array }
  try {
    // decodeAudioData detaches its input: decode a copy, store the original.
    decoded = await decode(data.slice(0))
  } catch {
    return {
      ok: false,
      error: 'That file couldn’t be played. It may be damaged or use an unusual codec.'
    }
  }
  const problem = checkDecoded(decoded.duration, decoded.samples)
  if (problem) return { ok: false, error: problem }
  const meta: CustomSoundMeta = {
    id: crypto.randomUUID(),
    name: soundNameFromFile(file.name),
    format: checked.format,
    size: file.size,
    durationMs: Math.round(decoded.duration * 1000),
    gain: normalizationGain(decoded.samples),
    createdAt: now
  }
  await saveCustomSound(meta, data)
  return { ok: true, meta }
}

/** Decodes with an OfflineAudioContext and mixes to mono (for checks and loudness). */
export async function decodeToMono(
  data: ArrayBuffer
): Promise<{ duration: number; samples: Float32Array }> {
  const ctx = new OfflineAudioContext(1, 1, 48_000)
  const buffer = await ctx.decodeAudioData(data)
  const mono = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c)
    for (let i = 0; i < mono.length; i++) {
      mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) / buffer.numberOfChannels
    }
  }
  return { duration: buffer.duration, samples: mono }
}
