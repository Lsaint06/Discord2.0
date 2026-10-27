import { useState } from 'react'
import type { UserSettings } from '../types'
import { SOUND_EVENTS, SOUND_INFO, type SoundEvent, type SoundInfo } from '../sound/sounds'
import { DEFAULT_SOUND_EVENTS, DEFAULT_SOUND_VOLUME } from '../sound/soundPolicy'
import { useSoundService } from '../sound/soundContext'
import { Field, Toggle } from './SettingsControls'

interface SoundSettingsProps {
  settings: UserSettings
  onChange: (patch: Partial<UserSettings>) => void
}

const GROUPS: { id: SoundInfo['group']; label: string }[] = [
  { id: 'messages', label: 'Messages' },
  { id: 'voice', label: 'Voice' },
  { id: 'controls', label: 'Your controls' }
]

/** Settings → Sounds. Previews play only when their button is clicked. */
function SoundSettings({ settings, onChange }: SoundSettingsProps): React.JSX.Element {
  const sound = useSoundService()
  const [notice, setNotice] = useState<string | null>(null)
  const audible = settings.soundEffects && settings.soundVolume > 0

  const preview = (event: SoundEvent): void => {
    if (!sound) return
    const result = sound.preview(event)
    if (result === 'unavailable') {
      setNotice('Sound couldn’t play right now. Check that an output device is available.')
    } else if (sound.deviceFallback) {
      setNotice(
        'Your selected output device isn’t available, so sounds play on the default device.'
      )
    } else {
      setNotice(null)
    }
  }

  const setEvent = (event: SoundEvent, on: boolean): void =>
    onChange({ soundEvents: { ...settings.soundEvents, [event]: on } })

  return (
    <>
      <h2>Sounds</h2>
      <p className="settings-note">
        Sound effects play on this PC through your voice output device. Do Not Disturb silences
        message and mention sounds, and muted channels never play them. Windows notifications stay
        silent while these sounds are on.
      </p>

      <Toggle
        label="Sound Effects"
        description="Turn every sound effect on or off."
        checked={settings.soundEffects}
        onChange={(soundEffects) => onChange({ soundEffects })}
      />

      <Field label={`Sound Effects Volume — ${settings.soundVolume}%`}>
        <input
          className="slider"
          type="range"
          min={0}
          max={100}
          step={5}
          value={settings.soundVolume}
          disabled={!settings.soundEffects}
          aria-label="Sound effects volume"
          onChange={(e) => onChange({ soundVolume: Number(e.target.value) })}
        />
      </Field>

      {notice && (
        <p className="form-notice" role="status">
          {notice}
        </p>
      )}

      {GROUPS.map((group) => (
        <section key={group.id} className="sound-group" aria-label={group.label}>
          <h3 className="setting-field-label">{group.label}</h3>
          {SOUND_EVENTS.filter((e) => SOUND_INFO[e].group === group.id).map((event) => {
            const info = SOUND_INFO[event]
            return (
              <div key={event} className={`sound-row${settings.soundEffects ? '' : ' disabled'}`}>
                <Toggle
                  label={info.label}
                  description={info.description}
                  checked={settings.soundEvents[event]}
                  onChange={(on) => setEvent(event, on)}
                />
                <button
                  type="button"
                  className="button secondary small sound-preview"
                  onClick={() => preview(event)}
                  disabled={!audible || !sound}
                  aria-label={`Preview “${info.label}” sound`}
                >
                  Preview
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
            setNotice(null)
            onChange({
              soundEffects: true,
              soundVolume: DEFAULT_SOUND_VOLUME,
              soundEvents: { ...DEFAULT_SOUND_EVENTS }
            })
          }}
        >
          Reset sound settings
        </button>
      </div>
    </>
  )
}

export default SoundSettings
