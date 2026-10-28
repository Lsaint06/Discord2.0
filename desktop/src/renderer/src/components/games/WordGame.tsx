import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  EMPTY_STATS,
  MAX_GUESSES,
  WORD_LENGTH,
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
  shareText,
  type LetterState,
  type WordStats
} from '../../games/wordGame'
import { anyDialogOpen } from '../../lib/focusTrap'

interface Saved {
  daily: { puzzle: number; guesses: string[] } | null
  stats: WordStats
  highContrast: boolean
}

const storageKey = (userId: string): string => `d2.wordgame.${userId}`

function load(userId: string): Saved {
  try {
    const raw = JSON.parse(
      localStorage.getItem(storageKey(userId)) ?? 'null'
    ) as Partial<Saved> | null
    const daily =
      raw?.daily &&
      typeof raw.daily.puzzle === 'number' &&
      Array.isArray(raw.daily.guesses) &&
      raw.daily.guesses.every((g) => typeof g === 'string' && isValidGuess(g))
        ? { puzzle: raw.daily.puzzle, guesses: raw.daily.guesses.slice(0, MAX_GUESSES) }
        : null
    return { daily, stats: parseStats(raw?.stats), highContrast: raw?.highContrast === true }
  } catch {
    return { daily: null, stats: { ...EMPTY_STATS }, highContrast: false }
  }
}

const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']
const PRAISE = ['Genius!', 'Magnificent!', 'Impressive!', 'Splendid!', 'Great!', 'Phew!']
const STATE_WORDS: Record<LetterState, string> = {
  correct: 'correct',
  present: 'in the word',
  absent: 'not in the word'
}

