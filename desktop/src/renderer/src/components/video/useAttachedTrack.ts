import { useEffect, useRef, useState } from 'react'
import type { Track } from 'livekit-client'

export type FrameState = 'loading' | 'playing' | 'stalled'

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

/**
 * Attaches a LiveKit video track to a <video> element and reports whether frames arrive.
 * Frames are counted in a ref (no React render per frame); state only changes on transitions
 * (first frame, frozen for ~2.5 s, moving again).
 */
export function useAttachedTrack(track: Track | undefined): {
  ref: React.RefObject<HTMLVideoElement | null>
  frames: FrameState
} {
  const ref = useRef<HTMLVideoElement>(null)
  const [frames, setFrames] = useState<FrameState>('loading')
  const mediaTrackId = track?.mediaStreamTrack?.id

  useEffect(() => {
    const el = ref.current as FrameVideo | null
    if (!track || !el) return
    setFrames('loading')
    track.attach(el)
    let last = 0
    let handle = 0
    let stopped = false
    const onFrame = (): void => {
      if (stopped) return
      last = performance.now()
      handle = el.requestVideoFrameCallback?.(onFrame) ?? 0
    }
    if (el.requestVideoFrameCallback) handle = el.requestVideoFrameCallback(onFrame)
    else el.addEventListener('timeupdate', onFrame)
    let current: FrameState = 'loading'
    const timer = setInterval(() => {
      const next: FrameState =
        last === 0 ? 'loading' : performance.now() - last > 2500 ? 'stalled' : 'playing'
      if (next !== current) {
        current = next
        setFrames(next)
      }
    }, 500)
    return () => {
      stopped = true
      clearInterval(timer)
      if (handle) el.cancelVideoFrameCallback?.(handle)
      el.removeEventListener('timeupdate', onFrame)
      track.detach(el)
    }
    // Re-attach only when the underlying MediaStreamTrack changes (device switch, resubscribe).
  }, [track, mediaTrackId])

  return { ref, frames }
}
