/**
 * Pure operations on a channel's message list. Every realtime event maps to one of these, and
 * each returns the same array when nothing changed so React can skip re-rendering.
 */
import type { Message } from '../types'
import type { ApiMessage } from '../net/protocol'

export function toMessage(m: ApiMessage): Message {
  return {
    id: m.id,
    channelId: m.channelId,
    authorId: m.authorId,
    content: m.content,
    timestamp: m.createdAt,
    nonce: m.nonce,
    editedAt: m.editedAt ?? null,
    replyTo: m.replyTo ?? null,
    attachments: m.attachments ?? [],
    reactions: m.reactions ?? [],
    pinned: m.pinned ?? false
  }
}

export const isLocal = (m: Message): boolean => Boolean(m.pending || m.failed)

/**
 * Merges server messages into a list: replaces optimistic copies by nonce, updates messages we
 * already have (the server copy wins), keeps confirmed messages sorted by id, local ones last.
 */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return existing
  const result = [...existing]
  const index = new Map(result.map((m, i) => [m.id, i]))
  for (const m of incoming) {
    const at = index.get(m.id)
    if (at !== undefined) {
      result[at] = m
      continue
    }
    const localIndex = m.nonce ? result.findIndex((x) => isLocal(x) && x.nonce === m.nonce) : -1
    if (localIndex >= 0) {
      result[localIndex] = m
      index.set(m.id, localIndex)
    } else {
      result.push(m)
      index.set(m.id, result.length - 1)
    }
  }
  const confirmed = result.filter((m) => !isLocal(m)).sort((a, b) => Number(a.id) - Number(b.id))
  return [...confirmed, ...result.filter(isLocal)]
}

export function lastConfirmedId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isLocal(messages[i])) return messages[i].id
  }
  return undefined
}

export function firstConfirmedId(messages: Message[]): string | undefined {
  return messages.find((m) => !isLocal(m))?.id
}

function updateWhere(
  messages: Message[],
  pred: (m: Message) => boolean,
  fn: (m: Message) => Message
): Message[] {
  let changed = false
  const next = messages.map((m) => {
    if (!pred(m)) return m
    const updated = fn(m)
    if (updated !== m) changed = true
    return updated
  })
  return changed ? next : messages
}

/** Applies an edit only if it is newer than what we have (events can arrive out of order). */
export function applyEdit(
  messages: Message[],
  edit: { id: string; content: string; editedAt: number }
): Message[] {
  const edited = updateWhere(
    messages,
    (m) => m.id === edit.id,
    (m) =>
      (m.editedAt ?? 0) >= edit.editedAt
        ? m
        : { ...m, content: edit.content, editedAt: edit.editedAt }
  )
  // Keep reply previews in sync with the edited original.
  return updateWhere(
    edited,
    (m) => m.replyTo?.id === edit.id && !m.replyTo.deleted && m.replyTo.content !== edit.content,
    (m) => ({ ...m, replyTo: { ...m.replyTo!, content: edit.content } })
  )
}

/** Removes a message; replies to it now point at a deleted original. */
export function applyDelete(messages: Message[], id: string): Message[] {
  if (!messages.some((m) => m.id === id || m.replyTo?.id === id)) return messages
  return messages
    .filter((m) => m.id !== id)
    .map((m) => (m.replyTo?.id === id ? { ...m, replyTo: { id, deleted: true } } : m))
}

/**
 * Applies an authoritative reaction count. `me` changes only when the event is about the current
 * user; it's idempotent, so replays and our own optimistic updates converge.
 */
export function applyReaction(
  messages: Message[],
  event: { messageId: string; emoji: string; count: number; userId: string; added: boolean },
  meId: string | undefined
): Message[] {
  return updateWhere(
    messages,
    (m) => m.id === event.messageId,
    (m) => {
      const reactions = [...(m.reactions ?? [])]
      const i = reactions.findIndex((r) => r.emoji === event.emoji)
      const prev = i >= 0 ? reactions[i] : undefined
      const me = event.userId === meId ? event.added : (prev?.me ?? false)
      if (event.count <= 0) {
        if (i < 0) return m
        reactions.splice(i, 1)
      } else if (prev && prev.count === event.count && prev.me === me) {
        return m
      } else if (i >= 0) {
        reactions[i] = { emoji: event.emoji, count: event.count, me }
      } else {
        reactions.push({ emoji: event.emoji, count: event.count, me })
      }
      return { ...m, reactions }
    }
  )
}

/** Local optimistic toggle before the server confirms. */
export function toggleReactionLocally(
  messages: Message[],
  messageId: string,
  emoji: string,
  add: boolean,
  meId: string
): Message[] {
  const target = messages.find((m) => m.id === messageId)
  if (!target) return messages
  const current = target.reactions?.find((r) => r.emoji === emoji)
  if (Boolean(current?.me) === add) return messages
  const count = (current?.count ?? 0) + (add ? 1 : -1)
  return applyReaction(messages, { messageId, emoji, count, userId: meId, added: add }, meId)
}

export function applyPin(messages: Message[], messageId: string, pinned: boolean): Message[] {
  return updateWhere(
    messages,
    (m) => m.id === messageId,
    (m) => (Boolean(m.pinned) === pinned ? m : { ...m, pinned })
  )
}

/**
 * After a reconnect we reload the latest page; within that page's id range the server copy is
 * authoritative (drops messages deleted while we were away, applies edits and reactions).
 */
export function reconcileWindow(existing: Message[], latest: Message[]): Message[] {
  const local = existing.filter(isLocal)
  if (latest.length === 0) return local
  const oldest = Number(latest[0].id)
  const kept = existing.filter((m) => !isLocal(m) && Number(m.id) < oldest)
  return mergeMessages([...kept, ...local], latest)
}
