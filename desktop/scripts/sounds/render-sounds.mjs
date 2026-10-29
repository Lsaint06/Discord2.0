/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain Node script (no TS) */
// Discord 2.0 — Milestone 14 sound renderer.
//
// Renders every built-in sound pack to real WAV files (48 kHz, 16-bit PCM, mono) with original
// procedural synthesis — no samples, no third-party audio — and writes an objective QA manifest
// (loudness, peaks, DC offset, silence, clipping, clicks, hashes).
//
//   node scripts/sounds/render-sounds.mjs           # render + manifest
//   node scripts/sounds/render-sounds.mjs --check   # verify committed files match a fresh render
//
// Loudness: ITU-R BS.1770 K-weighting; each sound is normalized on its loudest 400 ms window
// ("momentary max", LUFS) to a target per event class, then capped at -1.5 dBFS sample peak.
// Deterministic: same code → byte-identical files (seeded noise and dither).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SR = 48000
const TAU = Math.PI * 2
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', '..', 'src', 'renderer', 'src', 'assets', 'sounds')
const CHECK = process.argv.includes('--check')

// ---------------------------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const midiHz = (n) => 440 * 2 ** ((n - 69) / 12)
const dbToGain = (db) => 10 ** (db / 20)
const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity)

class Track {
  constructor(seconds) {
    this.d = new Float64Array(Math.ceil(seconds * SR))
  }
  add(index, value) {
    if (index >= 0 && index < this.d.length) this.d[index] += value
  }
}

/** Attack (raised cosine) → exponential decay → 8 ms release at the end. */
function envelope(t, dur, attack, decay) {
  const a = t < attack ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack) : 1
  const d = Math.exp(-Math.max(0, t - attack) / decay)
  const rel = Math.min(0.008, dur / 4)
  const r = t > dur - rel ? Math.max(0, (dur - t) / rel) : 1
  return a * d * r
}

// RBJ biquad.
function biquad(type, freq, q = 0.707, gainDb = 0) {
  const w = (TAU * freq) / SR
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * q)
  const A = 10 ** (gainDb / 40)
  let b0, b1, b2, a0, a1, a2
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2
    b1 = 1 - cos
    b2 = (1 - cos) / 2
    a0 = 1 + alpha
    a1 = -2 * cos
    a2 = 1 - alpha
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2
    b1 = -(1 + cos)
    b2 = (1 + cos) / 2
    a0 = 1 + alpha
    a1 = -2 * cos
    a2 = 1 - alpha
  } else if (type === 'bandpass') {
    b0 = alpha
    b1 = 0
    b2 = -alpha
    a0 = 1 + alpha
    a1 = -2 * cos
    a2 = 1 - alpha
  } else {
    // peaking
    b0 = 1 + alpha * A
    b1 = -2 * cos
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cos
    a2 = 1 - alpha / A
  }
  const c = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0
  return (x) => {
    const y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    return y
  }
}

function filterInPlace(data, f) {
  for (let i = 0; i < data.length; i++) data[i] = f(data[i])
}

/** polyBLEP residual for band-limited saw/square. */
function polyBlep(t, dt) {
  if (t < dt) {
    t /= dt
    return t + t - t * t - 1
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt
    return t * t + t + t + 1
  }
  return 0
}

// ---------------------------------------------------------------------------------------------
// Instruments (all original synthesis)
// ---------------------------------------------------------------------------------------------

/** Glassy FM bell blended with a pure sine body. */
function fmBell(tr, t0, f, dur, o = {}) {
  const {
    gain = 1,
    ratio = 3.5,
    index = 1.4,
    idxDecay = 0.09,
    decay = 0.32,
    attack = 0.003,
    body = 0.4
  } = o
  const start = Math.round(t0 * SR)
  const n = Math.round(dur * SR)
  let pc = 0,
    pm = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const idx = index * Math.exp(-t / idxDecay)
    const s = Math.sin(pc + idx * Math.sin(pm)) * (1 - body) + Math.sin(pc) * body
    tr.add(start + i, gain * envelope(t, dur, attack, decay) * s)
    pc += (TAU * f) / SR
    pm += (TAU * f * ratio) / SR
  }
}

