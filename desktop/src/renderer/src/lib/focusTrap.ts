/**
 * Modal dialog focus management, kept free of React and of the real DOM so it can be unit
 * tested: a stack of open modals (only the top one handles keys), Tab/Shift+Tab wrapping, the
 * element that receives focus on open, and focus restoration on close.
 */

/** Elements that can take keyboard focus (filtered further for visibility in the hook). */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]'
]
  .map((s) => `${s}:not([hidden])`)
  .join(', ')

// ---- Stack of open modals ----

const stack: symbol[] = []

export function pushDialog(id: symbol): void {
  removeDialog(id)
  stack.push(id)
}

export function removeDialog(id: symbol): void {
  const index = stack.indexOf(id)
  if (index >= 0) stack.splice(index, 1)
}

export function isTopDialog(id: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id
}

/** True while any modal is open (background shortcuts should do nothing then). */
export function anyDialogOpen(): boolean {
  return stack.length > 0
}

/** Test helper. */
export function resetDialogStack(): void {
  stack.length = 0
}

// ---- Tab wrapping ----

/**
 * Where Tab / Shift+Tab should move focus inside a modal, or null to let the browser move
 * focus normally (it stays inside because we're not at either end).
 */
export function nextTrapTarget<T>(
  items: readonly T[],
  current: T | null,
  backwards: boolean
): T | null {
  if (items.length === 0) return null
  const first = items[0]!
  const last = items[items.length - 1]!
  const index = current === null ? -1 : items.indexOf(current)
  if (index === -1) return backwards ? last : first
  if (backwards && index === 0) return last
  if (!backwards && index === items.length - 1) return first
  return null
}

/** What the trap needs from a dialog element (a real HTMLElement in the app, a fake in tests). */
export interface TrapContainer<E> {
  contains: (node: unknown) => boolean
  /** Focusable, visible descendants in tab order. */
  focusables: () => E[]
  /** Focus the dialog itself (fallback when nothing inside is focusable). */
  focusSelf: () => void
}

export interface KeyLike {
  key: string
  shiftKey: boolean
  preventDefault: () => void
}

/** Keeps Tab inside the dialog. Returns true when it handled the key. */
export function handleTrapKey<E extends { focus: () => void }>(
  event: KeyLike,
  container: TrapContainer<E>,
  active: unknown
): boolean {
  if (event.key !== 'Tab') return false
  const items = container.focusables()
  const current = container.contains(active) ? (active as E) : null
  if (items.length === 0) {
    event.preventDefault()
    container.focusSelf()
    return true
  }
  const target = nextTrapTarget(items, current, event.shiftKey)
  if (!target) return false
  event.preventDefault()
  target.focus()
  return true
}

/**
 * Element to focus when a dialog opens: one marked `data-autofocus`, otherwise the first
 * focusable that isn't the corner close button, otherwise the close button, otherwise null
 * (focus the dialog itself).
 */
export function initialFocusTarget<E>(
  items: readonly E[],
  isPreferred: (item: E) => boolean,
  isCloseButton: (item: E) => boolean
): E | null {
  return items.find(isPreferred) ?? items.find((item) => !isCloseButton(item)) ?? items[0] ?? null
}
