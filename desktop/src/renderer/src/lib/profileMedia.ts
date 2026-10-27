import { createContext, useContext, useEffect, useState } from 'react'
import type { AttachmentCache } from '../chat/attachmentCache'

export type ProfileImageSize = 'full' | 'small'

/**
 * Authenticated cache for profile pictures and banners, keyed `${mediaId}:${size}`. Ids are
 * immutable (a new picture gets a new id), so cached blobs never go stale.
 */
export const ProfileMediaContext = createContext<AttachmentCache | null>(null)

export const profileMediaKey = (id: string, size: ProfileImageSize): string => `${id}:${size}`

export function parseProfileMediaKey(key: string): { id: string; size: ProfileImageSize } {
  const [id = '', size] = key.split(':')
  return { id, size: size === 'full' ? 'full' : 'small' }
}

/** blob: URL of a profile image, or undefined while loading / when missing or failed. */
export function useProfileImage(
  id: string | null | undefined,
  size: ProfileImageSize
): { url?: string; failed: boolean } {
  const cache = useContext(ProfileMediaContext)
  const key = id ? profileMediaKey(id, size) : null
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