/** Soft sine with a touch of 2nd/3rd harmonic. */
function softTone(tr, t0, f, dur, o = {}) {
  const { gain = 1, decay = 0.18, attack = 0.004, h2 = 0.12, h3 = 0.04, glide = 0 } = o
  const start = Math.round(t0 * SR)
  const n = Math.round(dur * SR)
  let p = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const freq = f * (1 + glide * (i / n))
    const s = Math.sin(p) + h2 * Math.sin(2 * p) + h3 * Math.sin(3 * p)
    tr.add(start + i, gain * envelope(t, dur, attack, decay) * s)
    p += (TAU * freq) / SR
  }
}

/** Kalimba-like tine: fundamental + quickly fading inharmonic overtone + soft tick. */
function tine(tr, t0, f, dur, o = {}, rand) {
  const { gain = 1, decay = 0.42 } = o
  const start = Math.round(t0 * SR)
  const n = Math.round(dur * SR)
  let p1 = 0,
    p2 = 0
  const lp = biquad('lowpass', 2500)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const tick = t < 0.004 ? lp((rand() * 2 - 1) * (1 - t / 0.004)) * 0.35 : 0
    const s =
      Math.sin(p1) * envelope(t, dur, 0.002, decay) +
      0.28 * Math.sin(p2) * envelope(t, dur, 0.001, 0.035)
    tr.add(start + i, gain * (s + tick))
    p1 += (TAU * f) / SR
    p2 += (TAU * f * 5.4) / SR
  }
}

/** Karplus–Strong plucked string (warm, wooden). */
function pluck(tr, t0, f, dur, o = {}, rand) {
  const { gain = 1, damping = 0.996, brightness = 0.5 } = o
  const start = Math.round(t0 * SR)
  const n = Math.round(dur * SR)
  const len = Math.max(2, Math.round(SR / f))
  const line = new Float64Array(len)
  let prev = 0
  for (let i = 0; i < len; i++) {
    const noise = rand() * 2 - 1
    prev = prev + brightness * (noise - prev)
    line[i] = prev
  }
  let idx = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const a = line[idx]
    const b = line[(idx + 1) % len]
    line[idx] = damping * 0.5 * (a + b)
    idx = (idx + 1) % len
    const rel = t > dur - 0.01 ? Math.max(0, (dur - t) / 0.01) : 1
    const att = t < 0.002 ? t / 0.002 : 1
    tr.add(start + i, gain * a * rel * att)
  }
}

/** Band-limited pulse wave with stepped (8-bit style) volume envelope. */
function chip(tr, t0, f, dur, o = {}) {
  const { gain = 1, duty = 0.5, decay = 0.12, steps = 12, slide = 0 } = o
  const start = Math.round(t0 * SR)
  const n = Math.round(dur * SR)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const freq = f * (1 + slide * (i / n))
    const dt = freq / SR
    let sq = phase < duty ? 1 : -1
    sq += polyBlep(phase, dt)
    sq -= polyBlep((phase - duty + 1) % 1, dt)
    const e = Math.ceil(envelope(t, dur, 0.001, decay) * steps) / steps
    tr.add(start + i, gain * 0.5 * sq * e)
    phase = (phase + dt) % 1
  }
}

