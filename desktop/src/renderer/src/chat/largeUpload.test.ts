import { describe, expect, it } from 'vitest'
import type { ApiAttachment, ApiUploadSession } from '../net/protocol'
import {
  LargeUploadAborted,
  attachmentExpired,
  completeTimeoutMs,
  expiryLabel,
  expiryNote,
  needsLargeUpload,
  uploadLargeFile,
  type LargeUploadApi
} from './largeUpload'

/** An in-memory server: chunks must arrive in order; failures can be scripted. */
interface FakeServer {
  api: LargeUploadApi
  stored: number[]
  calls: string[]
  failNext: { kind: 'network' | 'lost-answer' | 'server' | 'fatal' }[]
  /** Failures of the next status requests, in order. */
  statusFailures: ('network' | 'gone')[]
  /** Failures of the next finishing requests; 'lost-answer' completes but the answer is lost. */
  completeFailures: ('timeout' | 'finishing' | 'lost-answer' | 'lost')[]
  completeTimeouts: number[]
  wasCancelled: () => boolean
}

function fakeServer(chunkBytes = 4): FakeServer {
  let received = 0
  let size = 0
  let completed = false
  const stored: number[] = []
  const calls: string[] = []
  const failNext: FakeServer['failNext'] = []
  const statusFailures: FakeServer['statusFailures'] = []
  const completeFailures: FakeServer['completeFailures'] = []
  const completeTimeouts: number[] = []
  let cancelled = false
  const error = (status: number, code = 'x'): Error =>
    Object.assign(new Error(code), { status, code })
  const session = (): ApiUploadSession => ({
    id: 'u1',
    channelId: 'c1',
    filename: 'f.zip',
    size,
    receivedBytes: received,
    chunkBytes,
    expiresAfterMs: null
  })
  const attachment = (): ApiAttachment =>
    ({
      id: 'a1',
      filename: 'f.zip',
      contentType: 'application/zip',
      kind: 'file',
      size
    }) as ApiAttachment
  const api: LargeUploadApi = {
    async startLargeUpload(_c, _f, s) {
      size = s
      calls.push('start')
      return session()
    },
    async largeUploadStatus() {
      calls.push(`status@${received}`)
      const failure = statusFailures.shift()
      if (failure === 'network') throw error(0, 'network_error')
      if (failure === 'gone' || completed || cancelled) throw error(404, 'not_found')
      return session()
    },
    async uploadChunk(_id, offset, chunk, options) {
      calls.push(`chunk@${offset}`)
      const failure = failNext.shift()
      if (failure?.kind === 'network') throw Object.assign(new Error('net'), { status: 0 })
      if (failure?.kind === 'server') throw Object.assign(new Error('boom'), { status: 503 })
      if (failure?.kind === 'fatal') throw Object.assign(new Error('nope'), { status: 403 })
      if (offset !== received) throw Object.assign(new Error('offset'), { status: 409 })
      const bytes = new Uint8Array(await chunk.arrayBuffer())
      stored.push(...bytes)
      received += bytes.length
      options.onProgress?.(bytes.length)
      // The bytes arrived, but the answer is lost on the way back.
      if (failure?.kind === 'lost-answer') throw Object.assign(new Error('lost'), { status: 0 })
      return { receivedBytes: received }
    },
    async completeLargeUpload(_id, timeoutMs) {
      calls.push('complete')
      if (timeoutMs !== undefined) completeTimeouts.push(timeoutMs)
      // Like the server: finishing again after success returns the same attachment.
      if (completed) return attachment()
      const failure = completeFailures.shift()
      if (failure === 'timeout') throw error(0, 'timeout')
      if (failure === 'finishing') throw error(409, 'upload_finishing')
      if (failure === 'lost') throw error(409, 'upload_lost')
      if (received !== size) throw error(409, 'upload_incomplete')
      completed = true
      if (failure === 'lost-answer') throw error(0, 'network_error')
      return attachment()
    },
    async cancelLargeUpload() {
      calls.push('cancel')
      cancelled = true
    }
  }
  return {
    api,
    stored,
    calls,
    failNext,
    statusFailures,
    completeFailures,
    completeTimeouts,
    wasCancelled: () => cancelled
  }
}

