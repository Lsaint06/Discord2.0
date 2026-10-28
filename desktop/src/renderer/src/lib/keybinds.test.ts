import { describe, expect, it } from 'vitest'
import {
  COMMANDS,
  bindingFromEvent,
  bindingProblem,
  bindingToAccelerator,
  effectiveBinding,
  formatBinding,
  isGlobal,
  matchCommand,
  parseKeybinds,
  resetCommand,
  type Binding,
  type Keybinds
} from './keybinds'

const k = (code: string, mods: Partial<Omit<Binding, 'code'>> = {}): Binding => ({
  code,
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods
})
const press = (
  code: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}
): { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean } => ({
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta
})

describe('keybinds', () => {
  it('has sensible, conflict-free defaults', () => {
    const defaults = COMMANDS.map((c) => c.defaultBinding).filter((x): x is Binding => x !== null)
    const keys = defaults.map((d) => formatBinding(d))
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of COMMANDS) {
      if (c.defaultBinding) expect(bindingProblem(c.defaultBinding, c.id, {})).toBeNull()
    }
    expect(formatBinding(effectiveBinding({}, 'toggleMute'))).toBe('Ctrl+Shift+M')
    expect(formatBinding(effectiveBinding({}, 'quickSwitcher'))).toBe('Ctrl+K')
  })

  it('matches presses to commands, including your changes', () => {
    expect(matchCommand(press('KeyM', { ctrl: true, shift: true }), {})).toBe('toggleMute')
    expect(matchCommand(press('KeyM', { ctrl: true }), {})).toBeNull()
    const custom: Keybinds = { toggleMute: { binding: k('F8') }, quickSwitcher: { binding: null } }
    expect(matchCommand(press('F8'), custom)).toBe('toggleMute')
    expect(matchCommand(press('KeyM', { ctrl: true, shift: true }), custom)).toBeNull()
    expect(matchCommand(press('KeyK', { ctrl: true }), custom)).toBeNull()
    expect(bindingFromEvent(press('ShiftLeft', { shift: true }))).toBeNull()
  })

  it('refuses system and app shortcuts', () => {
    expect(bindingProblem(k('F4', { alt: true }), 'leaveVoice', {})).toMatch(/reserved by Windows/)
    expect(bindingProblem(k('Tab', { alt: true }), 'leaveVoice', {})).toMatch(/Windows/)
    expect(bindingProblem(k('KeyL', { meta: true }), 'leaveVoice', {})).toMatch(/Windows/)
    expect(bindingProblem(k('Delete', { ctrl: true, alt: true }), 'leaveVoice', {})).toMatch(
      /Windows/
    )
    expect(bindingProblem(k('KeyC', { ctrl: true }), 'leaveVoice', {})).toMatch(/copy, paste/)
    expect(bindingProblem(k('KeyF', { ctrl: true }), 'leaveVoice', {})).toMatch(/search/)
    expect(bindingProblem(k('Equal', { ctrl: true }), 'leaveVoice', {})).toMatch(/zoom/)
    expect(bindingProblem(k('F12'), 'leaveVoice', {})).toMatch(/developer tools/)
  })

  it('refuses typing keys without Ctrl or Alt, but allows function keys', () => {
    expect(bindingProblem(k('KeyQ'), 'leaveVoice', {})).toMatch(/interfere with typing/)
    expect(bindingProblem(k('KeyQ', { shift: true }), 'leaveVoice', {})).toMatch(/typing/)
    expect(bindingProblem(k('Space'), 'leaveVoice', {})).toMatch(/typing/)
    expect(bindingProblem(k('F9'), 'leaveVoice', {})).toBeNull()
    expect(bindingProblem(k('KeyQ', { alt: true }), 'leaveVoice', {})).toBeNull()
  })

  it('reports which command already uses a binding', () => {
    expect(bindingProblem(k('KeyK', { ctrl: true }), 'leaveVoice', {})).toMatch(/Quick switcher/)
    // Not a conflict with itself; freed once the other command is changed.
    expect(bindingProblem(k('KeyK', { ctrl: true }), 'quickSwitcher', {})).toBeNull()
    expect(
      bindingProblem(k('KeyK', { ctrl: true }), 'leaveVoice', { quickSwitcher: { binding: null } })
    ).toBeNull()
  })

  it('resetting one command takes its shortcut back, never leaving two on one shortcut', () => {
    // Mute moved to Ctrl+Alt+M, then Deafen took Mute's default (allowed: it was free).
    const changed: Keybinds = {
      toggleMute: { binding: k('KeyM', { ctrl: true, alt: true }) },
      toggleDeafen: { binding: k('KeyM', { ctrl: true, shift: true }), global: true }
    }
    const { keybinds, unassigned } = resetCommand(changed, 'toggleMute')
    expect(formatBinding(effectiveBinding(keybinds, 'toggleMute'))).toBe('Ctrl+Shift+M')
    expect(unassigned).toBe('toggleDeafen')
    expect(effectiveBinding(keybinds, 'toggleDeafen')).toBeNull()
    expect(isGlobal(keybinds, 'toggleDeafen')).toBe(false)
    expect(matchCommand(press('KeyM', { ctrl: true, shift: true }), keybinds)).toBe('toggleMute')
    // Nothing in the way: just the default again.
    const plain = resetCommand({ toggleMute: { binding: k('F8') } }, 'toggleMute')
    expect(plain).toEqual({ keybinds: {}, unassigned: null })
    // Commands without a default never take anything.
    expect(resetCommand({ leaveVoice: { binding: k('F9') } }, 'leaveVoice').unassigned).toBeNull()
  })

  it('makes system-wide shortcuts only on request and only with a safe accelerator', () => {
    expect(isGlobal({}, 'toggleMute')).toBe(false)
    expect(isGlobal({ toggleMute: { binding: k('F8'), global: true } }, 'toggleMute')).toBe(true)
    expect(isGlobal({ quickSwitcher: { binding: k('F8'), global: true } }, 'quickSwitcher')).toBe(
      false
    )
    expect(isGlobal({ toggleMute: { binding: null, global: true } }, 'toggleMute')).toBe(false)
    expect(bindingToAccelerator(k('KeyM', { ctrl: true, shift: true }))).toBe('Control+Shift+M')
    expect(bindingToAccelerator(k('F8'))).toBe('F8')
    expect(bindingToAccelerator(k('ArrowUp', { alt: true }))).toBe('Alt+Up')
    expect(bindingToAccelerator(k('KeyM'))).toBeNull() // would swallow M everywhere
    expect(bindingToAccelerator(k('KeyM', { meta: true }))).toBeNull()
  })

  it('validates stored keybinds', () => {
    expect(parseKeybinds(null)).toEqual({})
    expect(
      parseKeybinds({
        toggleMute: {
          binding: { code: 'F8', ctrl: false, alt: false, shift: false, meta: false },
          global: true
        },
        toggleDeafen: { binding: null },
        leaveVoice: {
          binding: { code: '<script>', ctrl: true, alt: false, shift: false, meta: false }
        },
        nextServer: { binding: { code: 'KeyN', ctrl: 'yes' } },
        bogus: { binding: null }
      })
    ).toEqual({
      toggleMute: {
        binding: { code: 'F8', ctrl: false, alt: false, shift: false, meta: false },
        global: true
      },
      toggleDeafen: { binding: null }
    })
  })
})
