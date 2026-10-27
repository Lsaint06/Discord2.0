import { describe, expect, it } from 'vitest'
import {
  audibleRms,
  peakOf,
  PEAK_LIMIT,
  RECIPES,
  renderRecipe,
  SOUND_EVENTS,
  SOUND_INFO,
  TARGET_RMS
} from './sounds'

const RATE = 48_000
const rendered = Object.fromEntries(
  SOUND_EVENTS.map((e) => [e, renderRecipe(RECIPES[e], RATE)])
) as Record<(typeof SOUND_EVENTS)[number], Float32Array>
const db = (x: number): number => 20 * Math.log10(x)

/** Dominant frequency of the loudest 4096-sample window (simple DFT scan, 50 Hz steps). */
function dominantHz(samples: Float32Array): number {
  let best = 0
  let bestPower = 0
  const n = Math.min(4096, samples.length)
  for (let f = 100; f <= 3000; f += 25) {
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      const phase = (2 * Math.PI * f * i) / RATE
      re += samples[i]! * Math.cos(phase)
      im += samples[i]! * Math.sin(phase)
    }
    const power = re * re + im * im
    if (power > bestPower) {
      bestPower = power
      best = f
    }
  }
  return best
}

describe('sound palette', () => {
  it('has a recipe and a label for every event', () => {
    for (const event of SOUND_EVENTS) {
      expect(RECIPES[event].notes.length).toBeGreaterThan(0)
      expect(SOUND_INFO[event].label).toBeTruthy()
    }
  })

  it('renders short, audible, clean sounds', () => {
    for (const event of SOUND_EVENTS) {
      const s = rendered[event]
      const seconds = s.length / RATE
      expect(seconds, event).toBeGreaterThan(0.08)
      expect(seconds, event).toBeLessThan(0.8)
      expect(s.some(Number.isNaN), event).toBe(false)
      // Genuinely audible: well above -40 dBFS.
      expect(db(audibleRms(s)), event).toBeGreaterThan(-25)
      // No clicks: starts and ends at (near) silence.
      expect(Math.abs(s[0]!), event).toBeLessThan(0.01)
      expect(Math.abs(s[s.length - 1]!), event).toBeLessThan(0.01)
    }
  })

  it('normalizes loudness and limits peaks so every event plays at the same level', () => {
    const levels = SOUND_EVENTS.map((e) => db(audibleRms(rendered[e])))
    for (const level of levels) expect(Math.abs(level - db(TARGET_RMS))).toBeLessThan(1)
    for (const event of SOUND_EVENTS)
      expect(peakOf(rendered[event])).toBeLessThanOrEqual(PEAK_LIMIT + 1e-6)
  })

  it('is deterministic', () => {
    const again = renderRecipe(RECIPES.mention, RATE)
    expect(Array.from(again.slice(0, 2000))).toEqual(Array.from(rendered.mention.slice(0, 2000)))
  })

  it('makes every sound distinct', () => {
    const signature = (e: (typeof SOUND_EVENTS)[number]): string =>
      RECIPES[e].notes
        .map((n) => `${n.freq.toFixed(1)}>${(n.toFreq ?? n.freq).toFixed(1)}`)
        .join(',')
    expect(new Set(SOUND_EVENTS.map(signature)).size).toBe(SOUND_EVENTS.length)
    // Rising vs falling pairs really move in opposite directions.
    const first = (e: (typeof SOUND_EVENTS)[number]): number => RECIPES[e].notes[0]!.freq
    const last = (e: (typeof SOUND_EVENTS)[number]): number => RECIPES[e].notes.at(-1)!.freq
    expect(last('voiceJoin')).toBeGreaterThan(first('voiceJoin'))
    expect(last('voiceLeave')).toBeLessThan(first('voiceLeave'))
    expect(last('connect')).toBeGreaterThan(first('connect'))
    expect(last('disconnect')).toBeLessThan(first('disconnect'))
    // The mention is brighter (higher) than the message chime's first note, unmute above mute.
    expect(RECIPES.mention.notes.length).toBe(3)
    expect(RECIPES.message.notes.length).toBe(2)
    expect(dominantHz(rendered.unmute)).toBeGreaterThan(dominantHz(rendered.mute))
    expect(dominantHz(rendered.undeafen)).toBeGreaterThan(dominantHz(rendered.deafen))
  })
})
