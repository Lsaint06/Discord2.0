/**
 * Profile pictures and banners.
 *
 * Every upload is decoded and **re-encoded** by sharp (libvips) into fixed-size WebP files:
 * - the input must be a PNG, JPEG, WebP or GIF by its magic bytes (the file name and the
 *   client's Content-Type are ignored), and the decoder must agree with that format;
 * - libvips refuses images above the pixel limit (decompression bombs) and fails on corrupt data;
 * - EXIF orientation is applied, then all metadata (EXIF, GPS, XMP, ICC, comments) is dropped
 *   because the output is a freshly encoded WebP without metadata;
 * - animated GIF/WebP are flattened to their first frame.
 * The original upload is never stored or served, so polyglot/malformed files can't reach other
 * clients. Files are named by random server ids and live inside the persistent data volume.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, mkdirSync, type ReadStream } from 'node:fs'
import { readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Metadata, Sharp } from 'sharp'
import { LIMITS, PROFILE_IMAGE_SIZES, type ProfileImageKind } from '../protocol.js'

const ID_SHAPE = /^[a-f0-9]{32}$/

export function isProfileMediaId(id: unknown): id is string {
  return typeof id === 'string' && ID_SHAPE.test(id)
}

export type ProfileImageSize = 'full' | 'small'

/** Raised for images we refuse; `code` maps to an HTTP error in the route. */
export class ProfileImageError extends Error {
  constructor(
    readonly code: 'unsupported_type' | 'too_small' | 'too_large' | 'unreadable' | 'busy',
    message: string
  ) {
    super(message)
  }
}

const bytes = (head: Uint8Array, offset: number, sig: number[]): boolean =>
  head.length >= offset + sig.length && sig.every((b, i) => head[offset + i] === b)
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

