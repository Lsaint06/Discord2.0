import { createContext } from 'react'

/** What the server offers for GIFs (from /api/meta); null = no GIF picker. */
export interface GifSupport {
  provider: string
  attribution: { text: string; url: string }
}

export const GifContext = createContext<GifSupport | null>(null)

/** The resolved "reduce motion" preference (still images instead of animation). */
export const ReducedMotionContext = createContext(false)
