/**
 * Milestone 14: profile customization registry (all original designs, all free).
 *
 * The server only stores ids from the allow-lists in net/protocol.ts; this file describes how
 * each id looks. An id this build doesn't know (a newer client saved it, or a design was
 * retired) is ignored, never an error.
 */
import {
  AVATAR_DECORATIONS,
  BANNER_PRESETS,
  NAME_STYLES,
  PROFILE_EFFECTS,
  type ApiProfileStyle,
  type AvatarDecorationId,
  type BannerPresetId,
  type NameStyleId,
  type ProfileEffectId
} from '../net/protocol'

export interface DesignInfo {
  name: string
  description: string
}

export const DECORATION_INFO: Record<AvatarDecorationId, DesignInfo> = {
  'violet-halo': { name: 'Violet Halo', description: 'A glowing violet energy ring.' },
  'celestial-ring': {
    name: 'Celestial Ring',
    description: 'A gold ring set with twinkling stars.'
  },
  'frost-shards': { name: 'Frost Shards', description: 'Ice crystals catching the light.' },
  'neon-pulse': { name: 'Neon Pulse', description: 'A cyan neon ring that pulses outward.' },
  'pixel-hearts': { name: 'Pixel Hearts', description: 'Little 8-bit hearts bobbing around you.' },
  'petal-fall': { name: 'Petal Fall', description: 'Cherry blossoms drifting past.' },
  'star-orbit': { name: 'Star Orbit', description: 'Tiny stars circling in orbit.' },
  'ember-sparks': { name: 'Ember Sparks', description: 'Warm sparks rising from a glowing rim.' },
  'circuit-trace': { name: 'Circuit Trace', description: 'Light racing along circuit lines.' },
  'moon-orbit': { name: 'Moonlight Orbit', description: 'A crescent moon on a silver path.' },
  'prism-ribbon': { name: 'Prism Ribbon', description: 'A turning band of refracted color.' },
  'cosmic-comet': { name: 'Cosmic Comet', description: 'A comet sweeping around you.' }
}

export const EFFECT_INFO: Record<ProfileEffectId, DesignInfo & { tech: 'css' | 'canvas' }> = {
  'aurora-shimmer': {
    name: 'Aurora Shimmer',
    description: 'Northern-light ribbons wash over your profile.',
    tech: 'css'
  },
  'meteor-shower': {
    name: 'Meteor Shower',
    description: 'Shooting stars streak across.',
    tech: 'canvas'
  },
  'sakura-drift': {
    name: 'Sakura Drift',
    description: 'Cherry-blossom petals tumble down.',
    tech: 'canvas'
  },
  'neon-wave': { name: 'Neon Wave', description: 'Neon sine waves glide past.', tech: 'css' },
  'galaxy-dust': {
    name: 'Galaxy Dust',
    description: 'Stardust swirls around a bright core.',
    tech: 'canvas'
  },
  'golden-sparks': {
    name: 'Golden Sparks',
    description: 'A burst of golden sparks rains down.',
    tech: 'canvas'
  },
  'holo-scan': {
    name: 'Holographic Scan',
    description: 'A holographic scanline sweeps the card.',
    tech: 'css'
  },
  'winter-snow': { name: 'Winter Snow', description: 'Soft snow falls gently.', tech: 'canvas' }
}

export const BANNER_INFO: Record<BannerPresetId, DesignInfo> = {
  aurora: { name: 'Aurora', description: 'Ribbons of polar light.' },
  starfield: { name: 'Starfield', description: 'A twinkling night sky.' },
  waves: { name: 'Waves', description: 'Layered rolling waves.' },
  sunset: { name: 'Sunset', description: 'A warm dusk with drifting clouds.' },
  nebula: { name: 'Nebula', description: 'Colorful gas clouds in deep space.' },
  grid: { name: 'Neon Grid', description: 'A retro horizon grid.' },
  bokeh: { name: 'Bokeh', description: 'Soft out-of-focus lights.' },
  prism: { name: 'Prism', description: 'Refracted rainbow light.' }
}

