/**
 * Discord 2.0's original sound palette. Every sound is synthesized here from a small recipe
 * (notes with waveform, partials, pitch glide, envelope and a gentle low-pass) — no audio files,
 * no third-party samples. Rendering is plain TypeScript DSP into a Float32Array, so it is
 * deterministic and unit-testable; the SoundService copies the result into a Web Audio buffer.
 *
 * All sounds are loudness-matched (RMS of the audible part) and peak-limited, so the master
 * volume behaves the same for every event.
 */

export type SoundEvent =
  | 'message'
  | 'mention'
  | 'voiceJoin'
  | 'voiceLeave'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'connect'
  | 'disconnect'

export const SOUND_EVENTS: readonly SoundEvent[] = [
  'message',
  'mention',
  'voiceJoin',
  'voiceLeave',
  'connect',
  'disconnect',
  'mute',
  'unmute',
  'deafen',
  'undeafen'
]

export interface SoundInfo {
  label: string
  description: string
  group: 'messages' | 'voice' | 'controls'
}

export const SOUND_INFO: Record<SoundEvent, SoundInfo> = {
  message: {
    label: 'New message',
    description: 'A message arrives in a channel you aren’t looking at.',
    group: 'messages'
  },
  mention: {
    label: 'Mention',
    description: 'Someone mentions you (@username, @display name or @everyone).',
    group: 'messages'
  },
  voiceJoin: {
    label: 'Someone joins voice',
    description: 'Another person joins the voice channel you’re in.',
    group: 'voice'
  },
  voiceLeave: {
    label: 'Someone leaves voice',
    description: 'Another person leaves the voice channel you’re in.',
    group: 'voice'
  },
  connect: {
    label: 'You connect',
    description: 'You join a voice channel.',
    group: 'voice'
  },
  disconnect: {
    label: 'You disconnect',
    description: 'You leave voice, or the connection is lost.',
    group: 'voice'
  },
  mute: { label: 'Mute', description: 'You mute your microphone.', group: 'controls' },
  unmute: { label: 'Unmute', description: 'You unmute your microphone.', group: 'controls' },
  deafen: { label: 'Deafen', description: 'You deafen yourself.', group: 'controls' },
  undeafen: { label: 'Undeafen', description: 'You undeafen yourself.', group: 'controls' }
}

export type Waveform = 'sine' | 'triangle'

export interface Note {
  /** Start time in seconds. */
  at: number
  /** Start frequency (Hz). */
  freq: number
  /** End frequency for a pitch glide (defaults to `freq`). */
  toFreq?: number
  /** Total length including the release (seconds). */
  dur: number
  wave: Waveform
  /** Relative level of this note before normalization. */
  gain: number
  /** Attack time (seconds). */
  attack: number
  /** Exponential decay time constant (seconds). */
  decay: number
  /** Extra partials as [frequency ratio, relative level]; slight inharmonicity = bell-like. */
  partials?: [number, number][]
}

export interface SoundRecipe {
  notes: Note[]
  /** One-pole low-pass cutoff (Hz) to soften the top end. */
  lowpass: number
  /** Soft echo for a sense of space: [delay seconds, level]. */
  echo?: [number, number]
}

const BELL: [number, number][] = [
  [2.0, 0.22],
  [3.01, 0.07],
  [4.2, 0.025]
]
const WARM: [number, number][] = [
  [2.0, 0.12],
  [3.0, 0.04]
]
const CLICK: [number, number][] = [[2.0, 0.3]]

/** Equal-temperament frequency, in semitones from A4 (440 Hz). */
const hz = (semitonesFromA4: number): number => 440 * 2 ** (semitonesFromA4 / 12)
const A3 = hz(-12)
const C4 = hz(-9)
const D4 = hz(-7)
const E4 = hz(-5)
const G4 = hz(-2)
const C5 = hz(3)
const D5 = hz(5)
const E5 = hz(7)
const G5 = hz(10)
const A5 = hz(12)
const B5 = hz(14)
const E6 = hz(19)
const Fs6 = hz(21)

