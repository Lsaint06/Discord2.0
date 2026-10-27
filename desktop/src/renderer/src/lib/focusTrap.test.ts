import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  anyDialogOpen,
  handleTrapKey,
  initialFocusTarget,
  isTopDialog,
  nextTrapTarget,
  pushDialog,
  removeDialog,
  resetDialogStack,
  type TrapContainer
} from './focusTrap'

interface FakeEl {
  name: string
  focus: () => void
}

interface FakeDialog {
  items: FakeEl[]
  container: TrapContainer<FakeEl>
  focused: string[]
  selfFocusCount: () => number
}

function dialog(names: string[]): FakeDialog {
  const focused: string[] = []
  const items: FakeEl[] = names.map((name) => ({ name, focus: () => focused.push(name) }))
  let selfFocused = 0
  const container: TrapContainer<FakeEl> = {
    contains: (node) => items.includes(node as FakeEl),
    focusables: () => items,
    focusSelf: () => {
      selfFocused++
    }
  }
  return { items, container, focused, selfFocusCount: () => selfFocused }
}

const tab = (shiftKey = false): { key: string; shiftKey: boolean; preventDefault: () => void } => ({
  key: 'Tab',
  shiftKey,
  preventDefault: vi.fn()
})

afterEach(() => resetDialogStack())

describe('focus containment', () => {
  it('wraps Tab from the last control to the first, and Shift+Tab the other way', () => {
    const d = dialog(['close', 'name', 'save'])
    const forward = tab()
    expect(handleTrapKey(forward, d.container, d.items[2])).toBe(true)
    expect(forward.preventDefault).toHaveBeenCalled()
    expect(d.focused).toEqual(['close'])

    const back = tab(true)
    expect(handleTrapKey(back, d.container, d.items[0])).toBe(true)
    expect(d.focused).toEqual(['close', 'save'])
  })

  it('lets the browser move focus normally in the middle of the dialog', () => {
    const d = dialog(['close', 'name', 'save'])
    const event = tab()
    expect(handleTrapKey(event, d.container, d.items[1])).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('pulls focus back in when it is outside the dialog', () => {
    const d = dialog(['close', 'name'])
    handleTrapKey(tab(), d.container, { outside: true })
    handleTrapKey(tab(true), d.container, null)
    expect(d.focused).toEqual(['close', 'name'])
  })

  it('keeps focus on the dialog itself when nothing inside is focusable', () => {
    const d = dialog([])
    const event = tab()
    expect(handleTrapKey(event, d.container, null)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(d.selfFocusCount()).toBe(1)
  })

  it('ignores keys other than Tab', () => {
    const d = dialog(['a'])
    expect(
      handleTrapKey({ key: 'Enter', shiftKey: false, preventDefault: vi.fn() }, d.container, null)
    ).toBe(false)
  })

  it('nextTrapTarget handles empty and single-item dialogs', () => {
    expect(nextTrapTarget([], null, false)).toBeNull()
    expect(nextTrapTarget(['only'], 'only', false)).toBe('only')
    expect(nextTrapTarget(['only'], 'only', true)).toBe('only')
  })
})

describe('initial focus', () => {
  const isClose = (n: string): boolean => n === 'close'
  it('prefers data-autofocus, then the first control that is not the close button', () => {
    expect(initialFocusTarget(['close', 'name', 'save'], (n) => n === 'save', isClose)).toBe('save')
    expect(initialFocusTarget(['close', 'name', 'save'], () => false, isClose)).toBe('name')
    expect(initialFocusTarget(['close'], () => false, isClose)).toBe('close')
    expect(initialFocusTarget([], () => false, isClose)).toBeNull()
  })
})

describe('modal stack', () => {
  it('only the top dialog handles keys; closing it hands control back', () => {
    const settings = Symbol('settings')
    const cropper = Symbol('cropper')
    expect(anyDialogOpen()).toBe(false)
    pushDialog(settings)
    pushDialog(cropper)
    expect(isTopDialog(cropper)).toBe(true)
    expect(isTopDialog(settings)).toBe(false)
    removeDialog(cropper)
    expect(isTopDialog(settings)).toBe(true)
    removeDialog(settings)
    expect(anyDialogOpen()).toBe(false)
  })

  it('closing a dialog that is not on top keeps the order of the rest', () => {
    const a = Symbol('a')
    const b = Symbol('b')
    const c = Symbol('c')
    pushDialog(a)
    pushDialog(b)
    pushDialog(c)
    removeDialog(b)
    expect(isTopDialog(c)).toBe(true)
    removeDialog(c)
    expect(isTopDialog(a)).toBe(true)
  })
})
