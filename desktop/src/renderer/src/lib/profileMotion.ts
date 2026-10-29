/**
 * Milestone 14: when profile art may move. Motion is allowed unless reduced motion is on (your
 * preference or Windows') or "Profile effects: Reduced" is chosen on this device.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { EFFECT_DURATION_MS } from './profileStyle'

export const ProfileMotionContext = createContext<boolean>(true)

export const useProfileMotion = (): boolean => useContext(ProfileMotionContext)

/**
 * Activity of one profile surface (card, popout, studio preview):
 * - `active`: decorations/banners/animated pictures may move — for the first few seconds after
 *   opening, then while the pointer is over it (or focus is inside);
 * - `run`: increments each time the profile effect should (re)play — on open and on re-entry.
 * Returns handlers to spread on the surface's root element.
 */
export function useProfileActivity(motion: boolean): {
  active: boolean
  run: number
  bind: {
    onPointerEnter: () => void
    onPointerLeave: () => void
    onFocus: () => void
    onBlur: (e: React.FocusEvent) => void
  }
  replay: () => void
} {
  const [hovered, setHovered] = useState(false)
  const [opening, setOpening] = useState(true)
  const [run, setRun] = useState(1)
  const lastRun = useRef(0)

  useEffect(() => {
    lastRun.current = Date.now()
    const timer = setTimeout(() => setOpening(false), EFFECT_DURATION_MS)
    return () => clearTimeout(timer)
  }, [])

  const replay = useCallback(() => {
    // One play at a time: re-entering mid-effect doesn't restart it.
    if (Date.now() - lastRun.current < EFFECT_DURATION_MS) return
    lastRun.current = Date.now()
    setRun((r) => r + 1)
  }, [])

  const enter = useCallback(() => {
    setHovered(true)
    replay()
  }, [replay])

  return {
    active: motion && (opening || hovered),
    run: motion ? run : 0,
    bind: {
      onPointerEnter: enter,
      onPointerLeave: () => setHovered(false),
      onFocus: () => setHovered(true),
      onBlur: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHovered(false)
      }
    },
    replay: () => {
      lastRun.current = 0
      replay()
    }
  }
}
