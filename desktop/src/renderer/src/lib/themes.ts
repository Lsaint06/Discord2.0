/**
 * Milestone 14: full-app themes. Every palette and ambient artwork is original (CSS + inline
 * SVG drawn for Discord 2.0; no downloaded images). A theme changes:
 * - semantic tokens (surfaces, text roles, links, mentions, borders, hover/selected tints,
 *   scrollbar, default accent) applied as CSS custom properties at the document root;
 * - its material: translucent panels over a gradient backdrop, optional frosted blur;
 * - an ambient art layer behind the app (grid, petals, aurora ribbons, caustics…), optionally
 *   slowly animated. "Reduced" theme effects and reduced motion keep the look but stop motion
 *   and blur.
 *
 * Text contrast is verified by tests (themes.test.ts) against the colors actually composited
 * over each backdrop stop, so no theme can ship with unreadable text.
 */
import { APP_THEMES, type AppThemeId } from '../net/protocol'

export interface ThemePalette {
  rail: string
  secondary: string
  panel: string
  primary: string
  input: string
  floating: string
  textNormal: string
  textStrong: string
  textMuted: string
  textFaint: string
  /** Default accent (a color you picked yourself still wins). */
  accent: string
  /** Links in messages. */
  link: string
  /** Text of @mentions of other people. */
  mention: string
}

export type AmbientId =
  | 'obsidian'
  | 'circuit'
  | 'petals'
  | 'aurora'
  | 'void'
  | 'flare'
  | 'caustics'
  | 'lattice'
  | 'frost'
  | 'horizon'
  | 'canopy'
  | 'ripples'

export interface AppThemeDef {
  id: AppThemeId
  name: string
  description: string
  /** Light or dark base: decides the light/dark details (shadows, mentions, code colors). */
  base: 'dark' | 'light'
  palette: ThemePalette
  /** Gradient behind the app (2–4 stops). Panels become translucent over it. */
  backdrop?: { stops: string[]; angle: number; panelAlpha: number }
  /** Decorative layer between the backdrop and the panels. */
  ambient: AmbientId
  /** The brightest color the ambient art adds (for contrast checks): color at alpha over the backdrop. */
  ambientTint?: { color: string; alpha: number }
  /** The ambient layer drifts slowly (stopped by reduced motion / reduced effects). */
  animated?: boolean
  /** Frosted panels (backdrop blur), dropped in reduced effects. */
  glass?: boolean
  /** Three swatches for the gallery card (backdrop, panel, accent). */
  swatch: [string, string, string]
}

