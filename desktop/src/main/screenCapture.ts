import {
  app,
  desktopCapturer,
  ipcMain,
  screen,
  session,
  webContents,
  type DesktopCapturerSource,
  type IpcMainInvokeEvent,
  type Streams
} from 'electron'
import { release } from 'os'
import { CaptureSelectionStore, isValidSourceId } from './captureSelection'
import type {
  AppMetrics,
  ScreenCaptureCapabilities,
  ScreenSelectResult,
  ScreenSourceInfo
} from '../preload/types'

/**
 * Screen capture with an in-app source picker.
 *
 * - Sources are enumerated here (desktopCapturer is main-process only) and sent to the renderer
 *   as plain data with JPEG thumbnails.
 * - The renderer arms exactly one user-chosen source; the display-media handler consumes it
 *   once. No armed selection ⇒ capture denied (never "first display by default").
 * - System audio uses Windows WASAPI loopback. When the renderer asks for `restrictOwnAudio`,
 *   Electron/Chromium exclude Discord 2.0's own playback on platforms that support it (Win 11).
 */

const selection = new CaptureSelectionStore()

/** See CaptureSelectionStore.takePermission. */
export function takeDisplayCapturePermission(webContentsId: number): boolean {
  return selection.takePermission(webContentsId)
}

function isAppUrl(url: string | undefined): boolean {
  if (!url) return false
  if (url.startsWith('file://')) return true
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!devUrl) return false
  try {
    return new URL(url).origin === new URL(devUrl).origin
  } catch {
    return false
  }
}

function fromApp(event: IpcMainInvokeEvent): boolean {
  return isAppUrl(event.senderFrame?.url)
}

function kindOf(id: string): 'screen' | 'window' {
  return id.startsWith('screen:') ? 'screen' : 'window'
}

/** `window:<handle>:1` means the window belongs to this process (our own app). */
function isOwnWindow(source: DesktopCapturerSource): boolean {
  return source.id.startsWith('window:') && source.id.endsWith(':1')
}

function systemAudioSupported(): boolean {
  return process.platform === 'win32'
}

/** Windows 11 reports NT 10.0 with build >= 22000. */
function isWindows11(): boolean {
  if (process.platform !== 'win32') return false
  const build = Number(release().split('.')[2] ?? 0)
  return build >= 22000
}

async function listSources(): Promise<ScreenSourceInfo[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true
  })
  const displays = screen.getAllDisplays()
  return sources
    .filter((s) => !isOwnWindow(s))
    .map((s) => {
      const display = displays.find((d) => String(d.id) === s.display_id)
      const thumbnail = s.thumbnail.isEmpty()
        ? null
        : `data:image/jpeg;base64,${s.thumbnail.toJPEG(70).toString('base64')}`
      const appIcon =
        s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.resize({ width: 32 }).toDataURL() : null
      return {
        id: s.id,
        name: s.name,
        kind: kindOf(s.id),
        thumbnail,
        appIcon,
        // Physical pixels, so the UI can tell whether a display is genuinely 1440p.
        width: display ? Math.round(display.size.width * display.scaleFactor) : undefined,
        height: display ? Math.round(display.size.height * display.scaleFactor) : undefined,
        primary: display ? display.id === screen.getPrimaryDisplay().id : undefined
      }
    })
}

async function findSource(id: string): Promise<DesktopCapturerSource | undefined> {
  const sources = await desktopCapturer.getSources({
    types: [kindOf(id)],
    thumbnailSize: { width: 0, height: 0 }
  })
  return sources.find((s) => s.id === id && !isOwnWindow(s))
}

export function setupScreenCapture(): void {
  ipcMain.handle('d2:screen-capabilities', (event): ScreenCaptureCapabilities | null => {
    if (!fromApp(event)) return null
    return {
      platform: process.platform,
      systemAudio: systemAudioSupported(),
      // Chromium only excludes the app's own audio from loopback capture on Windows 11.
      excludeOwnAudio: isWindows11()
    }
  })

  ipcMain.handle('d2:screen-sources', async (event): Promise<ScreenSourceInfo[]> => {
    if (!fromApp(event)) return []
    return listSources()
  })

  ipcMain.handle(
    'd2:screen-select',
    async (event, sourceId: unknown, options: unknown): Promise<ScreenSelectResult> => {
      if (!fromApp(event) || !isValidSourceId(sourceId)) {
        return { ok: false, error: 'invalid-source' }
      }
      const audio =
        typeof options === 'object' &&
        options !== null &&
        (options as { audio?: unknown }).audio === true
      const source = await findSource(sourceId)
      if (!source) return { ok: false, error: 'source-gone' }
      selection.arm({
        sourceId: source.id,
        name: source.name,
        audio: audio && systemAudioSupported(),
        senderId: event.sender.id
      })
      return { ok: true, name: source.name, kind: kindOf(source.id) }
    }
  )

  ipcMain.handle('d2:screen-cancel', (event) => {
    if (fromApp(event)) selection.clear()
  })

  ipcMain.handle('d2:app-metrics', async (event): Promise<AppMetrics | null> => {
    if (!fromApp(event)) return null
    const gpu = app.getGPUFeatureStatus()
    let gpuVendor: string | undefined
    try {
      const info = (await app.getGPUInfo('basic')) as {
        gpuDevice?: { vendorId: number; active?: boolean }[]
      }
      const active = info.gpuDevice?.find((d) => d.active) ?? info.gpuDevice?.[0]
      const vendors: Record<number, string> = { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x8086: 'Intel' }
      if (active) gpuVendor = vendors[active.vendorId] ?? `0x${active.vendorId.toString(16)}`
    } catch {
      // GPU info is best-effort.
    }
    return {
      processes: app.getAppMetrics().map((m) => ({
        type: m.type,
        cpuPercent: m.cpu.percentCPUUsage,
        memoryMB: Math.round((m.memory.workingSetSize / 1024) * 10) / 10
      })),
      gpuVendor,
      videoEncode: gpu.video_encode,
      videoDecode: gpu.video_decode
    }
  })

  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      const frameContents = request.frame ? webContents.fromFrame(request.frame) : undefined
      const result = selection.consume(frameContents?.id)
      if (!result.ok || !isAppUrl(request.securityOrigin) || !request.videoRequested) {
        // No explicit, current selection from this window: deny.
        callback(null)
        return
      }
      const chosen = result.selection
      findSource(chosen.sourceId)
        .then((source) => {
          if (!source) return callback(null)
          const streams: Streams = { video: { id: source.id, name: source.name } }
          if (chosen.audio && request.audioRequested) streams.audio = 'loopback'
          callback(streams)
        })
        .catch(() => callback(null))
    },
    { useSystemPicker: false }
  )
}
