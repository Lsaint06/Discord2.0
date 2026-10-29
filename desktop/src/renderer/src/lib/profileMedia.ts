import { createContext, useContext, useEffect, useState } from 'react'
import type { AttachmentCache } from '../chat/attachmentCache'

export type ProfileImageSize = 'full' | 'small' | 'still'

/**
 * Authenticated cache for profile pictures and banners, keyed `${mediaId}:${size}`. Ids are
 * immutable (a new picture gets a new id), so cached blobs never go stale.
 */
export const ProfileMediaContext = createContext<AttachmentCache | null>(null)

export const profileMediaKey = (id: string, size: ProfileImageSize): string => `${id}:${size}`

/** Server icons share the cache; their keys carry a prefix (see useBackend). */
export const SERVER_ICON_PREFIX = 'icon:'
export const serverIconKey = (id: string, size: ProfileImageSize): string =>
  `${SERVER_ICON_PREFIX}${profileMediaKey(id, size)}`

export function parseProfileMediaKey(key: string): { id: string; size: ProfileImageSize } {
  const [id = '', size] = key.split(':')
  return { id, size: size === 'full' || size === 'still' ? size : 'small' }
}

/** blob: URL of a profile image, or undefined while loading / when missing or failed. */
export function useProfileImage(
  id: string | null | undefined,
  size: ProfileImageSize
): { url?: string; failed: boolean } {
  return useCachedImage(id ? profileMediaKey(id, size) : null)
}

/** blob: URL of a server icon (members only), or undefined while loading / missing. */
export function useServerIcon(
  id: string | null | undefined,
  size: ProfileImageSize
): { url?: string; failed: boolean } {
  return useCachedImage(id ? serverIconKey(id, size) : null)
}

/** GIF media from the picker proxy (same cache, 'gif:' keys). */
export const GIF_PREFIX = 'gif:'
export type GifSize = 'preview' | 'still' | 'full'
export const gifKey = (id: string, size: GifSize): string => `${GIF_PREFIX}${id}:${size}`

export function parseGifKey(key: string): { id: string; size: GifSize } {
  const [id = '', size] = key.slice(GIF_PREFIX.length).split(':')
  return { id, size: size === 'preview' || size === 'still' ? size : 'full' }
}

export function useGifMedia(id: string | null, size: GifSize): { url?: string; failed: boolean } {
  return useCachedImage(id ? gifKey(id, size) : null)
}

function useCachedImage(key: string | null): { url?: string; failed: boolean } {
  const cache = useContext(ProfileMediaContext)
  const [state, setState] = useState<{ key: string | null; url?: string; failed: boolean }>({
    key: null,
    failed: false
  })

  useEffect(() => {
    if (!cache || !key || cache.peek(key)) return
    let cancelled = false
    cache.get(key).then(
      (url) => !cancelled && setState({ key, url, failed: false }),
      () => !cancelled && setState({ key, failed: true })
    )
    return () => {
      cancelled = true
    }
  }, [cache, key])

  if (!cache || !key) return { failed: false }
  const cached = cache.peek(key)
  if (cached) return { url: cached, failed: false }
  return state.key === key ? { url: state.url, failed: state.failed } : { failed: false }
}

/** Large photos are fine to pick: they're cropped and shrunk here before uploading. */
const MAX_INPUT_BYTES = 40 * 1024 * 1024
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const PROFILE_IMAGE_ACCEPT = ACCEPTED.join(',')

/** Quick checks before opening the cropper; the server validates everything again. */
export function checkProfileImageFile(file: File): string | null {
  if (!ACCEPTED.includes(file.type)) return 'Choose a PNG, JPEG, WebP or GIF image.'
  if (file.size > MAX_INPUT_BYTES) return 'That image is too large (40 MB maximum).'
  if (file.size === 0) return 'That file is empty.'
  return null
}
