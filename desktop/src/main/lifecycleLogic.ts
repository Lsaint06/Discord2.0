/** Milestone 14: pure validation for the Windows lifecycle settings (tested without Electron). */
export interface LifecyclePrefs {
  /** The window's close button hides it to the tray (Quit from the tray menu quits). */
  closeToTray: boolean
  /** Start hidden in the tray (only when close-to-tray is on; otherwise minimized). */
  startMinimized: boolean
  /** Open when you sign in to Windows (installed/portable builds only). */
  launchAtLogin: boolean
}

export const DEFAULT_LIFECYCLE: LifecyclePrefs = {
  closeToTray: false,
  startMinimized: false,
  launchAtLogin: false
}

/** Only booleans for known keys; anything else keeps the current value. */
export function parseLifecyclePrefs(
  raw: unknown,
  base: LifecyclePrefs = DEFAULT_LIFECYCLE
): LifecyclePrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pick = (key: keyof LifecyclePrefs): boolean =>
    typeof r[key] === 'boolean' ? (r[key] as boolean) : base[key]
  return {
    closeToTray: pick('closeToTray'),
    startMinimized: pick('startMinimized'),
    launchAtLogin: pick('launchAtLogin')
  }
}

/** Taskbar attention from the renderer: a count is clamped, flash is a boolean. */
export function parseAttention(raw: unknown): { badge: number; flash: boolean } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const badge = Number(r.badge)
  if (!Number.isFinite(badge)) return null
  return { badge: Math.max(0, Math.min(999, Math.floor(badge))), flash: r.flash === true }
}
