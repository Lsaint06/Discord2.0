import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  ENCODER_FLAG_DEFAULTS,
  mergeFeatureList,
  parseEncoderFlags,
  type EncoderFlags
} from './encoderFlagsLogic'

/**
 * Chromium encoder features that must be chosen before the GPU process starts, so they are
 * stored in a small JSON file in userData (not renderer localStorage) and applied at launch.
 *
 * WebRtcAV1HWEncode: Chromium's own feature (media/webrtc/webrtc_features.cc) that lets WebRTC
 * use the platform AV1 hardware encoder. It is enabled by default on other platforms but not on
 * Windows; without it AV1 is always encoded in software (libaom). Users can turn it off in
 * Settings → Screen Share if a GPU driver misbehaves.
 */

const FEATURE_AV1_HW = 'WebRtcAV1HWEncode'

function flagsFile(): string {
  return join(app.getPath('userData'), 'encoder-flags.json')
}

function readFlags(): EncoderFlags {
  try {
    const file = flagsFile()
    return existsSync(file)
      ? parseEncoderFlags(readFileSync(file, 'utf8'))
      : { ...ENCODER_FLAG_DEFAULTS }
  } catch {
    return { ...ENCODER_FLAG_DEFAULTS }
  }
}

/** Flags in effect for this run (fixed at startup). */
let active: EncoderFlags = { ...ENCODER_FLAG_DEFAULTS }

/** Call before app 'ready' (after userData is final). */
export function applyEncoderFlags(): void {
  active = readFlags()
  if (active.av1HardwareEncode) {
    const existing = app.commandLine.getSwitchValue('enable-features')
    app.commandLine.appendSwitch('enable-features', mergeFeatureList(existing, FEATURE_AV1_HW))
  }
}

export function setupEncoderFlagsIpc(isAppUrl: (url: string | undefined) => boolean): void {
  const fromApp = (event: IpcMainInvokeEvent): boolean => isAppUrl(event.senderFrame?.url)

  ipcMain.handle('d2:encoder-flags', (event) => {
    if (!fromApp(event)) return null
    return { saved: readFlags(), active }
  })

  ipcMain.handle('d2:encoder-flags-set', (event, value: unknown) => {
    if (!fromApp(event)) return null
    const next = parseEncoderFlags(JSON.stringify(value))
    writeFileSync(flagsFile(), JSON.stringify(next, null, 2))
    return { saved: next, active }
  })

  ipcMain.handle('d2:app-relaunch', (event) => {
    if (!fromApp(event)) return
    app.relaunch()
    app.exit(0)
  })
}