/** Daily Word: a five-letter word game (one daily puzzle by UTC date, plus practice). */
function WordGame({ userId }: { userId: string }): React.JSX.Element {
  const [today] = useState(() => puzzleNumber(Date.now()))
  const [saved, setSaved] = useState<Saved>(() => load(userId))
  const [mode, setMode] = useState<'daily' | 'practice'>('daily')
  const [practice, setPractice] = useState(() => ({
    answer: practiceAnswer(Math.random, dailyAnswer(today)),
    guesses: [] as string[]
  }))
  const [input, setInput] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [shake, setShake] = useState(0)
  const rootRef = useRef<HTMLElement>(null)

  useEffect(() => {
    localStorage.setItem(storageKey(userId), JSON.stringify(saved))
  }, [userId, saved])

  const dailyGuesses = saved.daily?.puzzle === today ? saved.daily.guesses : []
  const answer = mode === 'daily' ? dailyAnswer(today) : practice.answer
  const guesses = mode === 'daily' ? dailyGuesses : practice.guesses
  const status = gameStatus(guesses, answer)
  const keys = useMemo(() => letterStates(guesses, answer), [guesses, answer])

  const reject = (text: string): void => {
    setMessage(text)
    setAnnouncement(text)
    setShake((n) => n + 1)
  }

  const submit = (): void => {
    if (status !== 'playing') return
    if (input.length < WORD_LENGTH) return reject('Not enough letters')
    if (!isValidGuess(input)) return reject('Not in the word list')
    const next = [...guesses, input]
    const result = gameStatus(next, answer)
    let note = `Guess ${next.length}: ${describeGuess(input, scoreGuess(input, answer))}.`
    if (result === 'won') note += ` ${PRAISE[next.length - 1]} You found the word.`
    if (result === 'lost') note += ` The word was ${answer.toUpperCase()}.`
    setAnnouncement(note)
    setMessage(
      result === 'won'
        ? PRAISE[next.length - 1]!
        : result === 'lost'
          ? `The word was ${answer.toUpperCase()}`
          : null
    )
    setInput('')
    if (mode === 'daily') {
      setSaved((prev) => ({
        ...prev,
        daily: { puzzle: today, guesses: next },
        stats:
          result === 'playing'
            ? prev.stats
            : recordResult(prev.stats, today, result === 'won', next.length)
      }))
    } else {
      setPractice((p) => ({ ...p, guesses: next }))
    }
  }

  const press = (key: string): void => {
    if (status !== 'playing') return
    if (key === 'Enter') submit()
    else if (key === 'Backspace') setInput((v) => v.slice(0, -1))
    else if (/^[a-z]$/.test(key)) {
      setMessage(null)
      setInput((v) => (v.length < WORD_LENGTH ? v + key : v))
    }
  }
  const pressRef = useRef(press)
  useEffect(() => {
    pressRef.current = press
  })

  // Typing works anywhere on the page (not while another field or a dialog has the keyboard).
  const onWindowKey = useCallback((e: KeyboardEvent): void => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.repeat || e.defaultPrevented) return
    const target = e.target as HTMLElement | null
    if (target?.closest('input, textarea, select, [contenteditable="true"]') || anyDialogOpen())
      return
    // Enter on a button elsewhere (sidebar…) belongs to that button.
    if (e.key === 'Enter' && target?.closest('button') && !rootRef.current?.contains(target)) return
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (key === 'Enter' || key === 'Backspace' || /^[a-z]$/.test(key)) {
      // A focused on-screen key would also "click" on Enter: handle it once, here.
      e.preventDefault()
      pressRef.current(key)
    }
  }, [])
  useEffect(() => {
    window.addEventListener('keydown', onWindowKey)
    return () => window.removeEventListener('keydown', onWindowKey)
  }, [onWindowKey])

  const switchMode = (next: 'daily' | 'practice'): void => {
    setMode(next)
    setInput('')
    setMessage(null)
  }

  const copyResult = (): void => {
    const text = shareText(today, dailyGuesses, dailyAnswer(today), {
      highContrast: saved.highContrast
    })
    navigator.clipboard.writeText(text).then(
      () => setMessage('Result copied — paste it in a chat (no spoilers)'),
      () => setMessage('Couldn’t copy the result')
    )
  }

  const stats = saved.stats
  const streak = liveStreak(stats, today)
  const maxDist = Math.max(1, ...stats.distribution)
  const rows = Array.from({ length: MAX_GUESSES }, (_, r) => {
    if (r < guesses.length) return { word: guesses[r]!, states: scoreGuess(guesses[r]!, answer) }
    if (r === guesses.length && status === 'playing') return { word: input, states: null }
    return { word: '', states: null }
  })

  return (
    <main
      ref={rootRef}
      className={`chat-panel word-game${saved.highContrast ? ' high-contrast' : ''}`}
      aria-labelledby="word-game-title"
    >
      <header className="chat-header word-game-header">
        <h1 id="word-game-title">Daily Word</h1>
        <div className="word-game-modes" role="tablist" aria-label="Game">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'daily'}
            className={`button small ${mode === 'daily' ? 'primary' : 'secondary'}`}
            onClick={() => switchMode('daily')}
          >
            Today #{today}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'practice'}
            className={`button small ${mode === 'practice' ? 'primary' : 'secondary'}`}
            onClick={() => switchMode('practice')}
          >
            Practice
          </button>
        </div>
        <label className="checkbox-row word-game-contrast">
          <input
            type="checkbox"
            checked={saved.highContrast}
            onChange={(e) => setSaved((prev) => ({ ...prev, highContrast: e.target.checked }))}
          />
          High-contrast colours
        </label>
      </header>

      <div className="word-game-body">
        <p className="word-game-help">
          Guess the five-letter word in six tries.{' '}
          {saved.highContrast
            ? 'Orange: right letter, right spot. Blue: in the word, wrong spot.'
            : 'Green: right letter, right spot. Yellow: in the word, wrong spot.'}{' '}
          Type, or use the keys below.{' '}
          {mode === 'daily'
            ? 'Everyone gets the same word each day (UTC).'
            : 'Practice games don’t count in your stats.'}
        </p>

        <div className="word-board" role="grid" aria-label="Guesses">
          {rows.map((row, r) => {
            const current = r === guesses.length && status === 'playing'
            return (
              <div
                key={current ? `current-${shake}` : r}
                role="row"
                className={`word-row${current && shake ? ' shake' : ''}`}
                aria-label={
                  row.states
                    ? `Guess ${r + 1}: ${describeGuess(row.word, row.states)}`
                    : current
                      ? `Current guess: ${row.word.toUpperCase() || 'empty'}`
                      : `Guess ${r + 1}: empty`
                }
              >
                {Array.from({ length: WORD_LENGTH }, (_, i) => {
                  const letter = row.word[i] ?? ''
                  const state = row.states?.[i]
                  return (
                    <span
                      key={i}
                      role="gridcell"
                      aria-hidden="true"
                      className={`word-tile${letter ? ' filled' : ''}${state ? ` ${state} revealed` : ''}`}
                      style={
                        state
                          ? ({ '--reveal-delay': `${i * 90}ms` } as React.CSSProperties)
                          : undefined
                      }
                    >
                      {letter.toUpperCase()}
                    </span>
                  )
                })}
              </div>
            )
          })}
        </div>

        <p className="word-game-message" aria-hidden="true">
          {message}
        </p>
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>

        {status === 'playing' ? (
          <div className="word-keyboard" aria-label="Keyboard">
            {KEY_ROWS.map((row, r) => (
              <div key={row} className="word-keyboard-row">
                {r === 2 && (
                  <button type="button" className="word-key wide" onClick={() => press('Enter')}>
                    Enter
                  </button>
                )}
                {row.split('').map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`word-key${keys[k] ? ` ${keys[k]}` : ''}`}
                    onClick={() => press(k)}
                    aria-label={
                      keys[k] ? `${k.toUpperCase()}, ${STATE_WORDS[keys[k]!]}` : k.toUpperCase()
                    }
                  >
                    {k.toUpperCase()}
                  </button>
                ))}
                {r === 2 && (
                  <button
                    type="button"
                    className="word-key wide"
                    onClick={() => press('Backspace')}
                    aria-label="Delete letter"
                  >
                    ⌫
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : mode === 'daily' ? (
          <section className="word-stats" aria-label="Statistics">
            <dl className="word-stats-numbers">
              <div>
                <dt>Played</dt>
                <dd>{stats.played}</dd>
              </div>
              <div>
                <dt>Win %</dt>
                <dd>{stats.played ? Math.round((stats.wins / stats.played) * 100) : 0}</dd>
              </div>
              <div>
                <dt>Streak</dt>
                <dd>{streak}</dd>
              </div>
              <div>
                <dt>Best streak</dt>
                <dd>{stats.maxStreak}</dd>
              </div>
            </dl>
            <ol className="word-distribution" aria-label="Wins by number of guesses">
              {stats.distribution.map((count, i) => (
                <li key={i} aria-label={`${i + 1} ${i === 0 ? 'guess' : 'guesses'}: ${count}`}>
                  <span aria-hidden="true">{i + 1}</span>
                  <span
                    className={`word-bar${status === 'won' && guesses.length === i + 1 ? ' current' : ''}`}
                    style={{ width: `${Math.max(8, (count / maxDist) * 100)}%` }}
                    aria-hidden="true"
                  >
                    {count}
                  </span>
                </li>
              ))}
            </ol>
            <div className="inline-actions">
              <button type="button" className="button primary" onClick={copyResult}>
                Copy result
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => switchMode('practice')}
              >
                Play a practice word
              </button>
            </div>
            <p className="settings-note">A new word arrives at midnight UTC.</p>
          </section>
        ) : (
          <div className="inline-actions word-practice-again">
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setPractice({
                  answer: practiceAnswer(Math.random, dailyAnswer(today)),
                  guesses: []
                })
                setMessage(null)
                setAnnouncement('New practice word.')
              }}
            >
              New practice word
            </button>
          </div>
        )}
      </div>
    </main>
  )
}

export default WordGame