export const RECIPES: Record<SoundEvent, SoundRecipe> = {
  // Gentle two-note digital chime: a soft fourth up, bell partials.
  message: {
    notes: [
      {
        at: 0,
        freq: B5,
        dur: 0.3,
        wave: 'sine',
        gain: 0.8,
        attack: 0.004,
        decay: 0.09,
        partials: BELL
      },
      {
        at: 0.085,
        freq: E6,
        dur: 0.42,
        wave: 'sine',
        gain: 1,
        attack: 0.004,
        decay: 0.14,
        partials: BELL
      }
    ],
    lowpass: 6500,
    echo: [0.09, 0.12]
  },
  // Brighter three-note rising figure; a triangle body so it cuts through.
  mention: {
    notes: [
      {
        at: 0,
        freq: E5,
        dur: 0.18,
        wave: 'triangle',
        gain: 0.75,
        attack: 0.003,
        decay: 0.07,
        partials: BELL
      },
      {
        at: 0.07,
        freq: A5,
        dur: 0.2,
        wave: 'triangle',
        gain: 0.85,
        attack: 0.003,
        decay: 0.07,
        partials: BELL
      },
      {
        at: 0.14,
        freq: Fs6,
        dur: 0.45,
        wave: 'triangle',
        gain: 1,
        attack: 0.003,
        decay: 0.15,
        partials: BELL
      }
    ],
    lowpass: 7500,
    echo: [0.08, 0.14]
  },
  // Warm ascending confirmation with a slight upward glide.
  voiceJoin: {
    notes: [
      {
        at: 0,
        freq: G4,
        dur: 0.22,
        wave: 'triangle',
        gain: 0.85,
        attack: 0.012,
        decay: 0.09,
        partials: WARM
      },
      {
        at: 0.09,
        freq: D5,
        toFreq: D5 * 1.01,
        dur: 0.34,
        wave: 'triangle',
        gain: 1,
        attack: 0.012,
        decay: 0.13,
        partials: WARM
      }
    ],
    lowpass: 3200
  },
  // Gentle descending mirror of the join sound.
  voiceLeave: {
    notes: [
      {
        at: 0,
        freq: D5,
        dur: 0.22,
        wave: 'triangle',
        gain: 0.9,
        attack: 0.012,
        decay: 0.09,
        partials: WARM
      },
      {
        at: 0.09,
        freq: G4,
        toFreq: G4 * 0.99,
        dur: 0.34,
        wave: 'triangle',
        gain: 0.85,
        attack: 0.012,
        decay: 0.12,
        partials: WARM
      }
    ],
    lowpass: 2800
  },
  // Short low "tock" that drops slightly.
  mute: {
    notes: [
      {
        at: 0,
        freq: E4,
        toFreq: D4,
        dur: 0.11,
        wave: 'sine',
        gain: 1,
        attack: 0.002,
        decay: 0.035,
        partials: CLICK
      }
    ],
    lowpass: 2400
  },
  // Short higher "tick" that lifts slightly.
  unmute: {
    notes: [
      {
        at: 0,
        freq: E5,
        toFreq: G5,
        dur: 0.11,
        wave: 'sine',
        gain: 1,
        attack: 0.002,
        decay: 0.035,
        partials: CLICK
      }
    ],
    lowpass: 3600
  },
  // Two quick, deeper notes going down.
  deafen: {
    notes: [
      {
        at: 0,
        freq: D4,
        dur: 0.1,
        wave: 'triangle',
        gain: 0.9,
        attack: 0.002,
        decay: 0.035,
        partials: CLICK
      },
      {
        at: 0.065,
        freq: A3,
        dur: 0.14,
        wave: 'triangle',
        gain: 1,
        attack: 0.002,
        decay: 0.05,
        partials: CLICK
      }
    ],
    lowpass: 2000
  },
  // Two quick, bright notes going up.
  undeafen: {
    notes: [
      {
        at: 0,
        freq: E5,
        dur: 0.09,
        wave: 'triangle',
        gain: 0.85,
        attack: 0.002,
        decay: 0.03,
        partials: CLICK
      },
      {
        at: 0.06,
        freq: A5,
        dur: 0.13,
        wave: 'triangle',
        gain: 1,
        attack: 0.002,
        decay: 0.045,
        partials: CLICK
      }
    ],
    lowpass: 4200
  },
  // Soft major arpeggio: "you're in".
  connect: {
    notes: [
      {
        at: 0,
        freq: C5,
        dur: 0.2,
        wave: 'sine',
        gain: 0.75,
        attack: 0.008,
        decay: 0.08,
        partials: WARM
      },
      {
        at: 0.07,
        freq: E5,
        dur: 0.22,
        wave: 'sine',
        gain: 0.85,
        attack: 0.008,
        decay: 0.08,
        partials: WARM
      },
      {
        at: 0.14,
        freq: G5,
        dur: 0.4,
        wave: 'sine',
        gain: 1,
        attack: 0.008,
        decay: 0.14,
        partials: WARM
      }
    ],
    lowpass: 4500,
    echo: [0.1, 0.1]
  },
  // Subtle two-note fall: "you're out".
  disconnect: {
    notes: [
      {
        at: 0,
        freq: G4,
        dur: 0.18,
        wave: 'sine',
        gain: 1,
        attack: 0.008,
        decay: 0.07,
        partials: WARM
      },
      {
        at: 0.08,
        freq: C4,
        toFreq: C4 * 0.985,
        dur: 0.32,
        wave: 'sine',
        gain: 0.9,
        attack: 0.008,
        decay: 0.11,
        partials: WARM
      }
    ],
    lowpass: 2600
  }
}