/** Detuned saw pluck through a resonant low-pass sweep (synth). */
function sawPluck(tr, t0, f, dur, o = {}) {
  const { gain = 1, decay = 0.2, cutoff = 5200, floor = 500, res = 0.75, detune = 0.006 } = o
  const start = Math.round(t0 * SR)
  const n = Math.round(dur * SR)
  let p1 = 0,
    p2 = 0
  let low = 0,
    band = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const d1 = (f * (1 - detune)) / SR
    const d2 = (f * (1 + detune)) / SR
    const s1 = 2 * p1 - 1 - polyBlep(p1, d1)
    const s2 = 2 * p2 - 1 - polyBlep(p2, d2)
    p1 = (p1 + d1) % 1
    p2 = (p2 + d2) % 1
    const cut = floor + (cutoff - floor) * Math.exp(-t / (decay * 0.6))
    const fc = 2 * Math.sin((Math.PI * Math.min(cut, SR / 6)) / SR)
    const input = 0.5 * (s1 + s2)
    low += fc * band
    const high = input - low - (1 - res) * 2 * band
    band += fc * high
    tr.add(start + i, gain * 0.6 * low * envelope(t, dur, 0.002, decay))
  }
}

/** Short filtered-noise click with a pitched body (button feel). */
function click(tr, t0, o = {}, rand) {
  const { gain = 1, center = 2600, body = 700, bodyEnd = 520, dur = 0.07 } = o
  const start = Math.round(t0 * SR)
  const n = Math.round(dur * SR)
  const bp = biquad('bandpass', center, 1.6)
  let p = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const noise = bp(rand() * 2 - 1) * Math.exp(-t / 0.005) * 1.4 * Math.min(1, t / 0.0008)
    const f = body + (bodyEnd - body) * Math.min(1, t / 0.04)
    const tone = Math.sin(p) * envelope(t, dur, 0.0015, 0.022)
    p += (TAU * f) / SR
    tr.add(start + i, gain * (noise + 0.8 * tone))
  }
}

/** Filtered-noise sweep ("whoosh") from f1 to f2. */
function whoosh(tr, t0, dur, f1, f2, o = {}, rand) {
  const { gain = 1 } = o
  const start = Math.round(t0 * SR)
  const n = Math.round(dur * SR)
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0
  for (let i = 0; i < n; i++) {
    const k = i / n
    const f = f1 * (f2 / f1) ** k
    const w = (TAU * f) / SR
    const alpha = Math.sin(w) / (2 * 2.2)
    const cos = Math.cos(w)
    const a0 = 1 + alpha
    const x = rand() * 2 - 1
    const y = (alpha * x - alpha * x2 + 2 * cos * y1 - (1 - alpha) * y2) / a0
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    const e = Math.sin(Math.PI * k) ** 1.5
    tr.add(start + i, gain * 2.2 * y * e)
  }
}

// Freeverb-style mono reverb.
function reverb(data, { room = 0.78, damp = 0.35, wet = 0.15, predelay = 0.012 } = {}) {
  if (wet <= 0) return
  const scale = SR / 44100
  const combs = [1116, 1188, 1277, 1356, 1422, 1491].map((d) => ({
    buf: new Float64Array(Math.round(d * scale)),
    idx: 0,
    store: 0
  }))
  const aps = [556, 441, 341].map((d) => ({ buf: new Float64Array(Math.round(d * scale)), idx: 0 }))
  const pre = Math.round(predelay * SR)
  const out = new Float64Array(data.length)
  for (let i = 0; i < data.length; i++) {
    const input = (i >= pre ? data[i - pre] : 0) * 0.015
    let sum = 0
    for (const c of combs) {
      const y = c.buf[c.idx]
      c.store = y * (1 - damp) + c.store * damp
      c.buf[c.idx] = input + c.store * room
      c.idx = (c.idx + 1) % c.buf.length
      sum += y
    }
    for (const a of aps) {
      const b = a.buf[a.idx]
      a.buf[a.idx] = sum + b * 0.5
      a.idx = (a.idx + 1) % a.buf.length
      sum = b - sum
    }
    out[i] = sum
  }
  for (let i = 0; i < data.length; i++) data[i] = data[i] * (1 - wet * 0.5) + out[i] * wet * 3
}

