import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, statfsSync, type ReadStream } from 'node:fs'
import { readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { once } from 'node:events'

/** Opaque storage id: 32 lowercase hex chars. Validated before it ever touches a path. */
const ID_SHAPE = /^[a-f0-9]{32}$/

export function newAttachmentId(): string {
  return randomBytes(16).toString('hex')
}

export function isAttachmentId(id: unknown): id is string {
  return typeof id === 'string' && ID_SHAPE.test(id)
}

export class FileTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`File exceeds ${limit} bytes`)
  }
}

export interface ReceivedFile {
  tmpPath: string
  size: number
  sha256: string
  /** First bytes of the file, for signature/dimension sniffing. */
  head: Buffer
}

/** How many leading bytes we keep for sniffing (JPEG EXIF can push the size header far in). */
const HEAD_BYTES = 512 * 1024

/**
 * Attachment binaries on disk:
 *   <root>/files/<id[0..2]>/<id>   committed files (immutable, named by opaque id)
 *   <root>/tmp/<random>.part       uploads in progress
 * Metadata lives in SQLite; a file without a row is an orphan and is swept after a grace period.
 */
export class AttachmentStore {
  readonly filesDir: string
  readonly tmpDir: string

  constructor(readonly root: string) {
    this.filesDir = join(root, 'files')
    this.tmpDir = join(root, 'tmp')
    mkdirSync(this.filesDir, { recursive: true })
    mkdirSync(this.tmpDir, { recursive: true })
  }

  pathFor(id: string): string {
    if (!isAttachmentId(id)) throw new Error('invalid attachment id')
    return join(this.filesDir, id.slice(0, 2), id)
  }

  /**
   * Streams an upload to a temp file, hashing it and enforcing `maxBytes` as it goes. Past the
   * limit the rest of the stream is still read (and discarded) so the multipart parser can
   * reach the end of the request; the temp file is deleted and FileTooLargeError is thrown.
   */
  async receive(source: Readable, maxBytes: number): Promise<ReceivedFile> {
    const tmpPath = join(this.tmpDir, `${randomBytes(12).toString('hex')}.part`)
    const hash = createHash('sha256')
    const headParts: Buffer[] = []
    let headSize = 0
    let size = 0
    let tooLarge = false
    const out = createWriteStream(tmpPath, { flags: 'wx' })
    const closed = new Promise<void>((resolve, reject) => {
      out.once('close', resolve)
      out.once('error', reject)
    })
    try {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        size += chunk.length
        if (tooLarge) continue
        if (size > maxBytes) {
          tooLarge = true
          continue
        }
        hash.update(chunk)
        if (headSize < HEAD_BYTES) {
          const part = chunk.subarray(0, HEAD_BYTES - headSize)
          headParts.push(part)
          headSize += part.length
        }
        if (!out.write(chunk)) await once(out, 'drain')
      }
      out.end()
      await closed
    } catch (err) {
      out.destroy()
      await closed.catch(() => undefined)
      await unlink(tmpPath).catch(() => undefined)
      throw err
    }
    if (tooLarge) {
      await unlink(tmpPath).catch(() => undefined)
      throw new FileTooLargeError(maxBytes)
    }
    return { tmpPath, size, sha256: hash.digest('hex'), head: Buffer.concat(headParts) }
  }

  /** Moves a received temp file into place under its id (atomic rename on the same volume). */
  async commit(tmpPath: string, id: string): Promise<void> {
    const target = this.pathFor(id)
    mkdirSync(join(this.filesDir, id.slice(0, 2)), { recursive: true })
    await rename(tmpPath, target)
  }

  async discard(tmpPath: string): Promise<void> {
    await unlink(tmpPath).catch(() => undefined)
  }

  async remove(id: string): Promise<void> {
    if (!isAttachmentId(id)) return
    await unlink(this.pathFor(id)).catch(() => undefined)
  }

  open(id: string): ReadStream {
    return createReadStream(this.pathFor(id))
  }

  /** Bytes start..end (inclusive) of a stored file. */
  openRange(id: string, start: number, end: number): ReadStream {
    return createReadStream(this.pathFor(id), { start, end })
  }

  /** Free bytes on the volume holding the attachments. */
  freeBytes(): number {
    const s = statfsSync(this.root)
    return Number(s.bavail) * Number(s.bsize)
  }

  /**
   * Deletes committed files that have no database row and stale temp files, both only when
   * older than `graceMs` (so an upload that is between "file written" and "row inserted" is
   * never touched). Files with a row are never deleted here.
   */
  async sweep(
    referenced: Set<string>,
    graceMs: number,
    now = Date.now()
  ): Promise<{ orphans: number; temps: number }> {
    let orphans = 0
    let temps = 0
    for (const shard of await readdir(this.filesDir).catch(() => [] as string[])) {
      const dir = join(this.filesDir, shard)
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (!isAttachmentId(name) || referenced.has(name)) continue
        const info = await stat(join(dir, name)).catch(() => undefined)
        if (info && now - info.mtimeMs > graceMs) {
          await unlink(join(dir, name)).catch(() => undefined)
          orphans++
        }
      }
    }
    for (const name of await readdir(this.tmpDir).catch(() => [] as string[])) {
      const info = await stat(join(this.tmpDir, name)).catch(() => undefined)
      if (info && now - info.mtimeMs > graceMs) {
        await rm(join(this.tmpDir, name), { force: true })
        temps++
      }
    }
    return { orphans, temps }
  }
}
