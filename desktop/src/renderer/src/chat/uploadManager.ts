/**
 * Attachment uploads owned by the whole workspace instead of one message box, so switching
 * channels never cancels a transfer (multi-gigabyte uploads take a while). Each upload belongs
 * to the channel it was started in — its tray — and only that channel's message can take its
 * attachments, so nothing is ever sent to the wrong place.
 *
 * Large uploads also survive restarting the app: their server upload ids are remembered on this
 * PC, and picking the same file (name and size) for the same channel again continues the
 * upload where the server has it. Uploads still open on the server from an earlier session are
 * cancelled when the server says too many are open.
 */
import type { ApiAttachment } from '../net/protocol'
import { uploadsReady, type UploadItem } from './uploads'

export interface UploadResume {
  /** The server upload of an earlier attempt to continue. */
  id?: string
  /** Gets the server upload's id as soon as it exists. */
  onSession: (uploadId: string) => void
}

export type UploadFn = (
  channelId: string,
  file: Blob,
  filename: string,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
  resume: UploadResume
) => Promise<ApiAttachment>

/** Large uploads remembered across restarts. */
export interface LargeUploadRecord {
  id: string
  channelId: string
  name: string
  size: number
  /** When it was started (epoch ms). */
  at: number
}

export interface LargeUploadStore {
  list(): LargeUploadRecord[]
  remember(record: LargeUploadRecord): void
  forget(id: string): void
}

export interface UploadManagerDeps {
  upload: UploadFn
  deleteAttachment: (attachmentId: string) => void
  cancelLargeUpload: (uploadId: string) => void
  describeError: (err: unknown) => string
  /** The upload was cancelled on purpose (no error to show). */
  isCancelled: (err: unknown) => boolean
  createPreview?: (file: Blob) => string
  revokePreview?: (url: string) => void
  store?: LargeUploadStore
  now?: () => number
}

/** An upload still running or failed, anywhere (for the "uploads elsewhere" indicator). */
export interface ActiveUpload {
  channelId: string
  key: string
  name: string
  status: UploadItem['status']
  progress: number
}

interface Entry {
  channelId: string
  source: Blob
  controller: AbortController | null
  attachment: ApiAttachment | null
  /** Server upload behind a large file (kept after a failure, for Retry). */
  largeId: string | null
  preview: string | null
}

const EMPTY: UploadItem[] = []
/** Server uploads are abandoned (and cleaned up) after a day: older records are useless. */
export const LARGE_UPLOAD_MEMORY_MS = 24 * 60 * 60_000

export class UploadManager {
  private readonly trays = new Map<string, UploadItem[]>()
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private activeList: ActiveUpload[] = []

