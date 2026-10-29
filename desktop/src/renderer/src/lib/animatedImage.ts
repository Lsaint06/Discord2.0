/**
 * Milestone 14: is a picked GIF/WebP animated? (The cropper keeps animations by sending the
 * original file plus the crop; still images are cropped and re-encoded here as before.) The
 * server decides again from the decoded file — this only picks the upload path.
 */

/** GIF with more than one image frame. */
export function isAnimatedGif(bytes: Uint8Array): boolean {
  if (bytes.length < 13) return false
  const sig = String.fromCharCode(...bytes.subarray(0, 6))
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return false
  let i = 13
  const packed = bytes[10]!
  if (packed & 0x80) i += 3 * (1 << ((packed & 0x07) + 1)) // global color table
  let frames = 0
  while (i < bytes.length) {
    const block = bytes[i]!
    if (block === 0x2c) {
      // Image descriptor: 10 bytes, optional local color table, LZW code size, data blocks.
      frames++
      if (frames > 1) return true
      if (i + 10 > bytes.length) return false
      const local = bytes[i + 9]!
      i += 10
      if (local & 0x80) i += 3 * (1 << ((local & 0x07) + 1))
      i += 1
      i = skipSubBlocks(bytes, i)
    } else if (block === 0x21) {
      i = skipSubBlocks(bytes, i + 2)
    } else {
      return false // trailer (0x3b) or something unexpected
    }
  }
  return false
}

function skipSubBlocks(bytes: Uint8Array, start: number): number {
  let i = start
  while (i < bytes.length) {
    const size = bytes[i]!
    i += 1
    if (size === 0) break
    i += size
  }
  return i
}

/** WebP with the animation flag (VP8X) or an ANIM chunk. */
export function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 21) return false
  const ascii = (from: number, to: number): string =>
    String.fromCharCode(...bytes.subarray(from, to))
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WEBP') return false
  if (ascii(12, 16) !== 'VP8X') return false
  return (bytes[20]! & 0x02) !== 0
}

export async function isAnimatedImageFile(file: Blob): Promise<boolean> {
  if (file.type !== 'image/gif' && file.type !== 'image/webp') return false
  // GIF frames can be anywhere; read up to 4 MB (enough to find a second frame in practice).
  const head = new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer())
  return file.type === 'image/gif' ? isAnimatedGif(head) : isAnimatedWebp(head)
}
