/**
 * Who a message mentions, using the same parser as message rendering (so mentions inside code
 * blocks or escaped with "\@" never count, exactly as they don't render as mentions).
 */
import { mentionCandidates, normalizeName } from './mentionMatch'
import { parseMarkdown, type Block, type Inline } from './markdown'

export interface MentionTarget {
  username: string
  displayName: string
}

/** The names that mention this person: their username, display name, and "everyone". */
export function selfMentionNames(me: MentionTarget): string[] {
  return mentionCandidates([me.username, me.displayName, 'everyone'])
}

function collect(nodes: Inline[], out: string[]): void {
  for (const node of nodes) {
    if (node.type === 'mention') out.push(normalizeName(node.text.slice(1)))
    else if ('children' in node) collect(node.children, out)
  }
}

function walk(blocks: Block[], out: string[]): void {
  for (const block of blocks) {
    if (block.type === 'paragraph') collect(block.children, out)
    else if (block.type === 'quote') walk(block.children, out)
  }
}

/** Normalized names mentioned in a message (without "@"). */
export function extractMentions(content: string, candidates: readonly string[]): string[] {
  if (!content.includes('@')) return []
  const out: string[] = []
  walk(parseMarkdown(content, { mentionNames: candidates }), out)
  return out
}

/**
 * Whether `content` mentions `me`. `knownNames` (everyone's usernames and display names) lets
 * a longer name win: "@Ann Lee" mentions Ann Lee, not a user called "Ann".
 */
export function mentionsUser(
  content: string,
  me: MentionTarget,
  knownNames: readonly string[] = []
): boolean {
  return createMentionDetector(me, knownNames).mentions(content)
}

export interface MentionDetector {
  /** Normalized candidate names (pass to the Markdown renderer as `mentionNames`). */
  candidates: readonly string[]
  /** Names that mention the current user (for self-mention highlighting). */
  selfNames: ReadonlySet<string>
  mentions: (content: string) => boolean
}

/** A detector with a small cache, for checking many messages against the same names. */
export function createMentionDetector(
  me: MentionTarget,
  knownNames: Iterable<string>
): MentionDetector {
  const self = selfMentionNames(me)
  const candidates = mentionCandidates([...knownNames, ...self])
  const selfNames = new Set(self)
  const cache = new Map<string, boolean>()
  return {
    candidates,
    selfNames,
    mentions: (content) => {
      const hit = cache.get(content)
      if (hit !== undefined) return hit
      const result = extractMentions(content, candidates).some((name) => selfNames.has(name))
      if (cache.size >= 1000) cache.delete(cache.keys().next().value as string)
      cache.set(content, result)
      return result
    }
  }
}
