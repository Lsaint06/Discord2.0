/**
 * Large-file uploads (Milestone 13): sends a file in chunks and survives network trouble —
 * after a failure it asks the server where the upload stands and continues from there, for
 * about two minutes before giving up. A later retry can continue the same server upload
 * (`resumeId`). Cancelling deletes the upload on the server.
 */
import type { ApiAttachment, ApiUploadSession } from '../net/protocol'

export interface LargeUploadApi {
  startLargeUpload(channelId: string, filename: string, size: number): Promise<ApiUploadSession>
  largeUploadStatus(id: string): Promise<ApiUploadSession>
  uploadChunk(
    id: string,
    offset: number,
    chunk: Blob,
    options: { onProgress?: (bytes: number) => void; signal?: AbortSignal }
  ): Promise<{ receivedBytes: number }>
  completeLargeUpload(id: string, timeoutMs?: number): Promise<ApiAttachment>
  cancelLargeUpload(id: string): Promise<void>
}

export interface LargeUploadOptions {
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /** Failed attempts in a row (network errors, timeouts, 5xx) before giving up. */
  maxAttempts?: number
  /** Waits between attempts (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>
  /** The server upload of an earlier, failed attempt to continue (Retry). */
  resumeId?: string
  /** Gets the server upload's id as soon as it exists, so a retry can continue it. */
  onSession?: (id: string) => void
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]
/** About two minutes of trying (1 + 2 + 4 + 8 + 7 × 15 s) before an upload fails. */
const DEFAULT_MAX_ATTEMPTS = 12
const MiB = 1024 * 1024

const retryDelay = (failures: number): number =>
  RETRY_DELAYS_MS[Math.min(failures - 1, RETRY_DELAYS_MS.length - 1)]!

/**
 * How long finishing may take: the server re-reads and hashes the whole file (assumes at
 * least 20 MB/s, with a one-minute minimum).
 */
export function completeTimeoutMs(size: number): number {
  return Math.max(60_000, Math.ceil(size / (20 * MiB)) * 1000)
}

export class LargeUploadAborted extends Error {
  constructor() {
    super('Upload cancelled')
    this.name = 'AbortError'
  }
}

const statusOf = (err: unknown): number | undefined =>
  (err as { status?: unknown } | null)?.status as number | undefined
const codeOf = (err: unknown): string | undefined =>
  (err as { code?: unknown } | null)?.code as string | undefined

/** Errors worth retrying: no answer, timeouts, server trouble, rate limits. */
function retryable(err: unknown): boolean {
  if ((err as { name?: string } | null)?.name === 'AbortError') return false
  const status = statusOf(err)
  return status === undefined || status === 0 || status === 429 || status >= 500
}

/** A wait that ends early when the upload is cancelled. */
function abortableSleep(signal?: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal?.addEventListener('abort', done, { once: true })
    })
}

/** The earlier attempt's server upload if it still fits this file, otherwise a new one. */
async function openSession(
  api: LargeUploadApi,
  channelId: string,
  file: Blob,
  filename: string,
  resumeId: string | undefined
): Promise<ApiUploadSession> {
  if (resumeId) {
    try {
      const previous = await api.largeUploadStatus(resumeId)
      if (previous.size === file.size && previous.channelId === channelId) return previous
      await api.cancelLargeUpload(previous.id).catch(() => undefined)
    } catch (err) {
      // Gone (finished, cancelled or cleaned up): start over. Other errors (offline…) surface.
      if (statusOf(err) !== 404) throw err
    }
  }
  return api.startLargeUpload(channelId, filename, file.size)
}

export async function uploadLargeFile(
  api: LargeUploadApi,
  channelId: string,
  file: Blob,
  filename: string,
  options: LargeUploadOptions = {}
): Promise<ApiAttachment> {
  const sleep = options.sleep ?? abortableSleep(options.signal)
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const aborted = (): boolean => options.signal?.aborted === true
  if (aborted()) throw new LargeUploadAborted()

  let session = await openSession(api, channelId, file, filename, options.resumeId)
  options.onSession?.(session.id)

  try {
    let offset = session.receivedBytes
    let failures = 0
    let resync = false
    for (;;) {
      if (aborted()) throw new LargeUploadAborted()
      try {
        if (resync) {
          // The server knows best where the upload stands (lost answer, restart, other tab).
          session = await api.largeUploadStatus(session.id)
          offset = session.receivedBytes
          resync = false
        }
        if (offset < session.size) {
          const start = offset
          const total = session.size
          const end = Math.min(total, start + session.chunkBytes)
          const result = await api.uploadChunk(session.id, start, file.slice(start, end), {
            signal: options.signal,
            onProgress: (bytes) => options.onProgress?.(Math.min(1, (start + bytes) / total))
          })
          offset = result.receivedBytes
          failures = 0
          options.onProgress?.(offset / total)
          continue
        }
        // Every byte has arrived. Finishing is safe to repeat: after a lost answer the next
        // attempt returns the same attachment.
        return await api.completeLargeUpload(session.id, completeTimeoutMs(session.size))
      } catch (err) {
        if (aborted()) throw new LargeUploadAborted()
        const status = statusOf(err)
        const code = codeOf(err)
        // An earlier finishing attempt is still hashing: wait for it.
        const busy = status === 409 && code === 'upload_finishing'
        // Out of step (wrong offset, bytes missing): ask the server, no need to wait.
        const outOfStep = status === 409 && !busy && code !== 'upload_lost'
        if (!busy && !outOfStep && !retryable(err)) throw err
        failures++
        if (failures >= maxAttempts) throw err
        if (!outOfStep) await sleep(retryDelay(failures))
        // While finishing, just try again: the upload may already be complete on the server,
        // and only finishing (not the status) can return its attachment.
        resync = outOfStep || (!busy && offset < session.size)
      }
    }
  } catch (err) {
    if (err instanceof LargeUploadAborted || aborted()) {
      await api.cancelLargeUpload(session.id).catch(() => undefined)
      throw new LargeUploadAborted()
    }
    throw err
  }
}

/** Whether a file needs the large-file path (bigger than a normal upload allows). */
export function needsLargeUpload(size: number, normalMaxBytes: number): boolean {
  return size > normalMaxBytes
}

/** Human text for when a large file will be deleted (or null if it is kept). */
export function expiryNote(size: number, threshold: number, ephemeralMs: number): string | null {
  if (size <= threshold) return null
  const hours = Math.round(ephemeralMs / 3_600_000)
  return `Files over ${Math.round(threshold / (1024 * 1024))} MB are deleted ${hours} hours after they finish uploading.`
}

/** Whether an attachment's file is gone (marked by the server, or its time is up). */
export function attachmentExpired(
  a: { expired?: boolean; expiresAt?: number },
  now = Date.now()
): boolean {
  return a.expired === true || (typeof a.expiresAt === 'number' && a.expiresAt <= now)
}

/** "Deleted in 23 h" / "Deleted in 12 min" for files that expire; null otherwise. */
export function expiryLabel(expiresAt: number | undefined, now = Date.now()): string | null {
  if (typeof expiresAt !== 'number' || expiresAt <= now) return null
  const minutes = Math.ceil((expiresAt - now) / 60_000)
  if (minutes < 60) return `Deleted in ${minutes} min`
  return `Deleted in ${Math.round(minutes / 60)} h`
}