export const APP_THEME_DEFS: readonly AppThemeDef[] = [
  {
    id: 'obsidian',
    name: 'Midnight Obsidian',
    description: 'Polished volcanic glass: deep navy-black with a cool violet edge.',
    base: 'dark',
    palette: {
      rail: '#07080f',
      secondary: '#0e1019',
      panel: '#0b0d15',
      primary: '#13151f',
      input: '#1e2130',
      floating: '#06070c',
      textNormal: '#dfe2ee',
      textStrong: '#f6f7fc',
      textMuted: '#9da2b8',
      textFaint: '#7c8199',
      accent: '#6c5cf5',
      link: '#8fb4ff',
      mention: '#c9c3ff'
    },
    backdrop: { stops: ['#05060b', '#11132a', '#07080f'], angle: 160, panelAlpha: 0.84 },
    ambient: 'obsidian',
    ambientTint: { color: '#6c5cf5', alpha: 0.22 },
    swatch: ['#11132a', '#13151f', '#6c5cf5']
  },
  {
    id: 'cyber',
    name: 'Cyber Neon',
    description: 'Electric cyan and magenta circuitry on a midnight grid.',
    base: 'dark',
    palette: {
      rail: '#050912',
      secondary: '#0a1120',
      panel: '#080e1a',
      primary: '#0d1526',
      input: '#152038',
      floating: '#04070e',
      textNormal: '#d8f3ff',
      textStrong: '#f2fcff',
      textMuted: '#8fb2c6',
      textFaint: '#6f93a8',
      accent: '#22d3ee',
      link: '#67e8f9',
      mention: '#f0abfc'
    },
    backdrop: { stops: ['#030712', '#0b1a33', '#1a0b2e'], angle: 145, panelAlpha: 0.74 },
    ambient: 'circuit',
    ambientTint: { color: '#22d3ee', alpha: 0.3 },
    animated: true,
    swatch: ['#0b1a33', '#0d1526', '#22d3ee']
  },
  {
    id: 'sakura',
    name: 'Sakura Dream',
    description: 'Cherry-blossom pinks with petals drifting past the panels.',
    base: 'light',
    palette: {
      rail: '#f2d9e1',
      secondary: '#fbecf1',
      panel: '#f7e2e9',
      primary: '#fff7fa',
      input: '#f1d7e0',
      floating: '#ffffff',
      textNormal: '#3a2731',
      textStrong: '#1c1016',
      textMuted: '#6b5060',
      textFaint: '#8a6c7c',
      accent: '#c0386b',
      link: '#a3244f',
      mention: '#7f1d48'
    },
    backdrop: { stops: ['#fbe0e8', '#f5cbd9', '#fde8e0'], angle: 150, panelAlpha: 0.8 },
    ambient: 'petals',
    ambientTint: { color: '#e879a0', alpha: 0.55 },
    animated: true,
    swatch: ['#f5cbd9', '#fff7fa', '#c0386b']
  },
  {
    id: 'aurora',
    name: 'Aurora Borealis',
    description: 'Green and violet ribbons of light drifting across a polar night.',
    base: 'dark',
    palette: {
      rail: '#06121a',
      secondary: '#0b1a24',
      panel: '#09161f',
      primary: '#0f1f2b',
      input: '#182f3d',
      floating: '#050e14',
      textNormal: '#dcedf0',
      textStrong: '#f4fdff',
      textMuted: '#9ab8c1',
      textFaint: '#7a9aa4',
      accent: '#3ddc97',
      link: '#7ee8c0',
      mention: '#ede9fe'
    },
    backdrop: { stops: ['#04141a', '#0b3b33', '#1f1a4f', '#08243a'], angle: 135, panelAlpha: 0.7 },
    ambient: 'aurora',
    ambientTint: { color: '#3ddc97', alpha: 0.55 },
    animated: true,
    swatch: ['#0b3b33', '#0f1f2b', '#3ddc97']
  },
  {
    id: 'void',
    name: 'AMOLED Void',
    description: 'True black everywhere: kindest to OLED screens and batteries.',
    base: 'dark',
    palette: {
      rail: '#000000',
      secondary: '#000000',
      panel: '#000000',
      primary: '#000000',
      input: '#121214',
      floating: '#0a0a0b',
      textNormal: '#e4e4e8',
      textStrong: '#ffffff',
      textMuted: '#a2a2ab',
      textFaint: '#7e7e88',
      accent: '#a5a8ff',
      link: '#93c5fd',
      mention: '#c7c9ff'
    },
    ambient: 'void',
    swatch: ['#000000', '#121214', '#a5a8ff']
  },
  {
    id: 'solar',
    name: 'Solar Flare',
    description: 'Charcoal warmed by an amber sunrise burning in the corner.',
    base: 'dark',
    palette: {
      rail: '#160d08',
      secondary: '#20140d',
      panel: '#1c110b',
      primary: '#261810',
      input: '#36231a',
      floating: '#110a06',
      textNormal: '#f3e4da',
      textStrong: '#fff7f1',
      textMuted: '#c7a796',
      textFaint: '#a28676',
      accent: '#ff9a3c',
      link: '#ffc27a',
      mention: '#ffd2a8'
    },
    backdrop: { stops: ['#120905', '#3a1a0c', '#5c2a10'], angle: 210, panelAlpha: 0.78 },
    ambient: 'flare',
    ambientTint: { color: '#ffdc96', alpha: 0.45 },
    animated: true,
    swatch: ['#5c2a10', '#261810', '#ff9a3c']
  },
  {
    id: 'abyss',
    name: 'Ocean Abyss',
    description: 'Teal light rippling down into the deep sea.',
    base: 'dark',
    palette: {
      rail: '#041a22',
      secondary: '#08242e',
      panel: '#061f28',
      primary: '#0a2b36',
      input: '#123d4a',
      floating: '#03141a',
      textNormal: '#d6eef2',
      textStrong: '#f2fdff',
      textMuted: '#93bcc5',
      textFaint: '#74a0a9',
      accent: '#2dd4bf',
      link: '#5eead4',
      mention: '#a5f3fc'
    },
    backdrop: { stops: ['#02121a', '#073846', '#0b4f5c'], angle: 175, panelAlpha: 0.74 },
    ambient: 'caustics',
    ambientTint: { color: '#5eead4', alpha: 0.35 },
    animated: true,
    swatch: ['#073846', '#0a2b36', '#2dd4bf']
  },
  {
    id: 'amethyst',
    name: 'Royal Amethyst',
    description: 'Regal purple velvet with gold filigree.',
    base: 'dark',
    palette: {
      rail: '#120a1e',
      secondary: '#1a1029',
      panel: '#160d24',
      primary: '#1f1431',
      input: '#2c1f44',
      floating: '#0e0818',
      textNormal: '#eae0f7',
      textStrong: '#fbf7ff',
      textMuted: '#b5a3cf',
      textFaint: '#9584ae',
      accent: '#e5b94e',
      link: '#d8b4fe',
      mention: '#f5d98a'
    },
    backdrop: { stops: ['#0d0618', '#2a1250', '#160a2a'], angle: 125, panelAlpha: 0.8 },
    ambient: 'lattice',
    ambientTint: { color: '#e5b94e', alpha: 0.25 },
    swatch: ['#2a1250', '#1f1431', '#e5b94e']
  },
  {
    id: 'glass',
    name: 'Frosted Glass',
    description: 'Bright frosted panels floating over soft pastel light.',
    base: 'light',
    palette: {
      rail: '#e3e9f4',
      secondary: '#eef2f9',
      panel: '#e8edf7',
      primary: '#f8faff',
      input: '#dfe6f2',
      floating: '#ffffff',
      textNormal: '#1f2937',
      textStrong: '#0b1220',
      textMuted: '#4b5568',
      textFaint: '#677184',
      accent: '#3f5bd8',
      link: '#2747c9',
      mention: '#2f45b3'
    },
    backdrop: { stops: ['#dfe9ff', '#f3defc', '#d9f3f0'], angle: 135, panelAlpha: 0.66 },
    ambient: 'frost',
    ambientTint: { color: '#c084fc', alpha: 0.4 },
    glass: true,
    swatch: ['#f3defc', '#f8faff', '#3f5bd8']
  },
  {
    id: 'synthwave',
    name: 'Retro Synthwave',
    description: 'A neon sun setting over an endless magenta grid.',
    base: 'dark',
    palette: {
      rail: '#120821',
      secondary: '#1a0d2f',
      panel: '#160a29',
      primary: '#1f1036',
      input: '#2d1a4b',
      floating: '#0e061a',
      textNormal: '#f0e3fb',
      textStrong: '#fdf8ff',
      textMuted: '#bea6d6',
      textFaint: '#9c86b6',
      accent: '#ff5fc8',
      link: '#ff9be0',
      mention: '#fde68a'
    },
    backdrop: { stops: ['#0f0522', '#3b0f5a', '#7a1f63', '#1a0838'], angle: 180, panelAlpha: 0.78 },
    ambient: 'horizon',
    ambientTint: { color: '#ffd36e', alpha: 0.5 },
    animated: true,
    swatch: ['#7a1f63', '#1f1036', '#ff5fc8']
  },
  {
    id: 'forest',
    name: 'Forest Canopy',
    description: 'Mossy greens under a canopy of leaves.',
    base: 'dark',
    palette: {
      rail: '#0d1810',
      secondary: '#132218',
      panel: '#101d14',
      primary: '#18291d',
      input: '#233829',
      floating: '#0a130d',
      textNormal: '#dbe8dc',
      textStrong: '#f4fbf4',
      textMuted: '#9db7a1',
      textFaint: '#7d9982',
      accent: '#6fd47f',
      link: '#9be7a6',
      mention: '#d9f99d'
    },
    backdrop: { stops: ['#08130b', '#173322', '#0d1c12'], angle: 160, panelAlpha: 0.82 },
    ambient: 'canopy',
    ambientTint: { color: '#bef264', alpha: 0.18 },
    swatch: ['#173322', '#18291d', '#6fd47f']
  },
  {
    id: 'mint',
    name: 'Mint Frost',
    description: 'Crisp, cool and bright, with gentle ripples.',
    base: 'light',
    palette: {
      rail: '#d5ebe4',
      secondary: '#e8f5f1',
      panel: '#dff0ea',
      primary: '#f6fcfa',
      input: '#d6e9e3',
      floating: '#ffffff',
      textNormal: '#1f322d',
      textStrong: '#0b1815',
      textMuted: '#486158',
      textFaint: '#627a72',
      accent: '#0b7a60',
      link: '#06705a',
      mention: '#064e3e'
    },
    backdrop: { stops: ['#e1f5ee', '#cdeee4', '#e6f6f3'], angle: 140, panelAlpha: 0.86 },
    ambient: 'ripples',
    ambientTint: { color: '#0b7a60', alpha: 0.12 },
    swatch: ['#cdeee4', '#f6fcfa', '#0b7a60']
  }
]