// ---------------------------------------------------------------------------------------------
// Loudness and QA (ITU-R BS.1770 K-weighting at 48 kHz)
// ---------------------------------------------------------------------------------------------

function kWeighted(data) {
  const stage = (b, a) => {
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0
    return (x) => {
      const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
      x2 = x1
      x1 = x
      y2 = y1
      y1 = y
      return y
    }
  }
  const shelf = stage(
    [1.53512485958697, -2.69169618940638, 1.19839281085285],
    [1, -1.69065929318241, 0.73248077421585]
  )
  const hp = stage([1, -2, 1], [1, -1.99004745483398, 0.99007225036621])
  const out = new Float64Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = hp(shelf(data[i]))
  return out
}

const lufsOf = (meanSquare) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity)

/** Loudest 400 ms window (100 ms hop); a shorter clip is measured as one silence-padded window. */
function momentaryMax(data) {
  const k = kWeighted(data)
  const win = Math.round(0.4 * SR)
  const hop = Math.round(0.1 * SR)
  if (k.length <= win) {
    let s = 0
    for (const v of k) s += v * v
    return lufsOf(s / win)
  }
  let best = -Infinity
  for (let start = 0; start + win <= k.length; start += hop) {
    let s = 0
    for (let i = start; i < start + win; i++) s += k[i] * k[i]
    best = Math.max(best, lufsOf(s / win))
  }
  return best
}

function metrics(samples) {
  let peak = 0,
    sum = 0,
    sumSq = 0,
    clipped = 0
  for (const s of samples) {
    const a = Math.abs(s)
    if (a > peak) peak = a
    if (a >= 0.999) clipped++
    sum += s
    sumSq += s * s
  }
  // Approximate true peak: 4× cubic (Catmull-Rom) interpolation between samples.
  let truePeak = peak
  for (let i = 1; i + 2 < samples.length; i++) {
    const y0 = samples[i - 1],
      y1 = samples[i],
      y2 = samples[i + 1],
      y3 = samples[i + 2]
    for (let j = 1; j < 4; j++) {
      const x = j / 4
      const v =
        y1 +
        0.5 * x * (y2 - y0 + x * (2 * y0 - 5 * y1 + 4 * y2 - y3 + x * (3 * (y1 - y2) + y3 - y0)))
      truePeak = Math.max(truePeak, Math.abs(v))
    }
  }
  const threshold = dbToGain(-50) * peak
  let first = 0
  while (first < samples.length && Math.abs(samples[first]) < threshold) first++
  let last = samples.length - 1
  while (last > 0 && Math.abs(samples[last]) < dbToGain(-60)) last--
  return {
    durationMs: Math.round((samples.length / SR) * 1000),
    peakDbfs: +gainToDb(peak).toFixed(2),
    truePeakDbfsApprox: +gainToDb(truePeak).toFixed(2),
    rmsDbfs: +gainToDb(Math.sqrt(sumSq / samples.length)).toFixed(2),
    momentaryMaxLufs: +momentaryMax(samples).toFixed(2),
    dcOffset: +(sum / samples.length).toExponential(2),
    leadingSilenceMs: +((first / SR) * 1000).toFixed(1),
    trailingSilenceMs: +(((samples.length - 1 - last) / SR) * 1000).toFixed(1),
    clippedSamples: clipped,
    edgeSamples: [+samples[0].toFixed(5), +samples[samples.length - 1].toFixed(5)]
  }
}

// ---------------------------------------------------------------------------------------------
// Mastering: DC/rumble removal, trim, fades, loudness, peak cap, TPDF dither → 16-bit WAV
// ---------------------------------------------------------------------------------------------

const PEAK_CEILING_DB = -1.5