export const NAME_STYLE_INFO: Record<NameStyleId, DesignInfo> = {
  gradient: { name: 'Gradient', description: 'Your profile colors (or your accent).' },
  gold: { name: 'Warm Metallic', description: 'Polished gold.' },
  silver: { name: 'Silver', description: 'Brushed silver.' },
  neon: { name: 'Neon', description: 'A soft neon glow.' },
  aurora: { name: 'Aurora', description: 'Green to violet, like the northern lights.' },
  holo: { name: 'Holographic', description: 'Iridescent foil.' }
}

/** Ready-made profile gradients (2–3 colors) for the Profile Studio. */
export const GRADIENT_PRESETS: { name: string; colors: string[]; angle: number }[] = [
  { name: 'Twilight', colors: ['#3b2a8f', '#c2457a'], angle: 160 },
  { name: 'Lagoon', colors: ['#0f766e', '#38bdf8'], angle: 135 },
  { name: 'Ember', colors: ['#7c2d12', '#f97316', '#fbbf24'], angle: 200 },
  { name: 'Forest', colors: ['#14532d', '#65a30d'], angle: 170 },
  { name: 'Candy', colors: ['#f472b6', '#a78bfa', '#60a5fa'], angle: 120 },
  { name: 'Midnight', colors: ['#0f172a', '#312e81'], angle: 180 },
  { name: 'Peach', colors: ['#fdba74', '#f9a8d4'], angle: 140 },
  { name: 'Aurora', colors: ['#064e3b', '#10b981', '#7c3aed'], angle: 150 }
]

const known = <T extends string>(list: readonly T[], id: unknown): T | null =>
  typeof id === 'string' && (list as readonly string[]).includes(id) ? (id as T) : null

export const decorationOf = (
  style: ApiProfileStyle | null | undefined
): AvatarDecorationId | null => known(AVATAR_DECORATIONS, style?.decoration)
export const effectOf = (style: ApiProfileStyle | null | undefined): ProfileEffectId | null =>
  known(PROFILE_EFFECTS, style?.effect)
export const bannerPresetOf = (style: ApiProfileStyle | null | undefined): BannerPresetId | null =>
  known(BANNER_PRESETS, style?.banner)
export const nameStyleOf = (style: ApiProfileStyle | null | undefined): NameStyleId | null =>
  known(NAME_STYLES, style?.nameStyle)

const HEX = /^#[0-9a-f]{6}$/i

/** The profile's gradient colors (only valid ones; 0–3). */
export function gradientColors(style: ApiProfileStyle | null | undefined): string[] {
  return (style?.colors ?? []).filter((c) => HEX.test(c)).slice(0, 3)
}

/** CSS background for the profile card, or null when the profile has no gradient. */
export function profileGradientCss(style: ApiProfileStyle | null | undefined): string | null {
  const colors = gradientColors(style)
  if (colors.length === 0) return null
  if (colors.length === 1) return colors[0]!
  const angle = Number.isInteger(style?.angle) ? style!.angle : 180
  return `linear-gradient(${angle}deg, ${colors.join(', ')})`
}

/** A normalized style to save: empty → null (the server does the same). */
export function cleanStyle(style: ApiProfileStyle): ApiProfileStyle | null {
  const clean: ApiProfileStyle = {
    colors: gradientColors(style).map((c) => c.toLowerCase()),
    angle: Math.min(359, Math.max(0, Math.round(style.angle || 0))),
    decoration: decorationOf(style),
    effect: effectOf(style),
    banner: bannerPresetOf(style),
    nameStyle: nameStyleOf(style)
  }
  const empty =
    clean.colors.length === 0 &&
    !clean.decoration &&
    !clean.effect &&
    !clean.banner &&
    !clean.nameStyle
  return empty ? null : clean
}

export const EMPTY_STYLE: ApiProfileStyle = {
  colors: [],
  angle: 180,
  decoration: null,
  effect: null,
  banner: null,
  nameStyle: null
}

export function sameStyle(a: ApiProfileStyle | null, b: ApiProfileStyle | null): boolean {
  return JSON.stringify(a ? cleanStyle(a) : null) === JSON.stringify(b ? cleanStyle(b) : null)
}

/** How long a profile effect plays each time (kept under 5 s: WCAG 2.2.2 needs no pause control). */
export const EFFECT_DURATION_MS = 4500
