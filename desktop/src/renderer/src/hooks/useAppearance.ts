import { useEffect, useState } from 'react'
import { DEFAULT_ACCENT } from '../data/defaults'
import {
  readableOn,
  resolveReducedMotion,
  resolveTheme,
  type ResolvedTheme
} from '../lib/appearance'
import type { ApiPreferences } from '../net/protocol'

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = (): void => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/**
 * Applies appearance preferences to the document root so every surface (app, modals, popouts,
 * settings) follows them: data-theme, data-density, data-reduced-motion and CSS variables.
 */
export function useAppearance(
  preferences: Pick<ApiPreferences, 'theme' | 'accentColor' | 'density' | 'reducedMotion'>,
  chatFontSize: number,
  /** This device's contrast choice; 'system' follows the OS high-contrast setting. */
  contrast: ContrastPreference = 'system'
): ResolvedTheme {
  const systemLight = useMediaQuery('(prefers-color-scheme: light)')
  const systemReduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  const systemMoreContrast = useMediaQuery('(prefers-contrast: more)')
  const theme = resolveTheme(preferences.theme, systemLight)
  const reduced = resolveReducedMotion(preferences.reducedMotion, systemReduced)
  const moreContrast = contrast === 'on' || (contrast === 'system' && systemMoreContrast)
  const accent = preferences.accentColor ?? DEFAULT_ACCENT

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    root.dataset.density = preferences.density
    root.dataset.reducedMotion = reduced ? 'on' : 'off'
    root.dataset.contrast = moreContrast ? 'more' : 'normal'
    root.style.setProperty('--accent', accent)
    root.style.setProperty('--accent-contrast', readableOn(accent))
    root.style.setProperty('--chat-font-size', `${chatFontSize}px`)
  }, [theme, reduced, moreContrast, accent, preferences.density, chatFontSize])

  // Back to the defaults when signed out (the sign-in screen uses the default look).
  useEffect(
    () => () => {
      const root = document.documentElement
      delete root.dataset.theme
      delete root.dataset.density
      delete root.dataset.reducedMotion
      delete root.dataset.contrast
      for (const name of ['--accent', '--accent-contrast', '--chat-font-size']) {
        root.style.removeProperty(name)
      }
    },
    []
  )

  return theme
}

export type ContrastPreference = 'system' | 'on' | 'off'

/** Whether animations should be reduced (your preference, or the OS setting for 'system'). */
export function useReducedMotion(preference: ApiPreferences['reducedMotion']): boolean {
  const systemReduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  return resolveReducedMotion(preference, systemReduced)
}