/** Detects the format from the first bytes only. */
export function sniffImageFormat(head: Uint8Array): 'png' | 'jpeg' | 'webp' | 'gif' | null {
  if (bytes(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (bytes(head, 0, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (bytes(head, 0, ascii('RIFF')) && bytes(head, 8, ascii('WEBP'))) return 'webp'
  if (bytes(head, 0, ascii('GIF87a')) || bytes(head, 0, ascii('GIF89a'))) return 'gif'
  return null
}

export interface ProcessedImage {
  full: Buffer
  small: Buffer
  width: number
  height: number
  sha256: string
}

/** At most `concurrency` images are decoded at once (memory on the Jetson); a few may queue. */
class ImageGate {
  private active = 0
  private readonly queue: (() => void)[] = []
  constructor(
    private readonly concurrency: number,
    private readonly maxQueue: number
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.queue.length >= this.maxQueue) {
        throw new ProfileImageError('busy', 'The server is busy processing images. Try again shortly.')
      }
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}

// libvips: no operation cache (inputs are never reused) and a small thread pool per image.
sharp.cache(false)
sharp.concurrency(2)

const gate = new ImageGate(2, 8)

/**
 * Validates and re-encodes one profile image. `input` is the path of the uploaded temp file and
 * `head` its first bytes. Throws ProfileImageError for anything unacceptable.
 */
export async function processProfileImage(
  kind: ProfileImageKind,
  input: string,
  head: Uint8Array
): Promise<ProcessedImage> {
  const format = sniffImageFormat(head)
  if (!format) {
    throw new ProfileImageError('unsupported_type', 'Use a PNG, JPEG, WebP or GIF image.')
  }
  return gate.run(async () => {
    const open = (): Sharp =>
      sharp(input, {
        limitInputPixels: LIMITS.profileImageMaxPixels,
        failOn: 'error',
        animated: false,
        sequentialRead: true
      })

    let meta: Metadata
    try {
      meta = await open().metadata()
    } catch (err) {
      if (/pixel limit/i.test(String((err as Error)?.message))) {
        throw new ProfileImageError(
          'too_large',
          `Images can be at most ${LIMITS.profileImageMaxPixels / 1_000_000} megapixels.`
        )
      }
      throw new ProfileImageError('unreadable', 'This image could not be read.')
    }
    // The decoder must agree with the magic bytes (no format confusion).
    if (meta.format !== format) {
      throw new ProfileImageError('unsupported_type', 'The image’s contents don’t match its type.')
    }
    const width = meta.width ?? 0
    const height = meta.height ?? 0
    if (width * height > LIMITS.profileImageMaxPixels) {
      throw new ProfileImageError(
        'too_large',
        `Images can be at most ${LIMITS.profileImageMaxPixels / 1_000_000} megapixels.`
      )
    }
    // Orientation 5–8 swaps width and height.
    const swap = (meta.orientation ?? 1) >= 5
    const w = swap ? height : width
    const h = swap ? width : height
    const tooSmall =
      kind === 'avatar'
        ? w < LIMITS.avatarMinSize || h < LIMITS.avatarMinSize
        : w < LIMITS.bannerMinWidth || h < LIMITS.bannerMinHeight
    if (tooSmall) {
      throw new ProfileImageError(
        'too_small',
        kind === 'avatar'
          ? `Profile pictures must be at least ${LIMITS.avatarMinSize}×${LIMITS.avatarMinSize} pixels.`
          : `Banners must be at least ${LIMITS.bannerMinWidth}×${LIMITS.bannerMinHeight} pixels.`
      )
    }

    const sizes = PROFILE_IMAGE_SIZES[kind]
    const encode = (target: { width: number; height: number }): Promise<Buffer> =>
      open()
        .rotate() // apply EXIF orientation
        .resize(target.width, target.height, { fit: 'cover', position: 'centre' })
        .webp({ quality: 86, effort: 4, smartSubsample: true })
        .timeout({ seconds: 20 })
        .toBuffer()
    try {
      const full = await encode(sizes.full)
      const small = await encode(sizes.small)
      return {
        full,
        small,
        width: sizes.full.width,
        height: sizes.full.height,
        sha256: createHash('sha256').update(full).digest('hex')
      }
    } catch {
      throw new ProfileImageError('unreadable', 'This image could not be processed.')
    }
  })
}

/**
 * Processed files on disk:
 *   <root>/<id[0..2]>/<id>.webp        full size
 *   <root>/<id[0..2]>/<id>.small.webp  thumbnail
 * Rows in `profile_media` are the source of truth; files without a row are swept.
 */
export class ProfileMediaStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true })
  }

  pathFor(id: string, size: ProfileImageSize): string {
    if (!isProfileMediaId(id)) throw new Error('invalid profile media id')
    return join(this.root, id.slice(0, 2), size === 'full' ? `${id}.webp` : `${id}.small.webp`)
  }

  newId(): string {
    return randomBytes(16).toString('hex')
  }

  /** Writes both sizes (temp file + atomic rename, so readers never see partial files). */
  async save(id: string, image: ProcessedImage): Promise<void> {
    mkdirSync(join(this.root, id.slice(0, 2)), { recursive: true })
    for (const [size, data] of [
      ['full', image.full],
      ['small', image.small]
    ] as const) {
      const target = this.pathFor(id, size)
      const tmp = `${target}.${randomBytes(6).toString('hex')}.part`
      await writeFile(tmp, data, { flag: 'wx' })
      await rename(tmp, target)
    }
  }

  async remove(id: string | null | undefined): Promise<void> {
    if (!isProfileMediaId(id)) return
    await Promise.all(
      (['full', 'small'] as const).map((size) =>
        unlink(this.pathFor(id, size)).catch(() => undefined)
      )
    )
  }

  /** Opens a file for streaming; rejects if it is missing. */
  async open(id: string, size: ProfileImageSize): Promise<{ stream: ReadStream; size: number }> {
    const path = this.pathFor(id, size)
    const info = await stat(path)
    const stream = createReadStream(path)
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve())
      stream.once('error', reject)
    })
    return { stream, size: info.size }
  }

  /** Deletes files whose id has no row and abandoned temp files, when older than `graceMs`. */
  async sweep(referenced: Set<string>, graceMs: number, now = Date.now()): Promise<number> {
    let removed = 0
    for (const shard of await readdir(this.root).catch(() => [] as string[])) {
      if (!/^[a-f0-9]{2}$/.test(shard)) continue
      const dir = join(this.root, shard)
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        const id = name.slice(0, 32)
        if (referenced.has(id) && !name.endsWith('.part')) continue
        const info = await stat(join(dir, name)).catch(() => undefined)
        if (info && now - info.mtimeMs > graceMs) {
          await rm(join(dir, name), { force: true })
          removed++
        }
      }
    }
    return removed
  }
}
