import { describe, expect, it } from 'vitest'
import type { ApiAttachment } from '../net/protocol'
import {
  LARGE_UPLOAD_MEMORY_MS,
  UploadManager,
  localLargeUploadStore,
  type LargeUploadRecord,
  type LargeUploadStore,
  type UploadManagerDeps,
  type UploadResume
} from './uploadManager'
import type { UploadItem } from './uploads'

class Cancelled extends Error {}

interface Call {
  channelId: string
  name: string
  signal: AbortSignal
  resume: UploadResume
  progress: (p: number) => void
  resolve: (a: ApiAttachment) => void
  reject: (e: unknown) => void
}

interface Setup {
  manager: UploadManager
  calls: Call[]
  deleted: string[]
  cancelled: string[]
  changes: () => number
}

function setup(store?: LargeUploadStore): Setup {
  const calls: Call[] = []
  const deleted: string[] = []
  const cancelled: string[] = []
  const deps: UploadManagerDeps = {
    upload: (channelId, _file, name, progress, signal, resume) =>
      new Promise<ApiAttachment>((resolve, reject) => {
        calls.push({ channelId, name, signal, resume, progress, resolve, reject })
        signal.addEventListener('abort', () => reject(new Cancelled()))
      }),
    deleteAttachment: (id) => deleted.push(id),
    cancelLargeUpload: (id) => cancelled.push(id),
    describeError: (err) => (err as Error).message,
    isCancelled: (err) => err instanceof Cancelled,
    store,
    now: () => 1_000_000
  }
  const manager = new UploadManager(() => deps)
  let changes = 0
  manager.subscribe(() => changes++)
  return { manager, calls, deleted, cancelled, changes: () => changes }
}

