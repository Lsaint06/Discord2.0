/**
 * Low-level @mention matching shared by the Markdown parser and mention detection, so
 * highlighting, notifications and sounds all follow exactly the same rule:
 * - "@" must start the text or follow whitespace or opening punctuation (emails don't match);
 * - known names (usernames, display names — including multi-word ones — and "everyone") are
 *   matched case-insensitively, longest first, and must end at a word boundary;
 * - otherwise a single-word "@token" is still a mention (trailing "." or "-" excluded).
 */

const WORD = /[\p{L}\p{N}_]/u
const MAX_NAME_LENGTH = 32
const GENERIC = /^@[\p{L}\p{N}_.-]{1,32}/u

/** Lower-cased, NFC-normalized form used for comparing names. */
export function normalizeName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Unique, non-empty, normalized candidate names, longest first (so "Ann Lee" beats "Ann"). */
export function mentionCandidates(names: Iterable<string>): string[] {
  const unique = new Set<string>()
  for (const name of names) {
    const n = normalizeName(name)
    if (n && n.length <= MAX_NAME_LENGTH) unique.add(n)
  }
  return [...unique].sort((a, b) => b.length - a.length || a.localeCompare(b))
}

/** Can a mention start at `i` (src[i] === '@')? */
export function mentionStartAllowed(src: string, i: number): boolean {
  if (src[i] !== '@') return false
  if (i === 0) return true
  const prev = src[i - 1]!
  return /\s/.test(prev) || /[([{"'“‘>*_~|]/.test(prev)
}

/** Does a name that ends at `end` stop at a word boundary? */
function endsAtBoundary(src: string, end: number): boolean {
  const next = src[end]
  if (next === undefined) return true
  if (WORD.test(next)) return false
  // "@bob.smith" is not "@bob", but "@bob." (end of sentence) is.
  if ((next === '.' || next === '-') && src[end + 1] !== undefined && WORD.test(src[end + 1]!)) {
    return false
  }
  return true
}

/**
 * The mention text (including "@") starting at `i`, or null. `candidates` come from
 * mentionCandidates().
 */
export function matchMentionAt(
  src: string,
  i: number,
  candidates: readonly string[]
): string | null {
  if (!mentionStartAllowed(src, i)) return null
  for (const name of candidates) {
    // Compare a same-length slice so offsets stay aligned with the original text.
    const slice = src.slice(i + 1, i + 1 + name.length)
    if (
      slice.length === name.length &&
      slice.normalize('NFC').toLowerCase() === name &&
      endsAtBoundary(src, i + 1 + name.length)
    ) {
      return src.slice(i, i + 1 + name.length)
    }
  }
  const generic = GENERIC.exec(src.slice(i))
  if (!generic) return null
  const text = generic[0].replace(/[.-]+$/, '')
  return text.length > 1 ? text : null
}