  constructor(private readonly deps: () => UploadManagerDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The uploads waiting to go with the next message in this channel (stable between changes). */
  tray = (channelId: string): UploadItem[] => this.trays.get(channelId) ?? EMPTY

  /** Uploads running or failed in any channel (stable between changes). */
  active = (): ActiveUpload[] => this.activeList

  preview(key: string): string | null {
    return this.entries.get(key)?.preview ?? null
  }

  add(channelId: string, files: { source: Blob; item: UploadItem }[]): void {
    if (files.length === 0) return
    const { createPreview } = this.deps()
    for (const { source, item } of files) {
      this.entries.set(item.key, {
        channelId,
        source,
        controller: null,
        attachment: null,
        largeId: null,
        preview: item.isImage && createPreview ? createPreview(source) : null
      })
    }
    this.update(channelId, (items) => [...items, ...files.map((f) => f.item)])
    for (const { item } of files) this.start(item.key, item.name)
  }

  /** Cancels a running upload, or discards a finished or failed one. */
  remove(channelId: string, key: string): void {
    const entry = this.entries.get(key)
    if (!entry || entry.channelId !== channelId) return
    this.discard(key, entry)
    this.update(channelId, (items) => items.filter((u) => u.key !== key))
  }

  retry(channelId: string, key: string): void {
    const entry = this.entries.get(key)
    const item = this.tray(channelId).find((u) => u.key === key)
    if (!entry || entry.channelId !== channelId || !item || item.status !== 'error') return
    this.update(channelId, (items) =>
      items.map((u) =>
        u.key === key ? { ...u, status: 'uploading', progress: 0, error: undefined } : u
      )
    )
    this.start(key, item.name)
  }

  /**
   * The finished attachments for a message in this channel, in order, emptying its tray — or
   * null while an upload is still running or has failed.
   */
  take(channelId: string): ApiAttachment[] | null {
    const items = this.tray(channelId)
    if (!uploadsReady(items)) return null
    const out: ApiAttachment[] = []
    for (const u of items) {
      const entry = this.entries.get(u.key)
      if (entry?.attachment && entry.channelId === channelId) out.push(entry.attachment)
      if (entry?.preview) this.deps().revokePreview?.(entry.preview)
      this.entries.delete(u.key)
    }
    this.update(channelId, () => [])
    return out
  }

  /** Signing out: everything is cancelled and unsent attachments are deleted. */
  dispose(): void {
    for (const [key, entry] of [...this.entries]) this.discard(key, entry)
    this.trays.clear()
    this.refresh()
  }

  private discard(key: string, entry: Entry): void {
    const deps = this.deps()
    if (entry.controller) {
      // A running large upload deletes itself on the server when aborted.
      entry.controller.abort()
    } else if (entry.largeId) {
      deps.cancelLargeUpload(entry.largeId)
    }
    if (entry.largeId) deps.store?.forget(entry.largeId)
    if (entry.attachment) deps.deleteAttachment(entry.attachment.id)
    if (entry.preview) deps.revokePreview?.(entry.preview)
    this.entries.delete(key)
  }

  private start(key: string, name: string, retriedAfterCleanup = false): void {
    const entry = this.entries.get(key)
    if (!entry) return
    const deps = this.deps()
    const controller = new AbortController()
    entry.controller = controller
    const now = deps.now?.() ?? Date.now()
    const remembered = entry.largeId
      ? null
      : deps.store
          ?.list()
          .find(
            (r) =>
              r.channelId === entry.channelId &&
              r.name === name &&
              r.size === entry.source.size &&
              now - r.at < LARGE_UPLOAD_MEMORY_MS &&
              !this.inUse(r.id)
          )
    deps
      .upload(
        entry.channelId,
        entry.source,
        name,
        (p) => this.progress(entry.channelId, key, p),
        controller.signal,
        {
          id: entry.largeId ?? remembered?.id,
          onSession: (id) => {
            entry.largeId = id
            deps.store?.remember({
              id,
              channelId: entry.channelId,
              name,
              size: entry.source.size,
              at: remembered && remembered.id === id ? remembered.at : now
            })
          }
        }
      )
      .then((attachment) => {
        if (this.entries.get(key) !== entry) {
          // Removed meanwhile (the abort came too late): don't leave it on the server.
          deps.deleteAttachment(attachment.id)
          return
        }
        entry.controller = null
        if (entry.largeId) deps.store?.forget(entry.largeId)
        entry.largeId = null
        entry.attachment = attachment
        this.update(entry.channelId, (items) =>
          items.map((u) =>
            u.key === key ? { ...u, status: 'done', progress: 1, attachmentId: attachment.id } : u
          )
        )
      })
      .catch((err: unknown) => {
        if (this.entries.get(key) !== entry) return
        entry.controller = null
        if (deps.isCancelled(err)) return
        // Too many uploads open on the server: ones left behind by an earlier session (app
        // closed mid-upload) are cancelled, then this one tries again — once.
        if (
          (err as { code?: string } | null)?.code === 'too_many_uploads' &&
          !retriedAfterCleanup
        ) {
          const orphans = (deps.store?.list() ?? []).filter((r) => !this.inUse(r.id))
          if (orphans.length > 0) {
            for (const r of orphans) {
              deps.cancelLargeUpload(r.id)
              deps.store?.forget(r.id)
            }
            this.start(key, name, true)
            return
          }
        }
        const error = deps.describeError(err)
        this.update(entry.channelId, (items) =>
          items.map((u) => (u.key === key ? { ...u, status: 'error', error } : u))
        )
      })
  }

  private inUse(largeId: string): boolean {
    for (const e of this.entries.values()) if (e.largeId === largeId) return true
    return false
  }

  private progress(channelId: string, key: string, fraction: number): void {
    const items = this.tray(channelId)
    const item = items.find((u) => u.key === key)
    if (!item || item.status !== 'uploading') return
    const next = Math.max(item.progress, Math.min(1, fraction))
    // Whole percents only: progress events arrive many times a second.
    if (Math.floor(next * 100) === Math.floor(item.progress * 100)) return
    this.update(channelId, (list) =>
      list.map((u) => (u.key === key ? { ...u, progress: next } : u))
    )
  }

  private update(channelId: string, change: (items: UploadItem[]) => UploadItem[]): void {
    const next = change(this.tray(channelId))
    if (next.length === 0) this.trays.delete(channelId)
    else this.trays.set(channelId, next)
    this.refresh()
  }

  private refresh(): void {
    const active: ActiveUpload[] = []
    for (const [channelId, items] of this.trays) {
      for (const u of items) {
        if (u.status !== 'done') {
          active.push({
            channelId,
            key: u.key,
            name: u.name,
            status: u.status,
            progress: u.progress
          })
        }
      }
    }
    this.activeList = active
    for (const listener of [...this.listeners]) listener()
  }
}

/** Large uploads remembered in localStorage, per server and account (like drafts). */
export function localLargeUploadStore(
  key: string,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage,
  now: () => number = Date.now
): LargeUploadStore {
  const read = (): LargeUploadRecord[] => {
    try {
      const raw = JSON.parse(storage.getItem(key) ?? '[]') as unknown
      if (!Array.isArray(raw)) return []
      return raw.filter(
        (r): r is LargeUploadRecord =>
          !!r &&
          typeof r.id === 'string' &&
          /^[a-f0-9]{32}$/.test(r.id) &&
          typeof r.channelId === 'string' &&
          typeof r.name === 'string' &&
          typeof r.size === 'number' &&
          typeof r.at === 'number' &&
          now() - r.at < LARGE_UPLOAD_MEMORY_MS
      )
    } catch {
      return []
    }
  }
  const write = (records: LargeUploadRecord[]): void => {
    try {
      if (records.length === 0) storage.removeItem(key)
      else storage.setItem(key, JSON.stringify(records.slice(-20)))
    } catch {
      // Storage unavailable: resuming after a restart just isn't offered.
    }
  }
  return {
    list: read,
    remember: (record) => write([...read().filter((r) => r.id !== record.id), record]),
    forget: (id) => write(read().filter((r) => r.id !== id))
  }
}

export const largeUploadsKey = (serverUrl: string, username: string): string =>
  `d2.largeUploads.${serverUrl}|${username.toLowerCase()}`
