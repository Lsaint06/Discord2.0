import { useEffect, useRef } from 'react'

const POLL_MS = 15_000
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const

/**
 * Automatic idle detection. In Electron the main process reports system-wide idle time
 * (no input anywhere on the PC, or the screen is locked); in a plain browser only input in this
 * window counts. Calls `onChange` only when the idle state flips.
 */
export function useIdleDetection(timeoutMinutes: number, onChange: (idle: boolean) => void): void {
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    const thresholdS = Math.round(timeoutMinutes * 60)
    let idle = false
    const report = (next: boolean): void => {
      if (next === idle) return
      idle = next
      onChangeRef.current(next)
    }

    const system = window.d2?.system
    if (system) {
      let stopped = false
      const poll = (): void => {
        system
          .getIdleState(thresholdS)
          .then((state) => {
            if (!stopped && state !== 'unknown') report(state !== 'active')
          })
          .catch(() => undefined)
      }
      poll()
      const timer = setInterval(poll, POLL_MS)
      // Input in our own window makes us active right away (no need to wait for the poll).
      const onActivity = (): void => report(false)
      for (const name of ACTIVITY_EVENTS)
        window.addEventListener(name, onActivity, { passive: true })
      return () => {
        stopped = true
        clearInterval(timer)
        for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity)
      }
    }

    let last = Date.now()
    const onActivity = (): void => {
      last = Date.now()
      report(false)
    }
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { passive: true })
    const timer = setInterval(() => report(Date.now() - last >= thresholdS * 1000), POLL_MS)
    return () => {
      clearInterval(timer)
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity)
    }
  }, [timeoutMinutes])
}
