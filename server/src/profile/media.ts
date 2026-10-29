/**
 * Profile pictures and banners.
 *
 * Every upload is decoded and **re-encoded** by sharp (libvips) into fixed-size WebP files:
 * - the input must be a PNG, JPEG, WebP or GIF by its magic bytes (the file name and the
 *   client's Content-Type are ignored), and the decoder must agree with that format;
 * - libvips refuses images above the pixel limit (decompression bombs) and fails on corrupt data;
 * - EXIF orientation is applied, then all metadata (EXIF, GPS, XMP, ICC, comments) is dropped
 *   because the output is a freshly encoded WebP without metadata;
 * - animated GIF/WebP are flattened to their first frame, unless the caller keeps the animation\n *   (Milestone 14): then every frame is re-encoded and a still first frame is stored too.
 * The original upload is never stored or served, so polyglot/malformed files can't reach other
 * clients. Files are named by random server ids and live inside the persistent data volume.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, mkdirSync, type ReadStream } from 'node:fs'
import { readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Metadata, Sharp } from 'sharp'
import {
  ANIMATED_PROFILE_IMAGE_SIZES,
  CUSTOMIZATION_LIMITS,
  LIMITS,
  PROFILE_IMAGE_SIZES,
  type ProfileImageKind
} from '../protocol.js'

const ID_SHAPE = /^[a-f0-9]{32}$/

export function isProfileMediaId(id: unknown): id is string {
  return typeof id === 'string' && ID_SHAPE.test(id)
}

export type ProfileImageSize = 'full' | 'small' | 'still'

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
  /** Animated images only: the first frame, still (served as size 'still'). */
  still?: Buffer
  animated: boolean
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

/** A crop rectangle in source pixels (after EXIF orientation), chosen in the app's cropper. */
export interface CropRect {
  left: number
  top: number
  width: number
  height: number
}

export interface ProcessOptions {
  /** Keep GIF/WebP animation (Milestone 14). Otherwise animations are flattened to frame 1. */
  keepAnimation?: boolean
  /** Crop to this rectangle before resizing (otherwise: centred cover crop). */
  crop?: CropRect | null
}

const tooLarge = (): ProfileImageError =>
  new ProfileImageError(
    'too_large',
    `Images can be at most ${LIMITS.profileImageMaxPixels / 1_000_000} megapixels.`
  )

/** The crop must lie inside the image, keep the target's shape (±3%) and meet the minimum size. */
function checkCrop(kind: ProfileImageKind, crop: CropRect, w: number, h: number): CropRect {
  const ints = [crop.left, crop.top, crop.width, crop.height]
  const min =
    kind === 'avatar'
      ? { width: LIMITS.avatarMinSize, height: LIMITS.avatarMinSize }
      : { width: LIMITS.bannerMinWidth, height: LIMITS.bannerMinHeight }
  const target = PROFILE_IMAGE_SIZES[kind].full
  const ratio = crop.width / crop.height
  const wanted = target.width / target.height
  if (
    !ints.every((n) => Number.isInteger(n) && n >= 0) ||
    crop.left + crop.width > w ||
    crop.top + crop.height > h ||
    crop.width < min.width ||
    crop.height < min.height ||
    Math.abs(ratio - wanted) / wanted > 0.03
  ) {
    throw new ProfileImageError('unreadable', 'The selected area doesn’t fit this image.')
  }
  return crop
}

/**
 * Validates and re-encodes one profile image. `input` is the path of the uploaded temp file and
 * `head` its first bytes. Throws ProfileImageError for anything unacceptable.
 *
 * With `keepAnimation`, an animated GIF/WebP stays animated: every frame is cropped/resized and
 * re-encoded as an animated WebP (frame count and total pixels are bounded before decoding),
 * and a still first frame is stored next to it for reduced motion and lists.
 */
