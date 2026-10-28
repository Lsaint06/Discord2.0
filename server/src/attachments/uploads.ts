/**
 * Partial files of chunked, resumable uploads (Milestone 13 large files):
 *   <root>/uploads/<session id>.part
 * Chunks are written in order at the offset the database says comes next, flushed to disk
 * (fsync) before the progress is recorded, so a crash or restart never loses or doubles data:
 * the client asks for the session again and continues from the recorded offset (anything
 * written past it is simply overwritten). Nothing is ever held in memory beyond one stream
 * buffer.
 */
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync } from 'node:fs'
import { open, readdir, rename, stat, truncate, unlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

const SESSION_ID = /^[a-f0-9]{32}$/
const HEAD_BYTES = 512 * 1024

export const isUploadSessionId = (id: unknown): id is string => typeof id === 'string' && SESSION_ID.test(id)

/** SHA-256 of a whole file plus its first bytes (for the file-type check), streamed. */
export async function hashFileHead(path: string): Promise<{ sha256: string; head: Buffer }> {
  const hash = createHash('sha256')
  const head: Buffer[] = []
  let headSize = 0
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk)
    if (headSize < HEAD_BYTES) {
      const part = chunk.subarray(0, HEAD_BYTES - headSize)
      head.push(part)
      headSize += part.length
    }
  }
  return { sha256: hash.digest('hex'), head: Buffer.concat(head) }
}

export class ChunkTooLargeError extends Error {}
export class PartMissingError extends Error {}

export class UploadPartStore {
  readonly dir: string

  constructor(root: string) {
    this.dir = join(root, 'uploads')
    mkdirSync(this.dir, { recursive: true })
  }

  partPath(id: string): string {
    if (!isUploadSessionId(id)) throw new Error('invalid upload session id')
    return join(this.dir, `${id}.part`)
  }

  /**
   * Writes one chunk at `offset` from `source` (at most `maxBytes`) and flushes it to disk.
   * Returns the bytes written. The first chunk (offset 0) creates/truncates the part file.
   */
  async writeChunk(id: string, offset: number, source: Readable, maxBytes: number): Promise<number> {
    let handle
    try {
      handle = await open(this.partPath(id), offset === 0 ? 'w' : 'r+')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new PartMissingError('part file missing')
      throw err
    }
    let written = 0
    try {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        if (written + chunk.length > maxBytes) throw new ChunkTooLargeError('chunk too large')
        let done = 0
        while (done < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, done, chunk.length - done, offset + written + done)
          done += bytesWritten
        }
        written += chunk.length
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    return written
  }

  /** Size on disk (0 if missing). */
  async partSize(id: string): Promise<number> {
    const info = await stat(this.partPath(id)).catch(() => undefined)
    return info?.size ?? 0
  }

  async hasPart(id: string): Promise<boolean> {
    return (await stat(this.partPath(id)).catch(() => undefined)) !== undefined
  }

  /** Cuts anything past `size`, then hashes the file and returns its first bytes. */
  async finalize(id: string, size: number): Promise<{ sha256: string; head: Buffer }> {
    const path = this.partPath(id)
    await truncate(path, size)
    return hashFileHead(path)
  }

  /**
   * Moves the finished part file to its final place (atomic rename on the same volume). Its
   * modification time is reset first: the orphan sweep spares row-less files younger than its
   * grace period, and the last chunk may have arrived long ago.
   */
  async moveTo(id: string, target: string): Promise<void> {
    const now = new Date()
    await utimes(this.partPath(id), now, now)
    await rename(this.partPath(id), target)
  }

  async remove(id: string): Promise<void> {
    if (!isUploadSessionId(id)) return
    await unlink(this.partPath(id)).catch(() => undefined)
  }

  /** Deletes part files that have no session row (older than `graceMs`). */
  async sweep(sessions: Set<string>, graceMs: number, now = Date.now()): Promise<number> {
    let removed = 0
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const id = name.endsWith('.part') ? name.slice(0, -5) : ''
      if (isUploadSessionId(id) && sessions.has(id)) continue
      const info = await stat(join(this.dir, name)).catch(() => undefined)
      if (info && now - info.mtimeMs > graceMs) {
        await unlink(join(this.dir, name)).catch(() => undefined)
        removed++
      }
    }
    return removed
  }
}
