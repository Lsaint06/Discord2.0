/**
 * Attachments are fetched with the session token (never public URLs) and shown via blob: URLs.
 * This cache de-duplicates concurrent loads, bounds memory by total bytes (LRU), and revokes
 * evicted object URLs so they can be garbage-collected.
 */

export interface BlobUrlApi {
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
}

interface Entry {
  url: string
  size: number
}

export class AttachmentCache {
  private readonly entries = new Map<string, Entry>()
  private readonly inflight = new Map<string, Promise<string>>()
  private bytes = 0

  constructor(
    private readonly load: (id: string) => Promise<Blob>,
    private readonly maxBytes = 200 * 1024 * 1024,
    private readonly urls: BlobUrlApi = URL
  ) {}

  /** Cached URL without loading (used for synchronous first render). */
  peek(id: string): string | undefined {
    return this.entries.get(id)?.url
  }

  get(id: string): Promise<string> {
    const hit = this.entries.get(id)
    if (hit) {
      // Refresh LRU position.
      this.entries.delete(id)
      this.entries.set(id, hit)
      return Promise.resolve(hit.url)
    }
    const pending = this.inflight.get(id)
    if (pending) return pending
    const promise = this.load(id)
      .then((blob) => {
        const url = this.urls.createObjectURL(blob)
        this.entries.set(id, { url, size: blob.size })
        this.bytes += blob.size
        this.evict(id)
        return url
      })
      .finally(() => this.inflight.delete(id))
    this.inflight.set(id, promise)
    return promise
  }

  /** Drops an entry (e.g. its message was deleted). */
  forget(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    this.bytes -= entry.size
    this.urls.revokeObjectURL(entry.url)
  }

  clear(): void {
    for (const id of [...this.entries.keys()]) this.forget(id)
  }

  get size(): number {
    return this.bytes
  }

  private evict(keep: string): void {
    for (const [id] of this.entries) {
      if (this.bytes <= this.maxBytes) break
      if (id !== keep) this.forget(id)
    }
  }
}