/** Target loudness (RMS of the audible part) and peak ceiling for every rendered sound. */
export const TARGET_RMS = 0.12
export const PEAK_LIMIT = 0.7

function oscillator(type: Waveform, phase: number): number {
  if (type === 'sine') return Math.sin(phase)
  const t = phase / (2 * Math.PI)
  return 4 * Math.abs(t - Math.floor(t + 0.5)) - 1
}

/** Renders a recipe to mono samples, loudness-normalized and peak-limited. */
export function renderRecipe(recipe: SoundRecipe, sampleRate: number): Float32Array {
  const tail = recipe.echo ? recipe.echo[0] * 2 : 0
  const length = Math.max(...recipe.notes.map((n) => n.at + n.dur)) + tail
  const out = new Float32Array(Math.ceil(length * sampleRate))

  for (const note of recipe.notes) {
    const start = Math.floor(note.at * sampleRate)
    const count = Math.floor(note.dur * sampleRate)
    const release = Math.min(0.02, note.dur / 4)
    const partials: [number, number][] = [[1, 1], ...(note.partials ?? [])]
    const phases = partials.map(() => 0)
    const glide = (note.toFreq ?? note.freq) - note.freq
    for (let i = 0; i < count && start + i < out.length; i++) {
      const t = i / sampleRate
      const freq = note.freq + glide * (i / count)
      // Attack → exponential decay → short linear release to zero (no clicks).
      const attackGain = t < note.attack ? t / note.attack : 1
      const decayGain = Math.exp(-Math.max(0, t - note.attack) / note.decay)
      const releaseGain = t > note.dur - release ? Math.max(0, (note.dur - t) / release) : 1
      const env = attackGain * decayGain * releaseGain * note.gain
      let sample = 0
      for (let p = 0; p < partials.length; p++) {
        const [ratio, level] = partials[p]!
        // Upper partials fade faster, like real struck sounds.
        const partialEnv = p === 0 ? 1 : Math.exp(-t / (note.decay * 0.6))
        phases[p] = (phases[p]! + (2 * Math.PI * freq * ratio) / sampleRate) % (2 * Math.PI)
        sample += oscillator(p === 0 ? note.wave : 'sine', phases[p]!) * level * partialEnv
      }
      out[start + i] = out[start + i]! + sample * env
    }
  }

  if (recipe.echo) {
    const [delay, level] = recipe.echo
    const d = Math.floor(delay * sampleRate)
    for (let i = out.length - 1; i >= d; i--) out[i] = out[i]! + out[i - d]! * level
  }

  // One-pole low-pass for a soft, non-fatiguing top end.
  const alpha = 1 - Math.exp((-2 * Math.PI * recipe.lowpass) / sampleRate)
  let y = 0
  for (let i = 0; i < out.length; i++) {
    y += alpha * (out[i]! - y)
    out[i] = y
  }

  return normalize(out)
}

export function peakOf(samples: Float32Array): number {
  let peak = 0
  for (const s of samples) peak = Math.max(peak, Math.abs(s))
  return peak
}

/** RMS over samples above -40 dB of the peak (ignores silence and the fading tail). */
export function audibleRms(samples: Float32Array): number {
  const peak = peakOf(samples)
  if (peak === 0) return 0
  const floor = peak * 0.01
  let sum = 0
  let n = 0
  for (const s of samples) {
    if (Math.abs(s) >= floor) {
      sum += s * s
      n++
    }
  }
  return n ? Math.sqrt(sum / n) : 0
}

function normalize(samples: Float32Array): Float32Array {
  const rms = audibleRms(samples)
  if (rms === 0) return samples
  let gain = TARGET_RMS / rms
  const peak = peakOf(samples) * gain
  if (peak > PEAK_LIMIT) gain *= PEAK_LIMIT / peak
  for (let i = 0; i < samples.length; i++) samples[i] = samples[i]! * gain
  return samples
}
