/**
 * Message deletion rules for the toolbar (pure, unit-tested). The server is still the authority:
 * it re-checks ownership / Manage Messages on every DELETE.
 */

/** Your own messages, or anyone's with Manage Messages. Unsent (local) messages never. */
export function canDeleteMessage(opts: {
  own: boolean
  manageMessages: boolean
  local: boolean
}): boolean {
  return !opts.local && (opts.own || opts.manageMessages)
}

export type DeleteMode = 'quick' | 'confirm'

/**
 * Shift + Delete button deletes immediately; otherwise a confirmation dialog opens. While text is
 * selected, Shift is likely part of extending the selection, so it always asks.
 */
export function deleteMode(opts: { shiftKey: boolean; hasTextSelection: boolean }): DeleteMode {
  return opts.shiftKey && !opts.hasTextSelection ? 'quick' : 'confirm'
}

/** Tracks deletions in flight so repeated clicks send one request per message. */
export class DeleteGuard {
  private readonly pending = new Set<string>()

  /** True if the caller should send the request (and must call `end` afterwards). */
  begin(messageId: string): boolean {
    if (this.pending.has(messageId)) return false
    this.pending.add(messageId)
    return true
  }

  end(messageId: string): void {
    this.pending.delete(messageId)
  }

  has(messageId: string): boolean {
    return this.pending.has(messageId)
  }
}
