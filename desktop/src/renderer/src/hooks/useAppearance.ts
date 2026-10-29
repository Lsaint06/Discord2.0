import { useEffect, useState } from 'react'
import { DEFAULT_ACCENT } from '../data/defaults'
import {
  readableOn,
  resolveReducedMotion,
  resolveTheme,
  type ResolvedTheme
} from '../lib/appearance'
import {
  bestTextOn,
  THEME_VARIABLE_NAMES,
  themeVariables,
  type AppThemeDef,
  type ThemeEffects
} from '../lib/themes'
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
 * Milestone 14: a full-app theme (lib/themes.ts) replaces the surface/text tokens and adds an
 * ambient layer; `themeEffects: 'reduced'` keeps its colors but drops motion and blur.
 */
export function useAppearance(
  preferences: Pick<ApiPreferences, 'theme' | 'accentColor' | 'density' | 'reducedMotion'>,
  chatFontSize: number,
  /** This device's contrast choice; 'system' follows the OS high-contrast setting. */
  contrast: ContrastPreference = 'system',
  appTheme: AppThemeDef | null = null,
  themeEffects: ThemeEffects = 'full'
): ResolvedTheme {
  const systemLight = useMediaQuery('(prefers-color-scheme: light)')
  const systemReduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  const systemMoreContrast = useMediaQuery('(prefers-contrast: more)')
  const theme = appTheme ? appTheme.base : resolveTheme(preferences.theme, systemLight)
  const reduced = resolveReducedMotion(preferences.reducedMotion, systemReduced)
  const moreContrast = contrast === 'on' || (contrast === 'system' && systemMoreContrast)
  // Your own accent wins; otherwise the theme's; otherwise the default.
  const accent = preferences.accentColor ?? appTheme?.palette.accent ?? DEFAULT_ACCENT
  const accentText = appTheme ? bestTextOn(accent) : readableOn(accent)

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    root.dataset.density = preferences.density
    root.dataset.reducedMotion = reduced ? 'on' : 'off'
    root.dataset.contrast = moreContrast ? 'more' : 'normal'
    root.style.setProperty('--accent', accent)
    root.style.setProperty('--accent-contrast', accentText)
    root.style.setProperty('--chat-font-size', `${chatFontSize}px`)
  }, [theme, reduced, moreContrast, accent, accentText, preferences.density, chatFontSize])

  useEffect(() => {
    const root = document.documentElement
    for (const name of THEME_VARIABLE_NAMES) root.style.removeProperty(name)
    if (!appTheme) {
      delete root.dataset.appTheme
      delete root.dataset.themeEffects
      delete root.dataset.glass
      return
    }
    for (const [name, value] of Object.entries(themeVariables(appTheme))) {
      root.style.setProperty(name, value)
    }
    root.dataset.appTheme = appTheme.id
    root.dataset.themeEffects = themeEffects
    if (appTheme.glass) root.dataset.glass = 'on'
    else delete root.dataset.glass
  }, [appTheme, themeEffects])

  // Back to the defaults when signed out (the sign-in screen uses the default look).
  useEffect(
    () => () => {
      const root = document.documentElement
      delete root.dataset.theme
      delete root.dataset.density
      delete root.dataset.reducedMotion
      delete root.dataset.contrast
      delete root.dataset.appTheme
      delete root.dataset.themeEffects
      delete root.dataset.glass
      for (const name of [
        '--accent',
        '--accent-contrast',
        '--chat-font-size',
        ...THEME_VARIABLE_NAMES
      ]) {
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
