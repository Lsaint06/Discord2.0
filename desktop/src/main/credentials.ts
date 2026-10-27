/**
 * Protected storage for the session token (main process only).
 *
 * The token is encrypted with Electron safeStorage and written to `session.bin` in the
 * profile's userData folder. On Windows this is DPAPI (bound to the Windows user account);
 * on macOS the Keychain; on Linux the Secret Service / KWallet. If no OS-backed encryption is
 * available (e.g. Linux without a keyring, where Electron would fall back to a fixed key), the
 * token is kept in memory only and the user signs in again after restarting the app.
 *
 * Limitation: any program running as the same OS user can ask DPAPI to decrypt the file; this
 * protects against copying the profile to another account/machine, not against local malware.
 */
import { app, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import { isAppUrl } from './appUrl'
import type { StoredCredentials, CredentialStorage } from '../preload/types'

const fileName = (): string => join(app.getPath('userData'), 'session.bin')
let memory: StoredCredentials | null = null

function fromApp(event: IpcMainInvokeEvent): boolean {
  return isAppUrl(event.senderFrame?.url)
}

export function credentialStorage(): CredentialStorage {
  if (!safeStorage.isEncryptionAvailable()) return 'memory'
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return 'memory'
  }
  return 'encrypted'
}

function isCredentials(value: unknown): value is StoredCredentials {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.token === 'string' &&
    /^[A-Za-z0-9_-]{20,128}$/.test(v.token) &&
    typeof v.serverUrl === 'string' &&
    v.serverUrl.length < 300 &&
    typeof v.username === 'string' &&
    v.username.length <= 64
  )
}

function load(): StoredCredentials | null {
  if (credentialStorage() !== 'encrypted') return memory
  try {
    if (!existsSync(fileName())) return null
    const parsed: unknown = JSON.parse(safeStorage.decryptString(readFileSync(fileName())))
    return isCredentials(parsed) ? parsed : null
  } catch {
    // Unreadable (e.g. copied from another Windows account): treat as signed out.
    rmSync(fileName(), { force: true })
    return null
  }
}

function save(value: StoredCredentials): void {
  if (credentialStorage() !== 'encrypted') {
    memory = value
    return
  }
  writeFileSync(fileName(), safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 })
}

function clear(): void {
  memory = null
  rmSync(fileName(), { force: true })
}

export function setupCredentialStorage(): void {
  ipcMain.handle('d2:credentials-load', (event) => (fromApp(event) ? load() : null))
  ipcMain.handle('d2:credentials-save', (event, value: unknown) => {
    if (!fromApp(event) || !isCredentials(value)) return false
    save({ token: value.token, serverUrl: value.serverUrl, username: value.username })
    return true
  })
  ipcMain.handle('d2:credentials-clear', (event) => {
    if (fromApp(event)) clear()
  })
  ipcMain.handle('d2:credentials-info', (event) =>
    fromApp(event) ? { storage: credentialStorage(), device: deviceName() } : null
  )
}

/** A label for "active devices" (computer name + OS), sent at sign-in. */
function deviceName(): string {
  const os =
    process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'
  return `${hostname().slice(0, 40)} · ${os}`
}
