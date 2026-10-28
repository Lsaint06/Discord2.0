/**
 * Daily Word (Milestone 13): an original five-letter word game. Everyone gets the same word on
 * the same UTC day; practice games use random words and don't touch the stats. Pure logic only
 * (scoring, the daily word, stats, the spoiler-free share text) — see games/words.ts for the
 * word lists and components/games/WordGame.tsx for the UI.
 */
import { ANSWERS, GUESSES } from './words'

export const WORD_LENGTH = 5
export const MAX_GUESSES = 6

export type LetterState = 'correct' | 'present' | 'absent'

/** Puzzle #1 is 1 January 2026 (UTC). */
const EPOCH_DAY = Date.UTC(2026, 0, 1) / 86_400_000

/** The puzzle number for a moment in time (by UTC date). */
export function puzzleNumber(now: number): number {
  return Math.floor(now / 86_400_000) - EPOCH_DAY + 1
}

/** Small deterministic PRNG (mulberry32): the daily order is the same for everyone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let dailyOrder: string[] | null = null
function order(): string[] {
  if (!dailyOrder) {
    const list = [...ANSWERS]
    const random = mulberry32(0xd20d20)
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[list[i], list[j]] = [list[j]!, list[i]!]
    }
    dailyOrder = list
  }
  return dailyOrder
}

/** The word for a puzzle number (cycles through every answer before repeating). */
export function dailyAnswer(puzzle: number): string {
  const list = order()
  return list[(((puzzle - 1) % list.length) + list.length) % list.length]!
}

/** A practice word (never today's). */
export function practiceAnswer(random: () => number, avoid: string): string {
  for (;;) {
    const word = ANSWERS[Math.floor(random() * ANSWERS.length)]!
    if (word !== avoid) return word
  }
}

export function isValidGuess(word: string): boolean {
  return GUESSES.has(word)
}

/**
 * Scores a guess. Exact matches first, then other letters left to right, each answer letter
 * used at most once (so a doubled letter in the guess is only "present" as often as it occurs).
 */
export function scoreGuess(guess: string, answer: string): LetterState[] {
  const result: LetterState[] = Array.from({ length: WORD_LENGTH }, () => 'absent')
  const remaining = new Map<string, number>()
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guess[i] === answer[i]) result[i] = 'correct'
    else remaining.set(answer[i]!, (remaining.get(answer[i]!) ?? 0) + 1)
  }
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (result[i] === 'correct') continue
    const left = remaining.get(guess[i]!) ?? 0
    if (left > 0) {
      result[i] = 'present'
      remaining.set(guess[i]!, left - 1)
    }
  }
  return result
}

const RANK: Record<LetterState, number> = { absent: 1, present: 2, correct: 3 }

/** The best known state of each letter (for the on-screen keyboard). */
export function letterStates(guesses: string[], answer: string): Record<string, LetterState> {
  const out: Record<string, LetterState> = {}
  for (const guess of guesses) {
    scoreGuess(guess, answer).forEach((state, i) => {
      const letter = guess[i]!
      if (!out[letter] || RANK[state] > RANK[out[letter]!]) out[letter] = state
    })
  }
  return out
}

export type GameStatus = 'playing' | 'won' | 'lost'

export function gameStatus(guesses: string[], answer: string): GameStatus {
  if (guesses.includes(answer)) return 'won'
  return guesses.length >= MAX_GUESSES ? 'lost' : 'playing'
}

// ---- Stats ----

export interface WordStats {
  played: number
  wins: number
  currentStreak: number
  maxStreak: number
  /** Wins by number of guesses (index 0 = in one). */
  distribution: number[]
  /** Last daily puzzle that was finished (streaks need consecutive puzzles). */
  lastPuzzle: number | null
  lastWonPuzzle: number | null
}

export const EMPTY_STATS: WordStats = {
  played: 0,
  wins: 0,
  currentStreak: 0,
  maxStreak: 0,
  distribution: [0, 0, 0, 0, 0, 0],
  lastPuzzle: null,
  lastWonPuzzle: null
}

/** Records a finished daily puzzle (a puzzle is only counted once). */
export function recordResult(
  stats: WordStats,
  puzzle: number,
  won: boolean,
  guesses: number
): WordStats {
  if (stats.lastPuzzle !== null && puzzle <= stats.lastPuzzle) return stats
  const distribution = [...stats.distribution]
  if (won) distribution[Math.min(MAX_GUESSES, Math.max(1, guesses)) - 1]! += 1
  const streak = won ? (stats.lastWonPuzzle === puzzle - 1 ? stats.currentStreak + 1 : 1) : 0
  return {
    played: stats.played + 1,
    wins: stats.wins + (won ? 1 : 0),
    currentStreak: streak,
    maxStreak: Math.max(stats.maxStreak, streak),
    distribution,
    lastPuzzle: puzzle,
    lastWonPuzzle: won ? puzzle : stats.lastWonPuzzle
  }
}

/** The streak as it stands today (a missed day breaks it, even before you play again). */
export function liveStreak(stats: WordStats, today: number): number {
  return stats.lastWonPuzzle !== null && stats.lastWonPuzzle >= today - 1 ? stats.currentStreak : 0
}

/** Validates stored stats (anything odd starts fresh). */
export function parseStats(raw: unknown): WordStats {
  const s = raw as Partial<WordStats> | null
  const n = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0)
  const puzzle = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) ? v : null
  if (!s || typeof s !== 'object')
    return { ...EMPTY_STATS, distribution: [...EMPTY_STATS.distribution] }
  const distribution =
    Array.isArray(s.distribution) && s.distribution.length === MAX_GUESSES
      ? s.distribution.map(n)
      : [...EMPTY_STATS.distribution]
  return {
    played: n(s.played),
    wins: Math.min(n(s.wins), n(s.played)),
    currentStreak: n(s.currentStreak),
    maxStreak: n(s.maxStreak),
    distribution,
    lastPuzzle: puzzle(s.lastPuzzle),
    lastWonPuzzle: puzzle(s.lastWonPuzzle)
  }
}

// ---- Sharing (no letters, so nothing is spoiled) ----

const SQUARES: Record<LetterState, string> = { correct: '🟩', present: '🟨', absent: '⬛' }
const CONTRAST_SQUARES: Record<LetterState, string> = { correct: '🟧', present: '🟦', absent: '⬛' }

export function shareText(
  puzzle: number,
  guesses: string[],
  answer: string,
  options: { highContrast?: boolean } = {}
): string {
  const squares = options.highContrast ? CONTRAST_SQUARES : SQUARES
  const status = gameStatus(guesses, answer)
  const score = status === 'won' ? `${guesses.length}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`
  const rows = guesses.map((g) =>
    scoreGuess(g, answer)
      .map((s) => squares[s])
      .join('')
  )
  return [`Daily Word #${puzzle} ${score}`, '', ...rows].join('\n')
}

/** Screen-reader description of a scored guess. */
export function describeGuess(guess: string, states: LetterState[]): string {
  const words: Record<LetterState, string> = {
    correct: 'correct',
    present: 'in the word, wrong spot',
    absent: 'not in the word'
  }
  return guess
    .toUpperCase()
    .split('')
    .map((letter, i) => `${letter} ${words[states[i]!]}`)
    .join(', ')
}
