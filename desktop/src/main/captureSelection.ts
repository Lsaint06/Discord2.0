/**
 * One-time, short-lived screen-capture grants (pure logic, no Electron imports so it can be
 * unit tested).
 *
 * Flow: the renderer lists sources, the user explicitly picks one in our picker, the renderer
 * asks main to arm that selection, then calls getDisplayMedia(). The display-media handler
 * consumes the armed selection exactly once. Without an armed, unexpired selection from the
 * same webContents, capture is denied — we never auto-grant a display.
 */

export interface ArmedSelection {
  sourceId: string
  name: string
  audio: boolean
  senderId: number
  expiresAt: number
  /** The (single) media permission request for this selection has been granted. */
  permissionUsed?: boolean
}

export type ConsumeResult =
  | { ok: true; selection: ArmedSelection }
  | { ok: false; reason: 'none' | 'expired' | 'wrong-sender' }

/** Electron desktopCapturer ids: `screen:<n>:0` or `window:<handle>:<0|1>`. */
const SOURCE_ID = /^(screen|window):[A-Za-z0-9_-]{1,64}:\d{1,4}$/

export function isValidSourceId(id: unknown): id is string {
  return typeof id === 'string' && SOURCE_ID.test(id)
}

export const SELECTION_TTL_MS = 15_000

export class CaptureSelectionStore {
  private armed: ArmedSelection | null = null

  constructor(private readonly now: () => number = Date.now) {}

  arm(selection: Omit<ArmedSelection, 'expiresAt'>): ArmedSelection {
    this.armed = { ...selection, expiresAt: this.now() + SELECTION_TTL_MS }
    return this.armed
  }

  /** Returns the armed selection once; any outcome clears it. */
  consume(senderId: number | undefined): ConsumeResult {
    const armed = this.armed
    this.armed = null
    if (!armed) return { ok: false, reason: 'none' }
    if (this.now() > armed.expiresAt) return { ok: false, reason: 'expired' }
    if (senderId !== armed.senderId) return { ok: false, reason: 'wrong-sender' }
    return { ok: true, selection: armed }
  }

  /**
   * Chromium asks for a 'media' permission (with no media types) before display capture.
   * Grant it once per armed selection, only to the window that armed it, so a capture request
   * without an explicit user pick — including legacy `chromeMediaSource: 'desktop'` — is denied.
   */
  takePermission(senderId: number | undefined): boolean {
    const armed = this.armed
    if (!armed || armed.permissionUsed) return false
    if (this.now() > armed.expiresAt || senderId !== armed.senderId) return false
    armed.permissionUsed = true
    return true
  }

  clear(): void {
    this.armed = null
  }
}