function master(track, targetLufs, seed) {
  const data = track.d
  filterInPlace(data, biquad('highpass', 70, 0.707))
  // Loudness first (the quiet tail doesn't change the loudest window), then a hard ceiling
  // (gain only — no limiter, so nothing distorts).
  let gain = dbToGain(targetLufs - momentaryMax(data))
  let peak = 0
  for (const s of data) peak = Math.max(peak, Math.abs(s))
  if (peak * gain > dbToGain(PEAK_CEILING_DB)) gain = dbToGain(PEAK_CEILING_DB) / peak
  // Trim the tail once it is below -58 dBFS at the final level (keep 20 ms), then fade edges.
  let end = data.length - 1
  while (end > 0 && Math.abs(data[end] * gain) < dbToGain(-58)) end--
  const length = Math.min(data.length, end + Math.round(0.02 * SR))
  const out = data.slice(0, length)
  const fadeIn = Math.round(0.0015 * SR)
  const fadeOut = Math.min(Math.round(0.025 * SR), Math.floor(length / 3))
  for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn
  for (let i = 0; i < fadeOut; i++) out[length - 1 - i] *= i / fadeOut
  const rand = rng(seed)
  const pcm = new Int16Array(length)
  const floats = new Float64Array(length)
  for (let i = 0; i < length; i++) {
    // TPDF dither (±1 LSB) only where there is signal, so the edges stay exactly silent.
    const edge = i === 0 || i === length - 1
    const dither = edge ? 0 : (rand() - rand()) / 32768
    const v = Math.max(-1, Math.min(1, out[i] * gain + dither))
    pcm[i] = Math.round(v * 32767)
    floats[i] = pcm[i] / 32768
  }
  return { pcm, floats }
}

function wav(pcm) {
  const bytes = pcm.length * 2
  const buf = Buffer.alloc(44 + bytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + bytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(bytes, 40)
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2)
  return buf
}

// ---------------------------------------------------------------------------------------------
// Events, loudness classes and phrases
// ---------------------------------------------------------------------------------------------

// Loudness targets (momentary max, LUFS). The app's master volume scales all of them.
const TARGET = { alert: -18, standard: -20, control: -25 }

