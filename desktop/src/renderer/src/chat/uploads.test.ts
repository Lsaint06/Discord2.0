import { describe, expect, it } from 'vitest'
import {
  UPLOAD_LIMITS,
  filesFromTransfer,
  formatBytes,
  nameForPastedFile,
  planUploads,
  uploadsReady,
  uploadsReducer,
  validateFile,
  type UploadItem
} from './uploads'

const MB = 1024 * 1024
let n = 0
const key = (): string => `k${n++}`

describe('validateFile', () => {
  it('accepts allowlisted types within their limits', () => {
    expect(validateFile({ name: 'shot.PNG', size: 1000 })).toBeNull()
    expect(validateFile({ name: 'report.pdf', size: 20 * MB })).toBeNull()
  })

  it('rejects disallowed, extensionless, empty and oversized files', () => {
    expect(validateFile({ name: 'setup.exe', size: 10 })).toMatch(/\.exe/)
    expect(validateFile({ name: 'page.html', size: 10 })).toMatch(/aren’t allowed/)
    expect(validateFile({ name: 'README', size: 10 })).toMatch(/extension/)
    expect(validateFile({ name: '.png', size: 10 })).toMatch(/extension/)
    expect(validateFile({ name: 'a.txt', size: 0 })).toMatch(/empty/)
    expect(validateFile({ name: 'big.jpg', size: UPLOAD_LIMITS.maxImageBytes + 1 })).toMatch(
      /Images can be at most 15 MB/
    )
    expect(validateFile({ name: 'big.zip', size: UPLOAD_LIMITS.maxFileBytes + 1 })).toMatch(
      /Files can be at most 25 MB/
    )
  })
})

describe('planUploads', () => {
  it('splits accepted and rejected files and enforces the per-message limit', () => {
    const existing: UploadItem[] = Array.from({ length: 3 }, (_, i) => ({
      key: `e${i}`,
      name: 'x.png',
      size: 1,
      isImage: true,
      status: 'done',
      progress: 1
    }))
    const { accepted, rejected } = planUploads(
      existing,
      [
        { name: 'a.png', size: 1 },
        { name: 'bad.exe', size: 1 },
        { name: 'b.pdf', size: 1 },
        { name: 'c.txt', size: 1 }
      ],
      key
    )
    expect(accepted.map((a) => a.item.name)).toEqual(['a.png', 'b.pdf'])
    expect(accepted[0].item).toMatchObject({ isImage: true, status: 'uploading', progress: 0 })
    expect(accepted[1].item.isImage).toBe(false)
    expect(rejected).toHaveLength(2)
    expect(rejected[1]).toMatch(/c\.txt: at most 5 files/)
  })
})

describe('uploadsReducer', () => {
  const item: UploadItem = {
    key: 'u1',
    name: 'a.png',
    size: 5,
    isImage: true,
    status: 'uploading',
    progress: 0
  }

  it('tracks progress monotonically and completes', () => {
    let s = uploadsReducer([], { type: 'add', items: [item] })
    s = uploadsReducer(s, { type: 'progress', key: 'u1', progress: 0.6 })
    s = uploadsReducer(s, { type: 'progress', key: 'u1', progress: 0.4 })
    expect(s[0].progress).toBe(0.6)
    expect(uploadsReady(s)).toBe(false)
    s = uploadsReducer(s, { type: 'done', key: 'u1', attachmentId: 'abc' })
    expect(s[0]).toMatchObject({ status: 'done', progress: 1, attachmentId: 'abc' })
    expect(uploadsReady(s)).toBe(true)
  })

  it('records errors, ignores progress after them, and removes items', () => {
    let s = uploadsReducer([item], { type: 'error', key: 'u1', error: 'Too large' })
    expect(uploadsReducer(s, { type: 'progress', key: 'u1', progress: 0.9 })[0].progress).toBe(0)
    expect(uploadsReady(s)).toBe(false)
    s = uploadsReducer(s, { type: 'remove', key: 'u1' })
    expect(s).toEqual([])
    expect(uploadsReady(s)).toBe(true)
    expect(uploadsReducer([item], { type: 'clear' })).toEqual([])
  })
})

describe('pasted files', () => {
  const now = new Date('2026-03-04T05:06:07Z')

  it('names clipboard images by type and timestamp', () => {
    expect(nameForPastedFile({ name: 'image.png', size: 1, type: 'image/png' }, now)).toBe(
      'pasted-20260304-050607.png'
    )
    expect(nameForPastedFile({ name: '', size: 1, type: 'image/jpeg' }, now)).toBe(
      'pasted-20260304-050607.jpg'
    )
    expect(nameForPastedFile({ name: 'notes.txt', size: 1, type: 'text/plain' }, now)).toBe(
      'notes.txt'
    )
  })

  it('takes files from a transfer and ignores text items', () => {
    const f1 = { name: 'a.png' } as File
    const f2 = { name: 'b.png' } as File
    expect(filesFromTransfer({ files: [f1, f2] })).toEqual([f1, f2])
    const items = [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => f1 },
      { kind: 'file', getAsFile: () => null }
    ] as unknown as DataTransferItem[]
    expect(filesFromTransfer({ files: [], items })).toEqual([f1])
    expect(filesFromTransfer(null)).toEqual([])
  })
})

describe('formatBytes', () => {
  it('formats B, KB and MB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(15 * MB)).toBe('15 MB')
  })
})
