import { ipcMain, powerMonitor, type IpcMainInvokeEvent } from 'electron'
import { isAppUrl } from './appUrl'

export type SystemIdleState = 'active' | 'idle' | 'locked' | 'unknown'

/** Shortest/longest idle threshold the renderer may ask about (1 minute … 2 hours). */
const MIN_THRESHOLD_S = 60
const MAX_THRESHOLD_S = 2 * 60 * 60

function fromApp(event: IpcMainInvokeEvent): boolean {
  return isAppUrl(event.senderFrame?.url)
}

/**
 * System-wide idle detection for automatic "Idle" presence: no keyboard/mouse input anywhere on
 * the PC for `threshold` seconds, or the screen is locked. Only the coarse state is returned
 * (never input events), and only to the app's own page.
 */
export function setupSystemIdle(): void {
  ipcMain.handle('d2:idle-state', (event, threshold: unknown): SystemIdleState => {
    if (!fromApp(event)) return 'unknown'
    if (
      typeof threshold !== 'number' ||
      !Number.isInteger(threshold) ||
      threshold < MIN_THRESHOLD_S ||
      threshold > MAX_THRESHOLD_S
    ) {
      return 'unknown'
    }
    return powerMonitor.getSystemIdleState(threshold)
  })
}
