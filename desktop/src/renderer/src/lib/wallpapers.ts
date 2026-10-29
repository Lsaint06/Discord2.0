/**
 * Milestone 14: optional chat wallpapers. Original CSS patterns drawn in the theme's muted text
 * color at low strength, so they follow every theme and never fight the text. Device-only:
 * nothing is uploaded or shared.
 */
export const CHAT_WALLPAPERS = [
  { id: 'dots', name: 'Dots' },
  { id: 'grid', name: 'Blueprint' },
  { id: 'diagonal', name: 'Pinstripe' },
  { id: 'waves', name: 'Scallops' },
  { id: 'confetti', name: 'Confetti' },
  { id: 'circuit', name: 'Circuit' }
] as const

export type ChatWallpaperId = (typeof CHAT_WALLPAPERS)[number]['id']

export const DEFAULT_WALLPAPER_INTENSITY = 50
/** Strength of the pattern ink at 100% intensity (share of the muted text color). */
export const MAX_WALLPAPER_INK = 0.2

export function parseWallpaper(value: unknown): ChatWallpaperId | null {
  return CHAT_WALLPAPERS.find((w) => w.id === value)?.id ?? null
}

export function parseWallpaperIntensity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WALLPAPER_INTENSITY
  return Math.min(100, Math.max(10, Math.round(value)))
}

/** Share of the muted text color used for the pattern ink (0.02–0.2). */
export function wallpaperInk(intensity: number): number {
  return Math.round(MAX_WALLPAPER_INK * (parseWallpaperIntensity(intensity) / 100) * 1000) / 1000
}