/** event → [class, kind, phrase]. Notes: [time s, semitones from the pack root, length s, velocity]. */
const EVENTS = {
  message: [
    'standard',
    'notes',
    [
      [0, 7, 0.32, 0.8],
      [0.065, 12, 0.42, 1]
    ]
  ],
  mention: [
    'alert',
    'notes',
    [
      [0, 7, 0.24, 0.75],
      [0.085, 12, 0.26, 0.85],
      [0.17, 16, 0.55, 1]
    ]
  ],
  directMessage: [
    'alert',
    'notes',
    [
      [0, 4, 0.3, 0.85],
      [0.11, 11, 0.6, 1]
    ]
  ],
  friendRequest: [
    'alert',
    'notes',
    [
      [0, 0, 0.2, 0.7],
      [0.08, 4, 0.2, 0.8],
      [0.16, 7, 0.22, 0.9],
      [0.24, 12, 0.5, 1]
    ]
  ],
  friendAccepted: [
    'standard',
    'notes',
    [
      [0, 0, 0.5, 0.6],
      [0, 4, 0.5, 0.6],
      [0, 7, 0.5, 0.6],
      [0.14, 12, 0.6, 1]
    ]
  ],
  voiceJoin: [
    'standard',
    'notes',
    [
      [0, -5, 0.24, 0.85],
      [0.1, 0, 0.42, 1]
    ]
  ],
  voiceLeave: [
    'standard',
    'notes',
    [
      [0, 0, 0.24, 1],
      [0.1, -5, 0.42, 0.85]
    ]
  ],
  connect: [
    'standard',
    'notes',
    [
      [0, -5, 0.2, 0.75],
      [0.08, 0, 0.2, 0.85],
      [0.16, 4, 0.5, 1]
    ]
  ],
  disconnect: [
    'standard',
    'notes',
    [
      [0, 4, 0.2, 1],
      [0.09, 0, 0.2, 0.85],
      [0.18, -5, 0.5, 0.75]
    ]
  ],
  voiceDrop: [
    'alert',
    'notes',
    [
      [0, 0, 0.22, 1],
      [0.12, -1, 0.22, 0.9],
      [0.24, -6, 0.6, 0.85]
    ]
  ],
  reconnect: [
    'standard',
    'notes',
    [
      [0, 0, 0.18, 0.8],
      [0.07, 7, 0.36, 1]
    ]
  ],
  streamStart: [
    'standard',
    'rise',
    [
      [0.22, 12, 0.3, 0.8],
      [0.3, 19, 0.5, 1]
    ]
  ],
  streamStop: ['standard', 'fall', [[0.18, 7, 0.45, 0.9]]],
  streamRemoteStart: [
    'standard',
    'notes',
    [
      [0, 12, 0.24, 0.8],
      [0.08, 16, 0.42, 1]
    ]
  ],
  streamRemoteStop: [
    'standard',
    'notes',
    [
      [0, 16, 0.24, 1],
      [0.08, 12, 0.42, 0.8]
    ]
  ],
  mute: ['control', 'click', { body: 640, bodyEnd: 480 }],
  unmute: ['control', 'click', { body: 820, bodyEnd: 1040 }],
  deafen: ['control', 'click2', { body: 520, bodyEnd: 380 }],
  undeafen: ['control', 'click2', { body: 760, bodyEnd: 960 }],
  pttOn: ['control', 'tick', { body: 1500, bodyEnd: 1500 }],
  pttOff: ['control', 'tick', { body: 1100, bodyEnd: 1100 }],
  uploadDone: [
    'standard',
    'notes',
    [
      [0, 7, 0.22, 0.85],
      [0.08, 12, 0.45, 1]
    ]
  ],
  uploadFailed: [
    'standard',
    'notes',
    [
      [0, 3, 0.24, 1],
      [0.13, -2, 0.45, 0.85]
    ]
  ],
  sendFailed: [
    'standard',
    'notes',
    [
      [0, 0, 0.2, 1],
      [0.11, -3, 0.38, 0.85]
    ]
  ]
}

// ---------------------------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------------------------

