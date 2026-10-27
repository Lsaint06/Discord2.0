import { useEffect, useState } from 'react'
import type { AttachmentCache } from '../chat/attachmentCache'

/** Loads an attachment through the authenticated cache and returns its blob: URL. */
export function useAttachmentUrl(
  cache: AttachmentCache,
  id: string | undefined
): { url?: string; error: boolean } {
  const [state, setState] = useState<{ id?: string; url?: string; error: boolean }>(() => ({
    id,
    url: id ? cache.peek(id) : undefined,
    error: false
  }))

  useEffect(() => {
    if (!id || cache.peek(id)) return
    let cancelled = false
    cache.get(id).then(
      (url) => {
        if (!cancelled) setState({ id, url, error: false })
      },
      () => {
        if (!cancelled) setState({ id, error: true })
      }
    )
    return () => {
      cancelled = true
    }
  }, [cache, id])

  if (!id) return { error: false }
  const cached = cache.peek(id)
  if (cached) return { url: cached, error: false }
  return state.id === id ? { url: state.url, error: state.error } : { error: false }
}

/** Saves an attachment via a temporary link (Electron shows its Save dialog). */
export async function downloadAttachment(
  cache: AttachmentCache,
  id: string,
  filename: string
): Promise<void> {
  const url = await cache.get(id)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}
