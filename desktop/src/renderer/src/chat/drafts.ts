/**
 * Unsent message drafts, one per channel / DM / group, kept per account on this PC so they
 * survive switching conversations and restarting the app. Stored in localStorage under a key
 * that includes the server and the username (accounts never see each other's drafts), pruned to
 * the most recent MAX_DRAFTS, and removed on explicit sign-out. Never logged.
 */
import { LIMITS } from '../net/protocol'

export interface DraftEntry {
  text: string
  /** Last change (epoch ms), for pruning. */
  at: number
}

export type Drafts = Record<string, DraftEntry>

export const MAX_DRAFTS = 200
const PREFIX = 'd2.drafts.'

export function draftsKey(serverUrl: string, username: string): string {
  return `${PREFIX}${serverUrl}|${username.toLowerCase()}`
}

/** Parses stored drafts, dropping anything malformed. */
export function parseDrafts(raw: string | null): Drafts {
  if (!raw) return {}
  try {
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const out: Drafts = {}
    for (const [channelId, value] of Object.entries(data as Record<string, unknown>)) {
      const entry = value as Partial<DraftEntry> | null
      if (
        channelId.length <= 64 &&
        entry &&
        typeof entry.text === 'string' &&
        entry.text.trim().length > 0 &&
        typeof entry.at === 'number' &&
        Number.isFinite(entry.at)
      ) {
        out[channelId] = { text: entry.text.slice(0, LIMITS.messageMaxLength), at: entry.at }
      }
    }
    return prune(out)
  } catch {
    return {}
  }
}

function prune(drafts: Drafts): Drafts {
  const entries = Object.entries(drafts)
  if (entries.length <= MAX_DRAFTS) return drafts
  entries.sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(entries.slice(0, MAX_DRAFTS))
}

/**
 * Sets (or, for empty text, removes) one draft. Returns the same object if nothing changed.
 * Whitespace is kept as typed (the composer shows exactly this text, so a first space or blank
 * line must stay), but drafts that are only whitespace are never saved (saveDrafts).
 */
export function setDraft(drafts: Drafts, channelId: string, text: string, now: number): Drafts {
  const value = text.slice(0, LIMITS.messageMaxLength)
  const current = drafts[channelId]
  if (!value) {
    if (!current) return drafts
    const next = { ...drafts }
    delete next[channelId]
    return next
  }
  if (current?.text === value) return drafts
  return prune({ ...drafts, [channelId]: { text: value, at: now } })
}

export function loadDrafts(key: string, storage: Pick<Storage, 'getItem'> = localStorage): Drafts {
  try {
    return parseDrafts(storage.getItem(key))
  } catch {
    return {}
  }
}

export function saveDrafts(
  key: string,
  drafts: Drafts,
  storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage
): void {
  try {
    const kept = Object.entries(drafts).filter(([, d]) => d.text.trim())
    if (kept.length === 0) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // Storage full or unavailable: drafts then only last for this session.
  }
}

export function clearDrafts(
  key: string,
  storage: Pick<Storage, 'removeItem'> = localStorage
): void {
  try {
    storage.removeItem(key)
  } catch {
    // ignore
  }
}