let n = 0
const file = (name: string, size = 10): { source: Blob; item: UploadItem } => ({
  source: new Blob([new Uint8Array(size)]),
  item: { key: `k${++n}`, name, size, isImage: false, status: 'uploading', progress: 0 }
})
const attachment = (id: string): ApiAttachment =>
  ({ id, filename: id, contentType: 'text/plain', kind: 'file', size: 1 }) as ApiAttachment
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('upload manager', () => {
  it('keeps uploads in their own channel; switching channels cancels nothing', async () => {
    const { manager, calls } = setup()
    const a = file('a.txt')
    const b = file('b.txt')
    manager.add('general', [a])
    // The user switches to #memes and starts another upload there.
    manager.add('memes', [b])
    expect(calls.map((c) => c.channelId)).toEqual(['general', 'memes'])
    calls[0]!.progress(0.5)
    expect(manager.tray('general')[0]!.progress).toBe(0.5)
    expect(manager.active().map((u) => u.channelId)).toEqual(['general', 'memes'])
    calls[0]!.resolve(attachment('att-a'))
    calls[1]!.resolve(attachment('att-b'))
    await flush()
    expect(calls.every((c) => !c.signal.aborted)).toBe(true)
    // Each message only takes its own channel's attachments.
    expect(manager.take('memes')!.map((x) => x.id)).toEqual(['att-b'])
    expect(manager.tray('memes')).toEqual([])
    expect(manager.tray('general').map((u) => u.status)).toEqual(['done'])
    expect(manager.take('general')!.map((x) => x.id)).toEqual(['att-a'])
    expect(manager.active()).toEqual([])
  })

  it('a message waits for running or failed uploads', async () => {
    const { manager, calls } = setup()
    manager.add('c', [file('x.txt')])
    expect(manager.take('c')).toBeNull()
    calls[0]!.reject(new Error('Cannot reach the server.'))
    await flush()
    expect(manager.tray('c')[0]).toMatchObject({
      status: 'error',
      error: 'Cannot reach the server.'
    })
    expect(manager.take('c')).toBeNull()
    expect(manager.take('elsewhere')).toEqual([])
  })

  it('cancel stops the transfer; an answer arriving afterwards is deleted', async () => {
    const { manager, calls, deleted } = setup()
    const f = file('big.zip')
    manager.add('c', [f])
    manager.remove('other-channel', f.item.key)
    expect(manager.tray('c')).toHaveLength(1)
    manager.remove('c', f.item.key)
    expect(calls[0]!.signal.aborted).toBe(true)
    expect(manager.tray('c')).toEqual([])
    // A finished upload removed later is deleted on the server.
    const g = file('g.txt')
    manager.add('c', [g])
    calls[1]!.resolve(attachment('att-g'))
    await flush()
    manager.remove('c', g.item.key)
    expect(deleted).toEqual(['att-g'])
  })

  it('retry continues the same server upload; removing a failed one cancels it there', async () => {
    const { manager, calls, cancelled } = setup()
    const f = file('movie.mp4')
    manager.add('c', [f])
    calls[0]!.resume.onSession('a'.repeat(32))
    calls[0]!.reject(new Error('Cannot reach the server.'))
    await flush()
    manager.retry('c', f.item.key)
    expect(calls[1]!.resume.id).toBe('a'.repeat(32))
    expect(manager.tray('c')[0]!.status).toBe('uploading')
    calls[1]!.reject(new Error('still down'))
    await flush()
    manager.remove('c', f.item.key)
    expect(cancelled).toEqual(['a'.repeat(32)])
  })

  it('after a restart, picking the same file for the same channel resumes it', async () => {
    const records: LargeUploadRecord[] = [
      { id: 'b'.repeat(32), channelId: 'c', name: 'movie.mp4', size: 10, at: 999_000 }
    ]
    const store: LargeUploadStore = {
      list: () => [...records],
      remember: (r) => {
        const i = records.findIndex((x) => x.id === r.id)
        if (i >= 0) records.splice(i, 1)
        records.push(r)
      },
      forget: (id) => {
        const i = records.findIndex((r) => r.id === id)
        if (i >= 0) records.splice(i, 1)
      }
    }
    const { manager, calls } = setup(store)
    manager.add('other', [file('movie.mp4')])
    manager.add('c', [file('movie.mp4', 11)])
    manager.add('c', [file('movie.mp4')])
    expect(calls.map((c) => c.resume.id)).toEqual([undefined, undefined, 'b'.repeat(32)])
    calls[2]!.resume.onSession('b'.repeat(32))
    calls[2]!.resolve(attachment('att'))
    await flush()
    expect(records.some((r) => r.id === 'b'.repeat(32))).toBe(false)
  })

  it('too many uploads open: leftovers from an earlier session are cancelled, then it retries once', async () => {
    const records: LargeUploadRecord[] = [
      { id: 'c'.repeat(32), channelId: 'x', name: 'old.zip', size: 5, at: 999_000 }
    ]
    const store: LargeUploadStore = {
      list: () => [...records],
      remember: (r) => records.push(r),
      forget: (id) => {
        const i = records.findIndex((r) => r.id === id)
        if (i >= 0) records.splice(i, 1)
      }
    }
    const { manager, calls, cancelled } = setup(store)
    const f = file('new.zip')
    manager.add('c', [f])
    calls[0]!.reject(
      Object.assign(new Error('You can upload at most 2 large files at a time.'), {
        code: 'too_many_uploads'
      })
    )
    await flush()
    expect(cancelled).toEqual(['c'.repeat(32)])
    expect(calls).toHaveLength(2)
    calls[1]!.reject(
      Object.assign(new Error('You can upload at most 2 large files at a time.'), {
        code: 'too_many_uploads'
      })
    )
    await flush()
    expect(calls).toHaveLength(2)
    expect(manager.tray('c')[0]!.status).toBe('error')
  })

  it('signing out cancels everything and deletes unsent attachments', async () => {
    const { manager, calls, deleted, cancelled } = setup()
    manager.add('a', [file('1.txt')])
    manager.add('b', [file('2.txt'), file('3.zip')])
    calls[0]!.resolve(attachment('done-1'))
    calls[2]!.resume.onSession('d'.repeat(32))
    calls[2]!.reject(new Error('failed'))
    await flush()
    manager.dispose()
    expect(calls[1]!.signal.aborted).toBe(true)
    expect(deleted).toEqual(['done-1'])
    expect(cancelled).toEqual(['d'.repeat(32)])
    expect(manager.active()).toEqual([])
    expect(manager.tray('a')).toEqual([])
  })

  it('progress is reported in whole percents', () => {
    const { manager, calls, changes } = setup()
    manager.add('c', [file('p.txt')])
    const before = changes()
    for (let i = 0; i < 100; i++) calls[0]!.progress(0.5 + i / 100_000)
    expect(changes() - before).toBe(1)
  })

  it('remembered uploads are stored per account and forgotten after a day', () => {
    const map = new Map<string, string>()
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k)
    }
    let now = 1_000_000
    const store = localLargeUploadStore('k', storage, () => now)
    store.remember({ id: 'e'.repeat(32), channelId: 'c', name: 'a', size: 1, at: now })
    store.remember({ id: 'not-an-id', channelId: 'c', name: 'a', size: 1, at: now })
    expect(store.list().map((r) => r.id)).toEqual(['e'.repeat(32)])
    now += LARGE_UPLOAD_MEMORY_MS
    expect(store.list()).toEqual([])
    map.set('k', '{bad json')
    expect(store.list()).toEqual([])
  })
})
