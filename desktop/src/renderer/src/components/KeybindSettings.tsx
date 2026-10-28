import { useState } from 'react'
import {
  COMMANDS,
  bindingFromEvent,
  bindingProblem,
  bindingToAccelerator,
  effectiveBinding,
  formatBinding,
  resetCommand,
  type CommandId,
  type CommandInfo,
  type Keybinds
} from '../lib/keybinds'
import { describeKey } from '../media/voiceLogic'

interface KeybindSettingsProps {
  keybinds: Keybinds
  onChange: (next: Keybinds) => void
  /** Whether each system-wide shortcut could be registered. */
  globalStatus: Partial<Record<CommandId, boolean>>
  pushToTalkKey: string
  onOpenVoiceSettings: () => void
}

const GROUPS: { id: CommandInfo['category']; label: string }[] = [
  { id: 'voice', label: 'Voice' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'app', label: 'App' }
]

/** Settings → Keybinds. Shortcuts work while Discord 2.0 is focused unless made system-wide. */
function KeybindSettings({
  keybinds,
  onChange,
  globalStatus,
  pushToTalkKey,
  onOpenVoiceSettings
}: KeybindSettingsProps): React.JSX.Element {
  const [recording, setRecording] = useState<CommandId | null>(null)
  const [problem, setProblem] = useState<{ id: CommandId; text: string } | null>(null)
  // After a reset took a shortcut back from another command.
  const [notice, setNotice] = useState<{ id: CommandId; text: string } | null>(null)
  const isMac = window.d2?.platform === 'darwin'

  const set = (id: CommandId, entry: Keybinds[CommandId] | undefined): void => {
    const next = { ...keybinds }
    if (entry) next[id] = entry
    else delete next[id]
    onChange(next)
  }

  const record = (command: CommandInfo, e: React.KeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      setRecording(null)
      setProblem(null)
      return
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      set(command.id, { binding: null })
      setRecording(null)
      setProblem(null)
      return
    }
    const binding = bindingFromEvent(e.nativeEvent)
    if (!binding) return // a modifier on its own: keep listening
    const issue = bindingProblem(binding, command.id, keybinds)
    if (issue) {
      setProblem({ id: command.id, text: issue })
      return
    }
    const wasGlobal = keybinds[command.id]?.global === true
    // A system-wide shortcut must stay usable as one; otherwise switch that off.
    const keepGlobal = wasGlobal && bindingToAccelerator(binding) !== null
    set(command.id, { binding, ...(keepGlobal ? { global: true } : {}) })
    setRecording(null)
    setProblem(null)
  }

  return (
    <>
      <h2>Keybinds</h2>
      <p className="settings-note">
        Shortcuts work while the Discord 2.0 window is focused. Mute and deafen can also be made
        system-wide, so they work while you&rsquo;re in a game or another app. Shortcuts that
        Windows or the app already use (like Alt+F4, Ctrl+C or Ctrl+F) can&rsquo;t be chosen.
      </p>

      <div className="keybind-row">
        <div className="keybind-text">
          <span className="setting-label">Push to talk</span>
          <span className="setting-description">
            Hold to talk. Set in Voice &amp; Audio, where you also choose push-to-talk mode.
          </span>
        </div>
        <kbd className="keybind-chip">{describeKey(pushToTalkKey)}</kbd>
        <button type="button" className="button secondary small" onClick={onOpenVoiceSettings}>
          Voice &amp; Audio
        </button>
      </div>

      {GROUPS.map((group) => (
        <section key={group.id} className="keybind-group" aria-label={group.label}>
          <h3 className="setting-field-label">{group.label}</h3>
          {COMMANDS.filter((c) => c.category === group.id).map((command) => {
            const binding = effectiveBinding(keybinds, command.id)
            const changed = keybinds[command.id] !== undefined
            const isRecording = recording === command.id
            const global = keybinds[command.id]?.global === true
            const globalOk = globalStatus[command.id]
            const canBeGlobal = binding !== null && bindingToAccelerator(binding) !== null
            const errorId = `keybind-${command.id}-error`
            return (
              <div key={command.id} className="keybind-row">
                <div className="keybind-text">
                  <span className="setting-label">{command.label}</span>
                  <span className="setting-description">{command.description}</span>
                  {command.globalCapable && (
                    <label className="checkbox-row keybind-global">
                      <input
                        type="checkbox"
                        checked={global}
                        disabled={!canBeGlobal}
                        onChange={(e) =>
                          set(command.id, {
                            binding,
                            ...(e.target.checked ? { global: true } : {})
                          })
                        }
                      />
                      Also works in other apps (system-wide)
                    </label>
                  )}
                  {command.globalCapable && global && globalOk === false && (
                    <span className="field-hint error" role="alert">
                      Couldn&rsquo;t make this system-wide: another app may already use{' '}
                      {formatBinding(binding, isMac)}. It still works inside Discord 2.0.
                    </span>
                  )}
                  {problem?.id === command.id && (
                    <span id={errorId} className="field-hint error" role="alert">
                      {problem.text}
                    </span>
                  )}
                  {notice?.id === command.id && (
                    <span className="field-hint" role="status">
                      {notice.text}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className={`keybind-chip as-button${isRecording ? ' recording' : ''}`}
                  aria-label={
                    isRecording
                      ? `Press the new shortcut for ${command.label}. Escape cancels, Backspace removes it.`
                      : `${command.label}: ${formatBinding(binding, isMac)}. Change`
                  }
                  aria-describedby={problem?.id === command.id ? errorId : undefined}
                  onClick={() => {
                    setRecording(isRecording ? null : command.id)
                    setProblem(null)
                    setNotice(null)
                  }}
                  onKeyDown={(e) => {
                    if (isRecording) record(command, e)
                  }}
                  onBlur={() => isRecording && setRecording(null)}
                >
                  {isRecording ? 'Press keys…' : formatBinding(binding, isMac)}
                </button>
                <button
                  type="button"
                  className="button secondary small"
                  disabled={!changed}
                  onClick={() => {
                    const result = resetCommand(keybinds, command.id)
                    onChange(result.keybinds)
                    setProblem(null)
                    const other = COMMANDS.find((c) => c.id === result.unassigned)
                    setNotice(
                      other
                        ? {
                            id: command.id,
                            text: `${formatBinding(effectiveBinding(result.keybinds, command.id), isMac)} was used for “${other.label}”, which now has no shortcut.`
                          }
                        : null
                    )
                  }}
                  aria-label={`Reset ${command.label} to its default`}
                >
                  Reset
                </button>
              </div>
            )
          })}
        </section>
      ))}

      <div className="settings-actions">
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            onChange({})
            setProblem(null)
            setNotice(null)
            setRecording(null)
          }}
        >
          Restore default keybinds
        </button>
      </div>
    </>
  )
}

export default KeybindSettings
