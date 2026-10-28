import { useEffect, useMemo, useRef, useState } from 'react'
import {
  COMMAND_IDS,
  bindingToAccelerator,
  effectiveBinding,
  isGlobal,
  matchCommand,
  type CommandId,
  type Keybinds
} from '../lib/keybinds'
import { anyDialogOpen } from '../lib/focusTrap'

export type CommandHandlers = Partial<Record<CommandId, () => void>>

/**
 * Runs commands from keyboard shortcuts. App-focused shortcuts listen on this window only (and
 * not while a dialog is open). System-wide ones — only the commands you switched on — are
 * registered through the main process; the result per command is returned for Settings.
 */
export function useKeybinds(
  keybinds: Keybinds,
  handlers: CommandHandlers
): Partial<Record<CommandId, boolean>> {
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  })
  const keybindsRef = useRef(keybinds)
  useEffect(() => {
    keybindsRef.current = keybinds
  }, [keybinds])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || e.defaultPrevented) return
      const id = matchCommand(e, keybindsRef.current)
      if (!id) return
      // Dialogs own the keyboard (the quick switcher closes itself).
      if (anyDialogOpen()) return
      const run = handlersRef.current[id]
      if (!run) return
      e.preventDefault()
      run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // System-wide: [{ id, accelerator }] for the commands you made global.
  const globalList = useMemo(
    () =>
      COMMAND_IDS.filter((id) => isGlobal(keybinds, id)).flatMap((id) => {
        const binding = effectiveBinding(keybinds, id)
        const accelerator = binding ? bindingToAccelerator(binding) : null
        return accelerator ? [{ id, accelerator }] : []
      }),
    [keybinds]
  )
  const globalKey = JSON.stringify(globalList)
  const [status, setStatus] = useState<Partial<Record<CommandId, boolean>>>({})

  useEffect(() => {
    const api = window.d2?.shortcuts
    if (!api) return
    let cancelled = false
    const list = JSON.parse(globalKey) as { id: CommandId; accelerator: string }[]
    void api.setGlobal(list).then((result) => {
      if (cancelled || !result) return
      const next: Partial<Record<CommandId, boolean>> = {}
      for (const { id } of list) next[id] = result[id] === true
      setStatus(next)
    })
    return () => {
      cancelled = true
    }
  }, [globalKey])

  useEffect(() => {
    const api = window.d2?.shortcuts
    if (!api) return
    const off = api.onTriggered((id) => {
      if ((COMMAND_IDS as readonly string[]).includes(id)) handlersRef.current[id as CommandId]?.()
    })
    return () => {
      off()
      // Leaving the workspace (sign-out): nothing stays registered system-wide.
      void api.setGlobal([])
    }
  }, [])

  return status
}
