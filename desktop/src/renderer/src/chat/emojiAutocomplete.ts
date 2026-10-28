/**
 * ":name" emoji autocomplete for the composer (pure, unit-tested). Uses the same curated emoji
 * list as the picker (chat/emoji.ts) — no external data.
 */
import { ALL_EMOJI, type EmojiEntry } from './emoji'

/** At least this many characters after ":" before suggestions appear (":)" stays a smiley). */
export const MIN_QUERY = 2

export interface EmojiQuery {
  /** Index of the ":" in the text. */
  start: number
  /** What was typed after ":" (lower-case). */
  query: string
}

const TOKEN = /^[a-z0-9_+-]+$/

/**
 * The ":query" being typed at the caret, or null. The ":" must start the text or follow
 * whitespace or an opening bracket, so times ("10:30") and URLs ("http://") don't trigger it.
 */
export function findEmojiQuery(text: string, caret: number): EmojiQuery | null {
  const before = text.slice(0, caret)
  const colon = before.lastIndexOf(':')
  if (colon < 0) return null
  const query = before.slice(colon + 1).toLowerCase()
  if (query.length < MIN_QUERY || query.length > 32 || !TOKEN.test(query)) return null
  const prev = colon > 0 ? before[colon - 1]! : ''
  if (prev && !/[\s([{]/.test(prev)) return null
  return { start: colon, query }
}

const nameOf = (entry: EmojiEntry): string => entry.keywords.split(' ')[0]!

/** Best matches: name starts with the query, then any keyword does, then contains it. */
export function suggestEmoji(query: string, limit = 8): EmojiEntry[] {
  const q = query.toLowerCase()
  const scored: { entry: EmojiEntry; score: number }[] = []
  for (const entry of ALL_EMOJI) {
    const words = entry.keywords.split(' ')
    const score = words[0]!.startsWith(q)
      ? 3
      : words.some((w) => w.startsWith(q))
        ? 2
        : entry.keywords.includes(q)
          ? 1
          : 0
    if (score > 0) scored.push({ entry, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || nameOf(a.entry).length - nameOf(b.entry).length)
    .slice(0, limit)
    .map((s) => s.entry)
}

/** The emoji whose name is exactly `name` (for ":name:" typed in full). */
export function emojiByName(name: string): EmojiEntry | undefined {
  const n = name.toLowerCase()
  return ALL_EMOJI.find((entry) => nameOf(entry) === n)
}

/** Replaces text[start, caret) with the emoji (plus a space) and returns the new caret. */
export function insertEmojiAt(
  text: string,
  start: number,
  caret: number,
  emoji: string,
  maxLength: number
): { text: string; caret: number } {
  const after = text.slice(caret)
  const insert = after.startsWith(' ') ? emoji : `${emoji} `
  const next = (text.slice(0, start) + insert + after).slice(0, maxLength)
  return { text: next, caret: Math.min(next.length, start + insert.length) }
}

/**
 * If the text just typed completed ":name:" for a known emoji, the replacement; otherwise null.
 * `caret` is right after the closing ":".
 */
export function completeEmojiShortcode(
  text: string,
  caret: number,
  maxLength: number
): { text: string; caret: number; emoji: string } | null {
  if (text[caret - 1] !== ':') return null
  const open = findEmojiQuery(text, caret - 1)
  if (!open) return null
  const entry = emojiByName(open.query)
  if (!entry) return null
  const after = text.slice(caret)
  const next = (text.slice(0, open.start) + entry.emoji + after).slice(0, maxLength)
  return { text: next, caret: open.start + entry.emoji.length, emoji: entry.emoji }
}

export const emojiName = nameOf
