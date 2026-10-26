import { useEffect, useState } from 'react'
import { codeToAccelerator, isNonTypingKey } from '../media/voiceLogic'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
}

interface PushToTalkOptions {
  /** Push-to-talk mode is on and we're in a voice channel. */
  enabled: boolean
  /** KeyboardEvent.code of the bound key. */
  code: string
  /** Experimental system-wide toggle via Electron globalShortcut. */
  global: boolean
}

export interface PushToTalk {
  active: boolean
  /** Why system-wide push-to-talk couldn't be enabled, if it couldn't. */
  globalError?: string
}

/**
 * Hold-to-talk while the app window is focused (default), or an experimental system-wide
 * toggle. Typing keys are ignored while focus is in a text field so chatting never keys the mic.
 */
export function usePushToTalk({ enabled, code, global }: PushToTalkOptions): PushToTalk {
  const [heldKey, setHeldKey] = useState<string | null>(null)
  const [toggledOn, setToggledOn] = useState(false)
  const [globalError, setGlobalError] = useState<string>()

  const useGlobal = enabled && global && Boolean(window.d2)

  // In-window hold-to-talk.
  useEffect(() => {
    if (!enabled || useGlobal) return
    const onDown = (e: KeyboardEvent): void => {
      if (e.code !== code || e.repeat) return
      if (isTypingTarget(e.target) && !isNonTypingKey(code)) return
      setHeldKey(code)
    }
    const onUp = (e: KeyboardEvent): void => {
      if (e.code === code) setHeldKey(null)
    }
    // Key-up never arrives if the window loses focus mid-press, so release on blur.
    const onBlur = (): void => setHeldKey(null)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [enabled, useGlobal, code])

  // System-wide toggle: registered only while in voice with push-to-talk on.
  useEffect(() => {
    const bridge = window.d2
    if (!useGlobal || !bridge) return
    let cancelled = false
    const accelerator = codeToAccelerator(code)
    const off = bridge.pushToTalk.onToggle(() => setToggledOn((on) => !on))
    if (accelerator) {
      void bridge.pushToTalk.register(accelerator).then((ok) => {
        if (cancelled) return
        setGlobalError(
          ok ? undefined : `Couldn't register ${accelerator} system-wide (another app may own it).`
        )
      })
    } else {
      void Promise.resolve().then(() => {
        if (!cancelled) setGlobalError('This key can’t be used as a system-wide shortcut.')
      })
    }
    return () => {
      cancelled = true
      off()
      void bridge.pushToTalk.unregister()
      // Never carry a "talking" toggle over into the next session.
      setToggledOn(false)
    }
  }, [useGlobal, code])

  if (!enabled) return { active: false }
  if (useGlobal) return { active: toggledOn, globalError }
  return { active: heldKey === code }
}