const file = (n: number): Blob => new Blob([new Uint8Array(Array.from({ length: n }, (_, i) => i))])
const noWait = async (): Promise<void> => undefined

describe('large uploads', () => {
  it('sends every chunk in order and completes', async () => {
    const s = fakeServer()
    const progress: number[] = []
    const result = await uploadLargeFile(s.api, 'c1', file(10), 'f.zip', {
      onProgress: (p) => progress.push(p),
      sleep: noWait
    })
    expect(result.id).toBe('a1')
    expect(s.stored).toEqual(Array.from({ length: 10 }, (_, i) => i))
    expect(s.calls).toEqual(['start', 'chunk@0', 'chunk@4', 'chunk@8', 'complete'])
    expect(progress.at(-1)).toBe(1)
  })

  it('resumes from the server’s offset after network errors and lost answers', async () => {
    const s = fakeServer()
    s.failNext.push({ kind: 'network' }, { kind: 'lost-answer' }, { kind: 'server' })
    await uploadLargeFile(s.api, 'c1', file(10), 'f.zip', { sleep: noWait })
    // No byte lost or doubled.
    expect(s.stored).toEqual(Array.from({ length: 10 }, (_, i) => i))
    expect(s.calls.filter((c) => c.startsWith('status'))).toHaveLength(3)
  })

  it('gives up on errors that retrying can’t fix', async () => {
    const s = fakeServer()
    s.failNext.push({ kind: 'fatal' })
    await expect(
      uploadLargeFile(s.api, 'c1', file(10), 'f.zip', { sleep: noWait })
    ).rejects.toThrow('nope')
  })

  it('stops after too many failures in a row', async () => {
    const s = fakeServer()
    for (let i = 0; i < 10; i++) s.failNext.push({ kind: 'network' })
    await expect(
      uploadLargeFile(s.api, 'c1', file(10), 'f.zip', { sleep: noWait, maxAttempts: 3 })
    ).rejects.toThrow('net')
  })

  it('cancelling deletes the upload on the server', async () => {
    const s = fakeServer()
    const controller = new AbortController()
    const promise = uploadLargeFile(s.api, 'c1', file(10), 'f.zip', {
      signal: controller.signal,
      sleep: noWait,
      onProgress: (p) => {
        if (p >= 0.4) controller.abort()
      }
    })
    await expect(promise).rejects.toBeInstanceOf(LargeUploadAborted)
    expect(s.wasCancelled()).toBe(true)
    expect(s.calls).not.toContain('complete')
  })

  it('keeps trying while the server is unreachable, status checks included', async () => {
    const s = fakeServer()
    s.failNext.push({ kind: 'network' })
    s.statusFailures.push('network', 'network', 'network')
    const waits: number[] = []
    await uploadLargeFile(s.api, 'c1', file(10), 'f.zip', {
      sleep: async (ms) => {
        waits.push(ms)
      }
    })
    expect(s.stored).toEqual(Array.from({ length: 10 }, (_, i) => i))
    expect(s.calls.filter((c) => c.startsWith('status'))).toHaveLength(4)
    // Backs off between attempts instead of hammering the server.
    expect(waits).toEqual([1000, 2000, 4000, 8000])
  })

  it('finishing survives timeouts, lost answers and an attempt still in progress', async () => {
    const s = fakeServer()
    s.completeFailures.push('timeout', 'finishing', 'lost-answer')
    const result = await uploadLargeFile(s.api, 'c1', file(10), 'f.zip', { sleep: noWait })
    expect(result.id).toBe('a1')
    // Finishing is repeated as is (the status can't return the attachment).
    expect(s.calls.slice(-4)).toEqual(['complete', 'complete', 'complete', 'complete'])
    // The server hashes the whole file: big files get a long timeout.
    expect(s.completeTimeouts[0]).toBe(60_000)
    expect(completeTimeoutMs(5 * 1024 ** 3)).toBe(256_000)
  })

  it('reports a file the server lost, without retrying', async () => {
    const s = fakeServer()
    s.completeFailures.push('lost')
    await expect(
      uploadLargeFile(s.api, 'c1', file(10), 'f.zip', { sleep: noWait })
    ).rejects.toMatchObject({ code: 'upload_lost' })
    expect(s.calls.filter((c) => c === 'complete')).toHaveLength(1)
  })

  it('a retry continues the earlier server upload, or starts over if it is gone', async () => {
    const s = fakeServer()
    for (let i = 0; i < 2; i++) s.failNext.push({ kind: 'network' })
    let sessionId: string | undefined
    // The first attempt gives up halfway…
    s.failNext.unshift({ kind: 'lost-answer' })
    await expect(
      uploadLargeFile(s.api, 'c1', file(10), 'f.zip', {
        sleep: noWait,
        maxAttempts: 2,
        onSession: (id) => (sessionId = id)
      })
    ).rejects.toThrow()
    expect(sessionId).toBe('u1')
    expect(s.wasCancelled()).toBe(false)
    // …and Retry picks it up where the server says, without starting a new upload.
    s.calls.length = 0
    const result = await uploadLargeFile(s.api, 'c1', file(10), 'f.zip', {
      sleep: noWait,
      resumeId: sessionId
    })
    expect(result.id).toBe('a1')
    expect(s.calls[0]).toBe('status@4')
    expect(s.calls).not.toContain('start')
    expect(s.stored).toEqual(Array.from({ length: 10 }, (_, i) => i))

    const gone = fakeServer()
    gone.statusFailures.push('gone')
    await uploadLargeFile(gone.api, 'c1', file(10), 'f.zip', { sleep: noWait, resumeId: 'old' })
    expect(gone.calls.slice(0, 2)).toEqual(['status@0', 'start'])
  })

  it('cancelling during a wait between attempts takes effect at once', async () => {
    const s = fakeServer()
    s.failNext.push({ kind: 'network' })
    const controller = new AbortController()
    const started = Date.now()
    const promise = uploadLargeFile(s.api, 'c1', file(10), 'f.zip', { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expect(promise).rejects.toBeInstanceOf(LargeUploadAborted)
    // The first wait is a whole second; cancelling doesn't sit it out.
    expect(Date.now() - started).toBeLessThan(500)
    expect(s.wasCancelled()).toBe(true)
  })

  it('knows which files need it and explains expiry', () => {
    const MB = 1024 * 1024
    expect(needsLargeUpload(25 * MB, 25 * MB)).toBe(false)
    expect(needsLargeUpload(25 * MB + 1, 25 * MB)).toBe(true)
    expect(expiryNote(500 * MB, 500 * MB, 24 * 3_600_000)).toBeNull()
    expect(expiryNote(500 * MB + 1, 500 * MB, 24 * 3_600_000)).toBe(
      'Files over 500 MB are deleted 24 hours after they finish uploading.'
    )
  })

  it('labels expiring and expired files', () => {
    const now = 1_000_000_000
    expect(expiryLabel(undefined, now)).toBeNull()
    expect(expiryLabel(now + 23.4 * 3_600_000, now)).toBe('Deleted in 23 h')
    expect(expiryLabel(now + 12 * 60_000, now)).toBe('Deleted in 12 min')
    expect(expiryLabel(now - 1, now)).toBeNull()
    expect(attachmentExpired({ expired: true }, now)).toBe(true)
    expect(attachmentExpired({ expiresAt: now }, now)).toBe(true)
    expect(attachmentExpired({ expiresAt: now + 1 }, now)).toBe(false)
    expect(attachmentExpired({}, now)).toBe(false)
  })
})
