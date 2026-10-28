/**
 * The composer's attachment tray as a pure reducer: selection, client-side validation (the
 * server re-validates everything), progress, completion, errors and removal.
 */

export const UPLOAD_LIMITS = {
  maxFiles: 5,
  maxImageBytes: 15 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp']
export const ALLOWED_UPLOAD_EXTS = [
  ...IMAGE_EXTS,
  'pdf',
  'txt',
  'log',
  'md',
  'csv',
  'json',
  'zip',
  '7z',
  'rar',
  'docx',
  'xlsx',
  'pptx',
  // Milestone 13: videos (offered as downloads).
  'mp4',
  'mov',
  'mkv',
  'webm'
]

/** Value for <input type="file" accept>. */
export const UPLOAD_ACCEPT = ALLOWED_UPLOAD_EXTS.map((e) => `.${e}`).join(',')

export type UploadStatus = 'uploading' | 'done' | 'error'

export interface UploadItem {
  key: string
  name: string
  size: number
  isImage: boolean
  status: UploadStatus
  /** 0–1 */
  progress: number
  attachmentId?: string
  error?: string
}

export interface FileLike {
  name: string
  size: number
  type?: string
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isImageName = (name: string): boolean => IMAGE_EXTS.includes(extensionOf(name))

const mb = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024
    ? `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10} GB`
    : `${Math.round(bytes / (1024 * 1024))} MB`

/**
 * Why a file can't be uploaded, or null if it looks acceptable. With `largeMaxBytes` (the
 * server accepts large files), anything up to that size is fine: bigger than a normal upload
 * goes through the chunked large-file path.
 */
export function validateFile(file: FileLike, largeMaxBytes?: number): string | null {
  const ext = extensionOf(file.name)
  if (!ALLOWED_UPLOAD_EXTS.includes(ext)) {
    return ext ? `.${ext} files aren’t allowed` : 'Files need an extension (e.g. .png, .pdf)'
  }
  if (file.size === 0) return 'This file is empty'
  if (largeMaxBytes) {
    return file.size > largeMaxBytes ? `Files can be at most ${mb(largeMaxBytes)}` : null
  }
  const limit = isImageName(file.name) ? UPLOAD_LIMITS.maxImageBytes : UPLOAD_LIMITS.maxFileBytes
  if (file.size > limit) {
    return `${isImageName(file.name) ? 'Images' : 'Files'} can be at most ${mb(limit)}`
  }
  return null
}

export type UploadAction =
  | { type: 'add'; items: UploadItem[] }
  | { type: 'progress'; key: string; progress: number }
  | { type: 'done'; key: string; attachmentId: string }
  | { type: 'error'; key: string; error: string }
  | { type: 'remove'; key: string }
  | { type: 'clear' }

export function uploadsReducer(state: UploadItem[], action: UploadAction): UploadItem[] {
  switch (action.type) {
    case 'add':
      return [...state, ...action.items]
    case 'progress':
      return state.map((u) =>
        u.key === action.key && u.status === 'uploading'
          ? { ...u, progress: Math.max(u.progress, Math.min(1, action.progress)) }
          : u
      )
    case 'done':
      return state.map((u) =>
        u.key === action.key
          ? { ...u, status: 'done', progress: 1, attachmentId: action.attachmentId }
          : u
      )
    case 'error':
      return state.map((u) =>
        u.key === action.key ? { ...u, status: 'error', error: action.error } : u
      )
    case 'remove':
      return state.filter((u) => u.key !== action.key)
    case 'clear':
      return []
  }
}

/**
 * Splits newly picked files into accepted ones (as tray items) and per-file rejections,
 * respecting the per-message file limit.
 */
export function planUploads<F extends FileLike>(
  current: UploadItem[],
  files: F[],
  makeKey: () => string,
  /** The server's large-file ceiling, when it accepts large files. */
  largeMaxBytes?: number
): { accepted: { file: F; item: UploadItem }[]; rejected: string[] } {
  const accepted: { file: F; item: UploadItem }[] = []
  const rejected: string[] = []
  let slots = UPLOAD_LIMITS.maxFiles - current.length
  for (const file of files) {
    const problem = validateFile(file, largeMaxBytes)
    if (problem) {
      rejected.push(`${file.name}: ${problem}`)
      continue
    }
    if (slots <= 0) {
      rejected.push(`${file.name}: at most ${UPLOAD_LIMITS.maxFiles} files per message`)
      continue
    }
    slots--
    accepted.push({
      file,
      item: {
        key: makeKey(),
        name: file.name,
        size: file.size,
        isImage: isImageName(file.name),
        status: 'uploading',
        progress: 0
      }
    })
  }
  return { accepted, rejected }
}

/** The message can be sent: no upload still running or failed. */
export function uploadsReady(items: UploadItem[]): boolean {
  return items.every((u) => u.status === 'done')
}

/** Clipboard images have no useful name; give them one with the right extension. */
export function nameForPastedFile(file: FileLike, now = new Date()): string {
  if (file.name && file.name !== 'image.png' && extensionOf(file.name)) return file.name
  const ext =
    file.type === 'image/jpeg'
      ? 'jpg'
      : file.type === 'image/gif'
        ? 'gif'
        : file.type === 'image/webp'
          ? 'webp'
          : 'png'
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `pasted-${stamp}.${ext}`
}

/** Files from a drop or paste (DataTransfer), ignoring non-file items such as text. */
export function filesFromTransfer(
  transfer: { files?: ArrayLike<File> | null; items?: ArrayLike<DataTransferItem> | null } | null
): File[] {
  if (!transfer) return []
  if (transfer.files && transfer.files.length > 0) return Array.from(transfer.files)
  const out: File[] = []
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) out.push(file)
  }
  return out
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`
}
