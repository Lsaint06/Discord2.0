import { describe, expect, it } from 'vitest'
import { ANSWERS, DICTIONARY, GUESSES, MORE_GUESSES } from './words'
import {
  EMPTY_STATS,
  MAX_GUESSES,
  dailyAnswer,
  describeGuess,
  gameStatus,
  isValidGuess,
  letterStates,
  liveStreak,
  parseStats,
  practiceAnswer,
  puzzleNumber,
  recordResult,
  scoreGuess,
  shareText
} from './wordGame'

describe('word lists', () => {
  it('are five lowercase letters, without duplicates', () => {
    for (const w of [...ANSWERS, ...MORE_GUESSES]) expect(w).toMatch(/^[a-z]{5}$/)
    expect(new Set(ANSWERS).size).toBe(ANSWERS.length)
    expect(ANSWERS.length).toBeGreaterThan(300)
    for (const w of ANSWERS) expect(GUESSES.has(w)).toBe(true)
  })

  it('accept real words beyond the curated lists, but not gibberish', () => {
    expect(DICTIONARY.length).toBe(8636)
    for (const w of DICTIONARY) expect(w).toMatch(/^[a-z]{5}$/)
    expect([...DICTIONARY].sort()).toEqual(DICTIONARY)
    expect(new Set(DICTIONARY).size).toBe(DICTIONARY.length)
    // Every curated answer is a real dictionary word (guards against typos).
    const dictionary = new Set(DICTIONARY)
    expect(ANSWERS.filter((w) => !dictionary.has(w))).toEqual([])
    for (const w of ['mound', 'chomp', 'fjord', 'pious', 'dumpy', 'email'])
      expect(isValidGuess(w)).toBe(true)
    for (const w of ['qzxjk', 'aaaaa', 'abcde']) expect(isValidGuess(w)).toBe(false)
  })
})

describe('daily word', () => {
  it('numbers puzzles by UTC date', () => {
    expect(puzzleNumber(Date.UTC(2026, 0, 1, 0, 0))).toBe(1)
    expect(puzzleNumber(Date.UTC(2026, 0, 1, 23, 59))).toBe(1)
    expect(puzzleNumber(Date.UTC(2026, 0, 2, 0, 0))).toBe(2)
    expect(puzzleNumber(Date.UTC(2026, 9, 28, 12))).toBe(301)
  })

  it('is the same for everyone and cycles through every answer', () => {
    expect(dailyAnswer(42)).toBe(dailyAnswer(42))
    const seen = new Set(Array.from({ length: ANSWERS.length }, (_, i) => dailyAnswer(i + 1)))
    expect(seen.size).toBe(ANSWERS.length)
    expect(dailyAnswer(1)).toBe(dailyAnswer(1 + ANSWERS.length))
  })

  it('practice words avoid today’s', () => {
    let i = 0
    const values = [0, 0, 0.5]
    const today = ANSWERS[0]!
    expect(practiceAnswer(() => values[i++] ?? 0.5, today)).not.toBe(today)
  })
})

describe('scoring', () => {
  it('marks correct, present and absent letters', () => {
    expect(scoreGuess('crane', 'cream')).toEqual([
      'correct',
      'correct',
      'present',
      'absent',
      'present'
    ])
    expect(scoreGuess('cream', 'cream')).toEqual(Array(5).fill('correct'))
  })

  it('counts doubled letters only as often as the answer has them', () => {
    // "apple" has one "l"; "lilac" guesses two, so only the first is marked.
    expect(scoreGuess('lilac', 'apple')).toEqual([
      'present',
      'absent',
      'absent',
      'present',
      'absent'
    ])
    // The exact match wins over an earlier misplaced copy.
    expect(scoreGuess('eerie', 'there')).toEqual([
      'present',
      'absent',
      'present',
      'absent',
      'correct'
    ])
    expect(scoreGuess('geese', 'beach')).toEqual([
      'absent',
      'correct',
      'absent',
      'absent',
      'absent'
    ])
  })

  it('keeps the best state per key and knows when the game ends', () => {
    const states = letterStates(['crane', 'cream'], 'cream')
    expect(states.c).toBe('correct')
    expect(states.n).toBe('absent')
    expect(gameStatus(['crane'], 'cream')).toBe('playing')
    expect(gameStatus(['crane', 'cream'], 'cream')).toBe('won')
    expect(gameStatus(Array(MAX_GUESSES).fill('crane'), 'cream')).toBe('lost')
    expect(isValidGuess('crane')).toBe(true)
    expect(isValidGuess('qzxjk')).toBe(false)
  })
})

describe('stats and streaks', () => {
  it('counts wins, streaks and the distribution, once per puzzle', () => {
    let s = recordResult(EMPTY_STATS, 10, true, 3)
    s = recordResult(s, 11, true, 4)
    expect(s).toMatchObject({ played: 2, wins: 2, currentStreak: 2, maxStreak: 2 })
    expect(s.distribution).toEqual([0, 0, 1, 1, 0, 0])
    expect(recordResult(s, 11, true, 2)).toBe(s)
    s = recordResult(s, 13, true, 2)
    expect(s.currentStreak).toBe(1)
    expect(s.maxStreak).toBe(2)
    s = recordResult(s, 14, false, 6)
    expect(s).toMatchObject({ played: 4, wins: 3, currentStreak: 0 })
  })

  it('a missed day shows a broken streak right away', () => {
    const s = recordResult(EMPTY_STATS, 10, true, 3)
    expect(liveStreak(s, 10)).toBe(1)
    expect(liveStreak(s, 11)).toBe(1)
    expect(liveStreak(s, 12)).toBe(0)
  })

  it('reads stored stats defensively', () => {
    expect(parseStats(null)).toEqual(EMPTY_STATS)
    expect(parseStats({ played: 3, wins: 9, distribution: [1, 2] })).toMatchObject({
      played: 3,
      wins: 3,
      distribution: [0, 0, 0, 0, 0, 0]
    })
  })
})

describe('sharing', () => {
  it('shows only colours, never letters', () => {
    const text = shareText(301, ['crane', 'cream'], 'cream')
    expect(text).toBe('Daily Word #301 2/6\n\n🟩🟩🟨⬛🟨\n🟩🟩🟩🟩🟩')
    expect(text.toLowerCase()).not.toContain('cream')
    expect(shareText(5, Array(6).fill('crane'), 'cream').split('\n')[0]).toBe('Daily Word #5 X/6')
    expect(shareText(5, ['cream'], 'cream', { highContrast: true })).toContain('🟧🟧🟧🟧🟧')
  })

  it('describes a guess for screen readers', () => {
    expect(describeGuess('crane', scoreGuess('crane', 'cream'))).toBe(
      'C correct, R correct, A in the word, wrong spot, N not in the word, E in the word, wrong spot'
    )
  })
})
