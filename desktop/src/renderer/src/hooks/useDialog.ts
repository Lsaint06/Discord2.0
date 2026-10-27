import { useEffect, useRef, type RefObject } from 'react'
import {
  FOCUSABLE_SELECTOR,
  handleTrapKey,
  initialFocusTarget,
  isTopDialog,
  pushDialog,
  removeDialog
} from '../lib/focusTrap'

interface DialogOptions {
  /** Whether the dialog is currently shown (for dialogs rendered conditionally inside a parent). */
  open?: boolean
  /** Called on Escape. Omit (or pass undefined, e.g. while busy) to ignore Escape. */
  onClose?: () => void
}

function visibleFocusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => el.getClientRects().length > 0 && !el.closest('[inert]')
  )
}

/**
 * Recently focused elements, newest last. A dialog's `autoFocus` child takes focus during
 * React's commit, before the dialog's effect runs; the history lets the dialog find the control
 * that actually opened it.
 */
const focusHistory: HTMLElement[] = []
if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const index = focusHistory.indexOf(target)
      if (index >= 0) focusHistory.splice(index, 1)
      focusHistory.push(target)
      if (focusHistory.length > 10) focusHistory.shift()
    },
    true
  )
}

/** The most recently focused element outside `container` that is still in the page. */
function openerOutside(container: HTMLElement | null): HTMLElement | null {
  const active = document.activeElement
  if (active instanceof HTMLElement && active !== document.body && !container?.contains(active)) {
    return active
  }
  for (let i = focusHistory.length - 1; i >= 0; i--) {
    const el = focusHistory[i]!
    if (el.isConnected && !container?.contains(el)) return el
  }
  return null
}

/**
 * Accessible modal behavior for the element the returned ref is attached to:
 * focus moves into the dialog when it opens, Tab/Shift+Tab stay inside, Escape closes it (only
 * the top-most dialog reacts), and focus returns to the control that opened it.
 */
export function useDialog<T extends HTMLElement>({
  open = true,
  onClose
}: DialogOptions = {}): RefObject<T | null> {
  const ref = useRef<T | null>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    if (!open) return
    const id = Symbol('dialog')
    const container = ref.current
    const previous = openerOutside(container)
    pushDialog(id)

    if (container) {
      if (!container.hasAttribute('tabindex')) container.tabIndex = -1
      // Children with autoFocus may already have focus; otherwise pick a sensible start.
      if (!container.contains(document.activeElement)) {
        const target = initialFocusTarget(
          visibleFocusables(container),
          (el) => el.hasAttribute('data-autofocus'),
          (el) => el.classList.contains('modal-close')
        )
        ;(target ?? container).focus({ preventScroll: true })
      }
    }

    const onKey = (event: KeyboardEvent): void => {
      if (!isTopDialog(id)) return
      const el = ref.current
      if (!el) return
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return
        const close = onCloseRef.current
        if (close) {
          event.preventDefault()
          close()
        }
        return
      }
      handleTrapKey(
        event,
        {
          contains: (node) => node instanceof Node && el.contains(node),
          focusables: () => visibleFocusables(el),
          focusSelf: () => el.focus({ preventScroll: true })
        },
        document.activeElement
      )
    }
    // Focus that escapes (e.g. a click on the backdrop) is pulled back into the top dialog.
    const onFocusIn = (event: FocusEvent): void => {
      const el = ref.current
      if (!el || !isTopDialog(id) || el.contains(event.target as Node)) return
      el.focus({ preventScroll: true })
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocusIn)
      removeDialog(id)
      // Back to the control that opened the dialog, if it still exists.
      if (previous && previous.isConnected && typeof previous.focus === 'function') {
        previous.focus({ preventScroll: true })
      }
    }
  }, [open])

  return ref
}