/** A theme id from storage or another device; anything unknown means the classic theme. */
export function appThemeById(id: unknown): AppThemeDef | null {
  if (typeof id !== 'string' || !(APP_THEMES as readonly string[]).includes(id)) return null
  return APP_THEME_DEFS.find((t) => t.id === id) ?? null
}

// ---- Color math (WCAG 2.x relative luminance and contrast) ----

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex = (rgb: [number, number, number]): string =>
  `#${rgb
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`

/** `top` at `alpha` over `bottom`. */
export function blend(top: string, bottom: string, alpha: number): string {
  const a = hexToRgb(top)
  const b = hexToRgb(bottom)
  return toHex(
    [0, 1, 2].map((i) => a[i]! * alpha + b[i]! * (1 - alpha)) as [number, number, number]
  )
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Black or white, whichever reads better on `hex` (by actual contrast). */
export function bestTextOn(hex: string): '#000000' | '#ffffff' {
  return contrastRatio('#000000', hex) >= contrastRatio('#ffffff', hex) ? '#000000' : '#ffffff'
}

const rgba = (hex: string, alpha: number): string => {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export type ThemeEffects = 'full' | 'reduced'

/**
 * CSS custom properties for a theme. Surfaces that sit on the backdrop become translucent;
 * floating surfaces (menus, dialogs, popouts) stay opaque.
 */
export function themeVariables(theme: AppThemeDef): Record<string, string> {
  const p = theme.palette
  const alpha = theme.backdrop?.panelAlpha ?? 1
  const surface = (hex: string): string => (alpha < 1 ? rgba(hex, alpha) : hex)
  const tint = theme.base === 'dark' ? '#ffffff' : '#000000'
  const vars: Record<string, string> = {
    '--bg-rail': surface(p.rail),
    '--bg-secondary': surface(p.secondary),
    '--bg-panel': surface(p.panel),
    '--bg-primary': surface(p.primary),
    '--bg-input': p.input,
    '--bg-floating': p.floating,
    '--bg-hover': `color-mix(in srgb, ${p.accent} 10%, ${rgba(tint, 0.06)})`,
    '--bg-active': `color-mix(in srgb, ${p.accent} 18%, ${rgba(tint, 0.1)})`,
    '--border-subtle': rgba(tint, theme.base === 'dark' ? 0.08 : 0.1),
    '--text-normal': p.textNormal,
    '--text-strong': p.textStrong,
    '--text-muted': p.textMuted,
    '--text-faint': p.textFaint,
    '--text-link': p.link,
    '--mention-text': p.mention,
    '--scrollbar-thumb': rgba(theme.base === 'dark' ? p.textFaint : p.textMuted, 0.45),
    '--theme-accent': p.accent
  }
  if (theme.backdrop) {
    vars['--app-backdrop'] =
      `linear-gradient(${theme.backdrop.angle}deg, ${theme.backdrop.stops.join(', ')})`
  }
  return vars
}

/** Every variable a theme may set (to remove them when switching back to classic). */
export const THEME_VARIABLE_NAMES = [
  '--bg-rail',
  '--bg-secondary',
  '--bg-panel',
  '--bg-primary',
  '--bg-input',
  '--bg-floating',
  '--bg-hover',
  '--bg-active',
  '--border-subtle',
  '--text-normal',
  '--text-strong',
  '--text-muted',
  '--text-faint',
  '--text-link',
  '--mention-text',
  '--scrollbar-thumb',
  '--theme-accent',
  '--app-backdrop'
] as const

/** The colors a translucent surface can actually show (over each backdrop stop). */
export function surfaceSamples(theme: AppThemeDef, surface: keyof ThemePalette): string[] {
  const color = theme.palette[surface]
  const backdrop = theme.backdrop
  if (!backdrop) return [color]
  const tint = theme.ambientTint
  // Every backdrop stop, plain and under the ambient art's brightest tint.
  const under = backdrop.stops.flatMap((stop) =>
    tint ? [stop, blend(tint.color, stop, tint.alpha)] : [stop]
  )
  return under.map((bg) => blend(color, bg, backdrop.panelAlpha))
}

// ---- Persistence (themes follow your account when the server supports it) ----

const LOCAL_KEY_PREFIX = 'd2.appTheme.'

/** This device's copy of the theme for one account on one server (used by older servers). */
export function localThemeKey(serverUrl: string, username: string): string {
  return `${LOCAL_KEY_PREFIX}${serverUrl}|${username.toLowerCase()}`
}

export function readLocalTheme(key: string): AppThemeId | null {
  try {
    return appThemeById(localStorage.getItem(key))?.id ?? null
  } catch {
    return null
  }
}

export function writeLocalTheme(key: string, id: AppThemeId | null): void {
  try {
    if (id) localStorage.setItem(key, id)
    else localStorage.removeItem(key)
  } catch {
    // Storage full or unavailable: the theme still applies for this session.
  }
}

// ---- Choices made while the server couldn't save them (servers older than API 6) ----

/** Marks this device's theme as chosen while the server couldn't save it to the account. */
export function writeThemeUnsynced(key: string, unsynced: boolean): void {
  try {
    if (unsynced) localStorage.setItem(`${key}|unsynced`, '1')
    else localStorage.removeItem(`${key}|unsynced`)
  } catch {
    // Unavailable storage: the choice simply isn't carried over to the account later.
  }
}

export function readThemeUnsynced(key: string): boolean {
  try {
    return localStorage.getItem(`${key}|unsynced`) === '1'
  } catch {
    return false
  }
}

/**
 * The theme to show. `server` is the account's saved theme once the server has answered
 * (`undefined` before that, or on servers that can't save themes). A choice made on this device
 * while the server couldn't save it stays until it has been moved to the account, so upgrading
 * the server never resets someone's theme to Classic.
 */
export function resolveAppTheme(
  server: AppThemeId | null | undefined,
  local: AppThemeId | null,
  unsynced: boolean
): AppThemeId | null {
  if (server === undefined) return local
  if (server === null && unsynced) return local
  return server
}

/**
 * Once the server can save themes, what happens to a choice made before it could:
 * 'push' — the account has no theme yet, so this device's choice becomes the account's;
 * 'drop' — the account already has one (picked on another device since), or there's nothing to move;
 * 'wait' — nothing to decide (yet).
 */
export function unsyncedThemeAction(
  server: AppThemeId | null | undefined,
  local: AppThemeId | null,
  unsynced: boolean
): 'wait' | 'push' | 'drop' {
  if (!unsynced || server === undefined) return 'wait'
  return server === null && local !== null ? 'push' : 'drop'
}
