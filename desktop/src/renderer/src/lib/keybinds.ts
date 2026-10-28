/**
 * Keyboard shortcuts: an extensible command registry, the default bindings, and the rules a
 * custom binding must follow (pure, unit-tested). Everything here is app-focused: it only works
 * while the Discord 2.0 window has focus. A few commands may additionally be made system-wide —
 * only when you switch that on, and only through Electron's globalShortcut (no keyboard hooks).
 */

export interface Binding {
  /** KeyboardEvent.code, e.g. 'KeyM', 'ArrowUp', 'F8'. */
  code: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

export type CommandId =
  | 'toggleMute'
  | 'toggleDeafen'
  | 'leaveVoice'
  | 'toggleScreenShare'
  | 'quickSwitcher'
  | 'openSettings'
  | 'toggleMembers'
  | 'previousChannel'
  | 'nextChannel'
  | 'previousServer'
  | 'nextServer'

export type CommandCategory = 'voice' | 'navigation' | 'app'

export interface CommandInfo {
  id: CommandId
  label: string
  description: string
  category: CommandCategory
  defaultBinding: Binding | null
  /** May be made system-wide (works while another app has focus). */
  globalCapable: boolean
}

const b = (code: string, mods: Partial<Omit<Binding, 'code'>> = {}): Binding => ({
  code,
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods
})

export const COMMANDS: readonly CommandInfo[] = [
  {
    id: 'toggleMute',
    label: 'Mute / unmute',
    description: 'Turn your microphone off or on in voice.',
    category: 'voice',
    defaultBinding: b('KeyM', { ctrl: true, shift: true }),
    globalCapable: true
  },
  {
    id: 'toggleDeafen',
    label: 'Deafen / undeafen',
    description: 'Stop hearing (and sending) voice, or start again.',
    category: 'voice',
    defaultBinding: b('KeyD', { ctrl: true, shift: true }),
    globalCapable: true
  },
  {
    id: 'leaveVoice',
    label: 'Leave voice',
    description: 'Disconnect from the voice channel you’re in.',
    category: 'voice',
    defaultBinding: null,
    globalCapable: false
  },
  {
    id: 'toggleScreenShare',
    label: 'Share screen / stop sharing',
    description: 'Opens the screen picker, or stops your stream.',
    category: 'voice',
    defaultBinding: null,
    globalCapable: false
  },
  {
    id: 'quickSwitcher',
    label: 'Quick switcher',
    description: 'Jump to any server, channel or conversation.',
    category: 'navigation',
    defaultBinding: b('KeyK', { ctrl: true }),
    globalCapable: false
  },
  {
    id: 'previousChannel',
    label: 'Previous channel',
    description: 'The channel or conversation above the current one.',
    category: 'navigation',
    defaultBinding: b('ArrowUp', { alt: true }),
    globalCapable: false
  },
  {
    id: 'nextChannel',
    label: 'Next channel',
    description: 'The channel or conversation below the current one.',
    category: 'navigation',
    defaultBinding: b('ArrowDown', { alt: true }),
    globalCapable: false
  },
  {
    id: 'previousServer',
    label: 'Previous server',
    description: 'The server above the current one (Home is first).',
    category: 'navigation',
    defaultBinding: b('ArrowUp', { ctrl: true, alt: true }),
    globalCapable: false
  },
  {
    id: 'nextServer',
    label: 'Next server',
    description: 'The server below the current one.',
    category: 'navigation',
    defaultBinding: b('ArrowDown', { ctrl: true, alt: true }),
    globalCapable: false
  },
  {
    id: 'toggleMembers',
    label: 'Show / hide member list',
    description: 'The list of people on the right.',
    category: 'app',
    defaultBinding: b('KeyU', { ctrl: true }),
    globalCapable: false
  },
  {
    id: 'openSettings',
    label: 'Open settings',
    description: 'User settings.',
    category: 'app',
    defaultBinding: b('Comma', { ctrl: true }),
    globalCapable: false
  }
]

export const COMMAND_IDS: readonly CommandId[] = COMMANDS.map((c) => c.id)
const commandInfo = (id: CommandId): CommandInfo => COMMANDS.find((c) => c.id === id)!

/** Your changes to the defaults (per device). `binding: null` = unassigned on purpose. */
export type Keybinds = Partial<Record<CommandId, { binding: Binding | null; global?: boolean }>>

export function effectiveBinding(keybinds: Keybinds, id: CommandId): Binding | null {
  const own = keybinds[id]
  return own ? own.binding : commandInfo(id).defaultBinding
}

/**
 * Puts one command back to its default shortcut. If another command took that shortcut
 * meanwhile, it gives it up (left without one) — two commands never share a shortcut.
 */
export function resetCommand(
  keybinds: Keybinds,
  id: CommandId
): { keybinds: Keybinds; unassigned: CommandId | null } {
  const next: Keybinds = { ...keybinds }
  delete next[id]
  const binding = commandInfo(id).defaultBinding
  let unassigned: CommandId | null = null
  for (const other of COMMANDS) {
    if (other.id !== id && sameBinding(effectiveBinding(next, other.id), binding)) {
      next[other.id] = { binding: null }
      unassigned = other.id
    }
  }
  return { keybinds: next, unassigned }
}

export function isGlobal(keybinds: Keybinds, id: CommandId): boolean {
  return (
    commandInfo(id).globalCapable &&
    keybinds[id]?.global === true &&
    effectiveBinding(keybinds, id) !== null
  )
}

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight'
])

