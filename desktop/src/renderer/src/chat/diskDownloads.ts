import { createContext, useContext, useEffect, useState } from 'react'

/**
 * Downloads saved straight to disk by the desktop app (large files, Milestone 13): the
 * workspace provides a starter; cards show progress from the main process.
 */
export interface DiskDownloads {
  /** Starts a Save-as download; false if this build or server can't (fall back to memory). */
  start: (attachmentId: string) => Promise<boolean>
  /** The URL the main process reports progress for. */
  urlFor: (attachmentId: string) => string | null
}

export const DiskDownloadContext = createContext<DiskDownloads | null>(null)

/** Files bigger than this are saved through the main process instead of renderer memory. */
export const DISK_DOWNLOAD_MIN_BYTES = 50 * 1024 * 1024

export interface DownloadState {
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  received: number
  total: number
}

/** Live progress of a disk download for one attachment (undefined until one starts). */
export function useDiskDownload(attachmentId: string): {
  supported: boolean
  start: () => Promise<boolean>
  progress: DownloadState | undefined
} {
  const downloads = useContext(DiskDownloadContext)
  const url = downloads?.urlFor(attachmentId) ?? null
  const [progress, setProgress] = useState<{ url: string; value: DownloadState } | undefined>()
  useEffect(() => {
    const api = window.d2?.downloads
    if (!api || !url) return
    return api.onProgress((p) => {
      if (p.url.split('?')[0] === url) {
        setProgress({ url, value: { state: p.state, received: p.received, total: p.total } })
      }
    })
  }, [url])
  return {
    supported: Boolean(downloads && url && window.d2?.downloads),
    start: () => (downloads ? downloads.start(attachmentId) : Promise.resolve(false)),
    progress: progress && progress.url === url ? progress.value : undefined
  }
}