export async function processProfileImage(
  kind: ProfileImageKind,
  input: string,
  head: Uint8Array,
  options: ProcessOptions = {}
): Promise<ProcessedImage> {
  const format = sniffImageFormat(head)
  if (!format) {
    throw new ProfileImageError('unsupported_type', 'Use a PNG, JPEG, WebP or GIF image.')
  }
  return gate.run(async () => {
    const open = (animated = false): Sharp =>
      sharp(input, {
        limitInputPixels: animated ? CUSTOMIZATION_LIMITS.animatedMaxPixels : LIMITS.profileImageMaxPixels,
        failOn: 'error',
        animated,
        sequentialRead: true
      })

    let meta: Metadata
    try {
      meta = await open().metadata()
    } catch (err) {
      if (/pixel limit/i.test(String((err as Error)?.message))) throw tooLarge()
      throw new ProfileImageError('unreadable', 'This image could not be read.')
    }
    // The decoder must agree with the magic bytes (no format confusion).
    if (meta.format !== format) {
      throw new ProfileImageError('unsupported_type', 'The image’s contents don’t match its type.')
    }
    const width = meta.width ?? 0
    const height = meta.height ?? 0
    if (width * height > LIMITS.profileImageMaxPixels) throw tooLarge()
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
    const crop = options.crop ? checkCrop(kind, options.crop, w, h) : null

    const pages = meta.pages ?? 1
    const animated =
      Boolean(options.keepAnimation) && pages > 1 && (format === 'gif' || format === 'webp')
    if (animated) {
      if (pages > CUSTOMIZATION_LIMITS.animatedMaxFrames) {
        throw new ProfileImageError(
          'too_large',
          `Animations can have at most ${CUSTOMIZATION_LIMITS.animatedMaxFrames} frames.`
        )
      }
      if (width * height * pages > CUSTOMIZATION_LIMITS.animatedMaxPixels) {
        throw new ProfileImageError(
          'too_large',
          'This animation is too large. Use a shorter or smaller one.'
        )
      }
    }

    const shape = (img: Sharp, target: { width: number; height: number }): Sharp => {
      const oriented = img.rotate() // apply EXIF orientation
      return (crop ? oriented.extract(crop) : oriented).resize(target.width, target.height, {
        fit: 'cover',
        position: 'centre'
      })
    }
    const still = (target: { width: number; height: number }): Promise<Buffer> =>
      shape(open(), target)
        .webp({ quality: 86, effort: 4, smartSubsample: true })
        .timeout({ seconds: 20 })
        .toBuffer()
    const moving = (target: { width: number; height: number }): Promise<Buffer> =>
      shape(open(true), target)
        .webp({ quality: 80, effort: 4, smartSubsample: true, loop: 0 })
        .timeout({ seconds: 60 })
        .toBuffer()

    let result: ProcessedImage
    try {
      if (animated) {
        const sizes = ANIMATED_PROFILE_IMAGE_SIZES[kind]
        const full = await moving(sizes.full)
        if (full.length > CUSTOMIZATION_LIMITS.animatedMaxOutputBytes) {
          throw new ProfileImageError(
            'too_large',
            'This animation is too large. Use a shorter or smaller one.'
          )
        }
        result = {
          full,
          small: await moving(sizes.small),
          still: await still(PROFILE_IMAGE_SIZES[kind].full),
          animated: true,
          width: sizes.full.width,
          height: sizes.full.height,
          sha256: createHash('sha256').update(full).digest('hex')
        }
      } else {
        const sizes = PROFILE_IMAGE_SIZES[kind]
        const full = await still(sizes.full)
        result = {
          full,
          small: await still(sizes.small),
          animated: false,
          width: sizes.full.width,
          height: sizes.full.height,
          sha256: createHash('sha256').update(full).digest('hex')
        }
      }
    } catch (err) {
      if (err instanceof ProfileImageError) throw err
      throw new ProfileImageError('unreadable', 'This image could not be processed.')
    }
    return result
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
    const name = size === 'full' ? `${id}.webp` : `${id}.${size}.webp`
    return join(this.root, id.slice(0, 2), name)
  }

  newId(): string {
    return randomBytes(16).toString('hex')
  }

  /** Writes every size (temp file + atomic rename, so readers never see partial files). */
  async save(id: string, image: ProcessedImage): Promise<void> {
    mkdirSync(join(this.root, id.slice(0, 2)), { recursive: true })
    const files: [ProfileImageSize, Buffer][] = [
      ['full', image.full],
      ['small', image.small]
    ]
    if (image.still) files.push(['still', image.still])
    for (const [size, data] of files) {
      const target = this.pathFor(id, size)
      const tmp = `${target}.${randomBytes(6).toString('hex')}.part`
      await writeFile(tmp, data, { flag: 'wx' })
      await rename(tmp, target)
    }
  }

  async remove(id: string | null | undefined): Promise<void> {
    if (!isProfileMediaId(id)) return
    await Promise.all(
      (['full', 'small', 'still'] as const).map((size) =>
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