/** The binding a key press describes, or null for a lone modifier key. */
export function bindingFromEvent(e: {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): Binding | null {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null
  return { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }
}

export const sameBinding = (a: Binding | null, c: Binding | null): boolean =>
  !!a &&
  !!c &&
  a.code === c.code &&
  a.ctrl === c.ctrl &&
  a.alt === c.alt &&
  a.shift === c.shift &&
  a.meta === c.meta

const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Space: 'Space',
  Escape: 'Esc',
  PageUp: 'Page Up',
  PageDown: 'Page Down'
}

export function keyName(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]!
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code)
  if (digit) return code.startsWith('Numpad') ? `Num ${digit[1]}` : digit[1]!
  return KEY_NAMES[code] ?? code
}

export function formatBinding(binding: Binding | null, isMac = false): string {
  if (!binding) return 'Not set'
  const parts: string[] = []
  if (binding.ctrl) parts.push(isMac ? '⌃' : 'Ctrl')
  if (binding.alt) parts.push(isMac ? '⌥' : 'Alt')
  if (binding.shift) parts.push(isMac ? '⇧' : 'Shift')
  if (binding.meta) parts.push(isMac ? '⌘' : 'Win')
  parts.push(keyName(binding.code))
  return parts.join(isMac ? '' : '+')
}

/** Keys that type something (or move the caret) — they need Ctrl or Alt to be a shortcut. */
function isTypingKey(code: string): boolean {
  return (
    /^(Key[A-Z]|Digit\d|Numpad\d)$/.test(code) ||
    [
      'Space',
      'Backspace',
      'Delete',
      'Enter',
      'NumpadEnter',
      'Tab',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Insert',
      'Escape'
    ].includes(code) ||
    Object.prototype.hasOwnProperty.call(KEY_NAMES, code)
  )
}

/** Shortcuts Windows (and most desktops) keep for themselves. */
function reservedBySystem(x: Binding): boolean {
  if (x.meta) return true // Windows-key shortcuts belong to the OS.
  if (x.code === 'PrintScreen') return true
  if (x.alt && !x.ctrl && ['F4', 'Tab', 'Escape', 'Space'].includes(x.code)) return true
  if (x.ctrl && !x.alt && x.code === 'Escape') return true
  if (x.ctrl && x.alt && x.code === 'Delete') return true
  if (x.ctrl && x.shift && x.code === 'Escape') return true
  return false
}

