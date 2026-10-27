/**
 * Upload allowlist and content sniffing. Pure functions (no I/O) so they are easy to test.
 *
 * Rules:
 * - The extension selects a candidate type from the allowlist; anything else is rejected.
 * - The file's first bytes must match that type's signature (magic number).
 * - The served Content-Type always comes from this table, never from the client.
 * - Only raster images are ever displayed inline; everything else is downloaded.
 */

export type AttachmentKind = 'image' | 'file'

export interface FileType {
  ext: string
  contentType: string
  kind: AttachmentKind
  /** True when the first bytes look like this type. */
  matches: (head: Uint8Array) => boolean
}

const bytes = (head: Uint8Array, offset: number, sig: number[]): boolean =>
  head.length >= offset + sig.length && sig.every((b, i) => head[offset + i] === b)
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

const isPng = (h: Uint8Array): boolean =>
  bytes(h, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const isJpeg = (h: Uint8Array): boolean => bytes(h, 0, [0xff, 0xd8, 0xff])
const isGif = (h: Uint8Array): boolean =>
  bytes(h, 0, ascii('GIF87a')) || bytes(h, 0, ascii('GIF89a'))
const isWebp = (h: Uint8Array): boolean => bytes(h, 0, ascii('RIFF')) && bytes(h, 8, ascii('WEBP'))
const isPdf = (h: Uint8Array): boolean => bytes(h, 0, ascii('%PDF-'))
const isZip = (h: Uint8Array): boolean =>
  bytes(h, 0, [0x50, 0x4b, 0x03, 0x04]) || bytes(h, 0, [0x50, 0x4b, 0x05, 0x06])
const is7z = (h: Uint8Array): boolean => bytes(h, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])

/** Plain text: no NUL bytes and valid UTF-8 (a truncated final character is tolerated). */
export function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
    return true
  } catch {
    return false
  }
}

const text = (ext: string, contentType = 'text/plain'): FileType => ({
  ext,
  contentType,
  kind: 'file',
  matches: looksLikeText
})

const OOXML = 'application/vnd.openxmlformats-officedocument'

export const FILE_TYPES: readonly FileType[] = [
  { ext: 'png', contentType: 'image/png', kind: 'image', matches: isPng },
  { ext: 'jpg', contentType: 'image/jpeg', kind: 'image', matches: isJpeg },
  { ext: 'jpeg', contentType: 'image/jpeg', kind: 'image', matches: isJpeg },
  { ext: 'gif', contentType: 'image/gif', kind: 'image', matches: isGif },
  { ext: 'webp', contentType: 'image/webp', kind: 'image', matches: isWebp },
  { ext: 'pdf', contentType: 'application/pdf', kind: 'file', matches: isPdf },
  text('txt'),
  text('log'),
  text('md'),
  text('csv', 'text/csv'),
  text('json', 'application/json'),
  { ext: 'zip', contentType: 'application/zip', kind: 'file', matches: isZip },
  { ext: '7z', contentType: 'application/x-7z-compressed', kind: 'file', matches: is7z },
  { ext: 'docx', contentType: `${OOXML}.wordprocessingml.document`, kind: 'file', matches: isZip },
  { ext: 'xlsx', contentType: `${OOXML}.spreadsheetml.sheet`, kind: 'file', matches: isZip },
  { ext: 'pptx', contentType: `${OOXML}.presentationml.presentation`, kind: 'file', matches: isZip }
]

export const ALLOWED_EXTENSIONS = FILE_TYPES.map((t) => t.ext)

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
}

export function typeForFilename(filename: string): FileType | undefined {
  const ext = extensionOf(filename)
  return FILE_TYPES.find((t) => t.ext === ext)
}

// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069<>:"/\\|?*]/g

/**
 * Display/download name only — the file is stored under an opaque generated id, so this name is
 * never used as a filesystem path.
 */
export function sanitizeFilename(input: string, maxLength = 120): string {
  const base = input.split(/[/\\]/).pop() ?? ''
  let name = base.replace(UNSAFE_NAME_CHARS, '_').replace(/\s+/g, ' ').trim()
  name = name.replace(/^[.\s]+|[.\s]+$/g, '')
  if (name.length > maxLength) {
    const ext = extensionOf(name)
    const keep = ext && ext.length < 12 ? ext.length + 1 : 0
    name = name.slice(0, maxLength - keep) + (keep ? name.slice(-keep) : '')
  }
  return name || 'file'
}