const PACKS = {
  signature: {
    root: 74, // D5
    space: { room: 0.8, damp: 0.38, wet: 0.16 },
    lowpass: 9500,
    note: (tr, t, f, len, vel) => {
      fmBell(tr, t, f, len + 0.25, {
        gain: vel,
        ratio: 3.5,
        index: 1.25,
        decay: 0.26 + len * 0.3,
        body: 0.45
      })
      softTone(tr, t, f / 2, len + 0.1, { gain: vel * 0.22, decay: 0.12 })
    },
    click: (tr, t, o, rand) => click(tr, t, { ...o, center: 2400, dur: 0.08 }, rand),
    whoosh: (tr, t, dur, f1, f2, rand) => whoosh(tr, t, dur, f1, f2, { gain: 0.5 }, rand)
  },
  classic: {
    root: 72, // C5
    space: { room: 0.6, damp: 0.5, wet: 0.05 },
    lowpass: 7000,
    note: (tr, t, f, len, vel) =>
      softTone(tr, t, f, len + 0.05, { gain: vel, decay: 0.07 + len * 0.22, h2: 0.18, h3: 0.08 }),
    click: (tr, t, o, rand) => click(tr, t, { ...o, center: 1800, dur: 0.07 }, rand),
    whoosh: (tr, t, dur, f1, f2) =>
      softTone(tr, t, f1 > f2 ? 900 : 600, dur, {
        gain: 0.6,
        decay: dur,
        glide: f1 > f2 ? -0.35 : 0.5
      })
  },
  minimal: {
    root: 76, // E5
    space: { room: 0.5, damp: 0.6, wet: 0 },
    lowpass: 6000,
    shorten: true,
    targetOffset: -2,
    note: (tr, t, f, len, vel) =>
      softTone(tr, t, f, Math.min(0.32, len), {
        gain: vel,
        decay: 0.05 + len * 0.12,
        h2: 0.05,
        h3: 0
      }),
    click: (tr, t, o, rand) => click(tr, t, { ...o, center: 3200, dur: 0.045 }, rand),
    whoosh: () => {}
  },
  cyber: {
    root: 66, // F#4
    space: { room: 0.72, damp: 0.25, wet: 0.12 },
    lowpass: 11000,
    echo: [0.11, 0.28],
    note: (tr, t, f, len, vel) =>
      sawPluck(tr, t, f, len + 0.12, {
        gain: vel,
        decay: 0.09 + len * 0.25,
        cutoff: 6400,
        floor: 420,
        res: 0.82
      }),
    click: (tr, t, o) =>
      chip(tr, t, o.body * 1.5, 0.05, {
        gain: 0.8,
        duty: 0.25,
        decay: 0.02,
        slide: o.bodyEnd > o.body ? 0.4 : -0.3
      }),
    whoosh: (tr, t, dur, f1, f2, rand) => {
      whoosh(tr, t, dur, f1, f2, { gain: 0.45 }, rand)
      sawPluck(tr, t, f1 < f2 ? 220 : 330, dur, {
        gain: 0.35,
        decay: dur,
        cutoff: f1 < f2 ? 2400 : 900,
        floor: f1 < f2 ? 900 : 300
      })
    }
  },
  cozy: {
    root: 67, // G4
    space: { room: 0.84, damp: 0.5, wet: 0.2 },
    lowpass: 4200,
    note: (tr, t, f, len, vel, rand) => {
      tine(tr, t, f, len + 0.4, { gain: vel, decay: 0.3 + len * 0.4 }, rand)
      pluck(tr, t, f / 2, len + 0.3, { gain: vel * 0.35, damping: 0.995, brightness: 0.35 }, rand)
    },
    click: (tr, t, o, rand) => tine(tr, t, o.body * 1.2, 0.09, { gain: 0.9, decay: 0.03 }, rand),
    whoosh: (tr, t, dur, f1, f2, rand) =>
      whoosh(tr, t, dur, f1 * 0.6, f2 * 0.6, { gain: 0.35 }, rand)
  },
  arcade: {
    root: 72, // C5
    space: { room: 0.5, damp: 0.5, wet: 0 },
    lowpass: 12000,
    targetOffset: -1,
    speed: 0.7,
    note: (tr, t, f, len, vel) =>
      chip(tr, t, f, Math.min(0.26, len * 0.6 + 0.06), {
        gain: vel,
        duty: 0.25,
        decay: 0.08 + len * 0.15
      }),
    click: (tr, t, o) =>
      chip(tr, t, o.body * 1.4, 0.045, {
        gain: 0.9,
        duty: 0.5,
        decay: 0.03,
        slide: o.bodyEnd > o.body ? 0.5 : -0.4
      }),
    whoosh: (tr, t, dur, f1, f2) =>
      chip(tr, t, f1 < f2 ? 300 : 900, dur * 0.8, {
        gain: 0.6,
        duty: 0.125,
        decay: dur,
        slide: f1 < f2 ? 1.6 : -0.65
      })
  }
}