/** Shortcuts this app already uses (editing, search, zoom, developer tools). */
function reservedByApp(x: Binding): string | null {
  const ctrlOnly = x.ctrl && !x.alt && !x.meta
  if (ctrlOnly && !x.shift && ['KeyC', 'KeyV', 'KeyX', 'KeyA', 'KeyZ', 'KeyY'].includes(x.code)) {
    return 'copy, paste and undo'
  }
  if (ctrlOnly && x.shift && x.code === 'KeyZ') return 'redo'
  if (ctrlOnly && !x.shift && x.code === 'KeyF') return 'search'
  if (
    ctrlOnly &&
    ['Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract', 'Numpad0'].includes(x.code)
  ) {
    return 'app scale (zoom)'
  }
  if (ctrlOnly && x.code === 'KeyR') return 'reload'
  if ((ctrlOnly && x.shift && x.code === 'KeyI') || x.code === 'F12') return 'developer tools'
  return null
}

/**
 * Why `binding` can't be used for `id` (or null if it can). Checks the system's and the app's
 * own shortcuts, typing keys without Ctrl/Alt, and the other commands' bindings.
 */
export function bindingProblem(binding: Binding, id: CommandId, keybinds: Keybinds): string | null {
  if (reservedBySystem(binding)) return `${formatBinding(binding)} is reserved by Windows.`
  const app = reservedByApp(binding)
  if (app) return `${formatBinding(binding)} is already used for ${app}.`
  if (!binding.ctrl && !binding.alt && isTypingKey(binding.code)) {
    return 'Add Ctrl or Alt — on its own that key would interfere with typing.'
  }
  for (const other of COMMANDS) {
    if (other.id === id) continue
    if (sameBinding(effectiveBinding(keybinds, other.id), binding)) {
      return `${formatBinding(binding)} is already used for “${other.label}”.`
    }
  }
  return null
}

/** The command a key press triggers, if any. */
export function matchCommand(
  e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean },
  keybinds: Keybinds
): CommandId | null {
  const pressed = bindingFromEvent(e)
  if (!pressed) return null
  for (const id of COMMAND_IDS) {
    if (sameBinding(effectiveBinding(keybinds, id), pressed)) return id
  }
  return null
}

const ACCEL_KEYS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Space: 'Space',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete'
}

/** Electron accelerator for a system-wide shortcut (null if it can't be one). */
export function bindingToAccelerator(binding: Binding): string | null {
  let key: string | undefined
  const letter = /^Key([A-Z])$/.exec(binding.code)
  const digit = /^Digit(\d)$/.exec(binding.code)
  const pad = /^Numpad(\d)$/.exec(binding.code)
  if (letter) key = letter[1]
  else if (digit) key = digit[1]
  else if (pad) key = `num${pad[1]}`
  else if (/^F([1-9]|1\d|2[0-4])$/.test(binding.code)) key = binding.code
  else key = ACCEL_KEYS[binding.code]
  if (!key || binding.meta) return null
  const mods = [binding.ctrl && 'Control', binding.alt && 'Alt', binding.shift && 'Shift'].filter(
    Boolean
  ) as string[]
  // A system-wide shortcut without Ctrl or Alt would swallow that key in every other app.
  if (!binding.ctrl && !binding.alt && !/^F\d+$/.test(key)) return null
  return [...mods, key].join('+')
}

/** Validates stored keybinds (unknown commands and malformed bindings are dropped). */
export function parseKeybinds(raw: unknown): Keybinds {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Keybinds = {}
  for (const id of COMMAND_IDS) {
    const entry = (raw as Record<string, unknown>)[id] as
      { binding?: unknown; global?: unknown } | undefined
    if (!entry || typeof entry !== 'object') continue
    const bind = entry.binding as Partial<Binding> | null | undefined
    let binding: Binding | null | undefined
    if (bind === null) binding = null
    else if (
      bind &&
      typeof bind.code === 'string' &&
      /^[A-Za-z0-9]{1,24}$/.test(bind.code) &&
      ['ctrl', 'alt', 'shift', 'meta'].every(
        (k) => typeof (bind as Record<string, unknown>)[k] === 'boolean'
      )
    ) {
      binding = {
        code: bind.code,
        ctrl: bind.ctrl!,
        alt: bind.alt!,
        shift: bind.shift!,
        meta: bind.meta!
      }
    }
    if (binding === undefined) continue
    out[id] = { binding, ...(entry.global === true ? { global: true } : {}) }
  }
  return out
}