// ---- Image dimensions ----

export interface ImageSize {
  width: number
  height: number
}

const u16be = (h: Uint8Array, o: number): number => (h[o]! << 8) | h[o + 1]!
const u16le = (h: Uint8Array, o: number): number => h[o]! | (h[o + 1]! << 8)
const u24le = (h: Uint8Array, o: number): number => h[o]! | (h[o + 1]! << 8) | (h[o + 2]! << 16)
const u32be = (h: Uint8Array, o: number): number =>
  ((h[o]! << 24) >>> 0) + ((h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!)

/** EXIF orientation (1–8) from a JPEG APP1 segment, or 1 if absent/unreadable. */
function exifOrientation(h: Uint8Array, start: number, length: number): number {
  const exif = start + 4
  if (!bytes(h, exif, ascii('Exif')) || h[exif + 4] !== 0 || h[exif + 5] !== 0) return 1
  const tiff = exif + 6
  const little = bytes(h, tiff, [0x49, 0x49])
  const big = bytes(h, tiff, [0x4d, 0x4d])
  if (!little && !big) return 1
  const r16 = (o: number): number => (little ? u16le(h, o) : u16be(h, o))
  const r32 = (o: number): number =>
    little ? (u16le(h, o) | (u16le(h, o + 2) << 16)) >>> 0 : u32be(h, o)
  const end = Math.min(h.length, start + 2 + length)
  const ifd = tiff + r32(tiff + 4)
  if (ifd + 2 > end) return 1
  const entries = r16(ifd)
  for (let i = 0; i < entries; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) break
    if (r16(entry) === 0x0112) {
      const value = r16(entry + 8)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}

function jpegSize(h: Uint8Array): ImageSize | undefined {
  let o = 2
  let orientation = 1
  while (o + 4 <= h.length) {
    if (h[o] !== 0xff) return undefined
    const marker = h[o + 1]!
    if (marker === 0xff) {
      o++
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2
      continue
    }
    const length = u16be(h, o + 2)
    if (length < 2) return undefined
    if (marker === 0xe1) orientation = exifOrientation(h, o, length)
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (o + 9 > h.length) return undefined
      const height = u16be(h, o + 5)
      const width = u16be(h, o + 7)
      // Orientations 5–8 rotate by 90°: the displayed image is height × width.
      return orientation >= 5 ? { width: height, height: width } : { width, height }
    }
    o += 2 + length
  }
  return undefined
}

function webpSize(h: Uint8Array): ImageSize | undefined {
  if (h.length < 30) return undefined
  const chunk = String.fromCharCode(...h.slice(12, 16))
  if (chunk === 'VP8 ') return { width: u16le(h, 26) & 0x3fff, height: u16le(h, 28) & 0x3fff }
  if (chunk === 'VP8L') {
    const b = h.slice(21, 25)
    return {
      width: 1 + (((b[1]! & 0x3f) << 8) | b[0]!),
      height: 1 + (((b[3]! & 0x0f) << 10) | (b[2]! << 2) | ((b[1]! & 0xc0) >> 6))
    }
  }
  if (chunk === 'VP8X') return { width: 1 + u24le(h, 24), height: 1 + u24le(h, 27) }
  return undefined
}

/** Displayed width/height from the file header, or undefined if it can't be read. */
export function imageSize(contentType: string, h: Uint8Array): ImageSize | undefined {
  let size: ImageSize | undefined
  switch (contentType) {
    case 'image/png':
      size = h.length >= 24 ? { width: u32be(h, 16), height: u32be(h, 20) } : undefined
      break
    case 'image/gif':
      size = h.length >= 10 ? { width: u16le(h, 6), height: u16le(h, 8) } : undefined
      break
    case 'image/jpeg':
      size = jpegSize(h)
      break
    case 'image/webp':
      size = webpSize(h)
      break
  }
  return size && size.width > 0 && size.height > 0 ? size : undefined
}
