/** Layout math for inline images (pure). */

/** Display size that fits the box without upscaling; space is reserved before the image loads. */
export function fitBox(
  width: number | undefined,
  height: number | undefined,
  maxW: number,
  maxH: number
): { width: number; height: number } {
  if (!width || !height) return { width: maxW, height: Math.round(maxW * 0.5625) }
  const scale = Math.min(1, maxW / width, maxH / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}
