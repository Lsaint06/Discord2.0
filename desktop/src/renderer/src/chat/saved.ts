/**
 * Milestone 14: your saved messages as message id → when saved. null = not loaded (the server
 * can't save messages, or hasn't answered yet), which hides every bookmark control.
 */
export type SavedIds = Record<string, number> | null

/**
 * Applies a save or unsave (yours, or from another of your devices) to the saved ids. Saving a
 * message that is already saved keeps the original time; nothing changes while not loaded.
 */
export function applySaved(
  prev: SavedIds,
  messageId: string,
  saved: boolean,
  savedAt: number | null,
  now = Date.now()
): SavedIds {
  if (prev === null) return prev
  if (saved) {
    if (prev[messageId] !== undefined) return prev
    return { ...prev, [messageId]: savedAt ?? now }
  }
  if (prev[messageId] === undefined) return prev
  const next = { ...prev }
  delete next[messageId]
  return next
}