function renderEvent(packId, event, seed) {
  const pack = PACKS[packId]
  const [cls, kind, spec] = EVENTS[event]
  const rand = rng(seed)
  const tr = new Track(3)
  const speed = pack.speed ?? 1
  const notes = Array.isArray(spec) ? spec : []
  const playNotes = (list) => {
    const use = pack.shorten
      ? list.slice(-Math.min(2, list.length)).map((n, i) => [i * 0.06, n[1], n[2], n[3]])
      : list
    for (const [at, semis, len, vel] of use) {
      pack.note(tr, at * speed, midiHz(pack.root + semis), len, vel, rand)
    }
  }
  if (kind === 'notes') playNotes(notes)
  else if (kind === 'rise') {
    pack.whoosh(tr, 0, 0.42, 500, 3800, rand)
    playNotes(notes)
  } else if (kind === 'fall') {
    pack.whoosh(tr, 0, 0.4, 3600, 450, rand)
    playNotes(notes)
  } else if (kind === 'click') pack.click(tr, 0, spec, rand)
  else if (kind === 'click2') {
    pack.click(tr, 0, spec, rand)
    const up = spec.bodyEnd > spec.body
    pack.click(tr, 0.075, { body: spec.bodyEnd, bodyEnd: spec.bodyEnd * (up ? 1.2 : 0.8) }, rand)
  } else if (kind === 'tick') pack.click(tr, 0, { ...spec }, rand)
  // Tone shaping and space.
  filterInPlace(tr.d, biquad('lowpass', pack.lowpass, 0.6))
  if (pack.echo) {
    const [delay, level] = pack.echo
    const d = Math.round(delay * SR)
    for (let i = tr.d.length - 1; i >= d; i--) tr.d[i] += tr.d[i - d] * level
  }
  reverb(tr.d, pack.space)
  return master(tr, TARGET[cls] + (pack.targetOffset ?? 0), seed ^ 0x5bd1e995)
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const manifest = {
  generator: 'desktop/scripts/sounds/render-sounds.mjs',
  license: 'Original work for Discord 2.0 (procedural synthesis; no samples or third-party audio).',
  format: { container: 'WAV', codec: 'PCM s16le', sampleRate: SR, channels: 1 },
  loudnessTargetsLufs: TARGET,
  peakCeilingDbfs: PEAK_CEILING_DB,
  packs: {}
}
let mismatches = 0
let seed = 1000
for (const packId of Object.keys(PACKS)) {
  manifest.packs[packId] = {}
  mkdirSync(join(OUT, packId), { recursive: true })
  for (const event of Object.keys(EVENTS)) {
    seed += 1
    const { pcm, floats } = renderEvent(packId, event, seed)
    const file = wav(pcm)
    const path = join(OUT, packId, `${event}.wav`)
    const sha256 = createHash('sha256').update(file).digest('hex')
    if (CHECK) {
      const existing = existsSync(path)
        ? createHash('sha256').update(readFileSync(path)).digest('hex')
        : null
      if (existing !== sha256) {
        mismatches++
        console.error(`differs: ${packId}/${event}.wav`)
      }
    } else {
      writeFileSync(path, file)
    }
    manifest.packs[packId][event] = {
      file: `${packId}/${event}.wav`,
      class: EVENTS[event][0],
      bytes: file.length,
      sha256,
      ...metrics(floats)
    }
  }
}
if (CHECK) {
  console.log(
    mismatches === 0 ? 'All sound files match a fresh render.' : `${mismatches} file(s) differ.`
  )
  process.exit(mismatches === 0 ? 0 : 1)
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
const all = Object.values(manifest.packs).flatMap((p) => Object.values(p))
console.log(
  JSON.stringify(
    {
      files: all.length,
      totalBytes: all.reduce((s, f) => s + f.bytes, 0),
      maxPeakDbfs: Math.max(...all.map((f) => f.peakDbfs)),
      maxTruePeakApprox: Math.max(...all.map((f) => f.truePeakDbfsApprox)),
      clipped: all.reduce((s, f) => s + f.clippedSamples, 0),
      maxDurationMs: Math.max(...all.map((f) => f.durationMs)),
      minDurationMs: Math.min(...all.map((f) => f.durationMs)),
      maxLeadingSilenceMs: Math.max(...all.map((f) => f.leadingSilenceMs)),
      maxAbsEdge: Math.max(...all.flatMap((f) => f.edgeSamples.map(Math.abs))),
      lufsRange: [
        Math.min(...all.map((f) => f.momentaryMaxLufs)),
        Math.max(...all.map((f) => f.momentaryMaxLufs))
      ]
    },
    null,
    1
  )
)
