import { useEffect, useRef, useState } from 'react'
import type { UserSettings } from '../types'
import { SOUND_EVENTS, SOUND_INFO, type SoundEvent, type SoundInfo } from '../sound/sounds'
import { DEFAULT_SOUND_EVENTS, DEFAULT_SOUND_VOLUME } from '../sound/soundPolicy'
import { useSoundService } from '../sound/soundContext'
import {
  CUSTOM_SOUND_ACCEPT,
  CUSTOM_SOUND_MAX_SECONDS,
  MAX_CUSTOM_SOUNDS,
  decodeToMono,
  deleteCustomSound,
  importCustomSound,
  listCustomSounds,
  loadCustomSoundData,
  type CustomSoundMeta
} from '../sound/customSounds'
import { formatBytes } from '../chat/uploads'
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
  const [library, setLibrary] = useState<CustomSoundMeta[]>([])
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const audible = settings.soundEffects && settings.soundVolume > 0

  useEffect(() => {
    let alive = true
    listCustomSounds()
      .then((list) => alive && setLibrary(list))
      .catch(() => alive && setLibraryError('Your sounds couldn’t be loaded on this PC.'))
    return () => {
      alive = false
    }
  }, [])

  /** Makes sure the service has the file (for previews and newly chosen sounds). */
  const register = async (meta: CustomSoundMeta): Promise<boolean> => {
    const data = await loadCustomSoundData(meta.id).catch(() => null)
    if (!data || !sound) return false
    sound.setCustomSound(meta.id, { data, gain: meta.gain })
    return true
  }

  const reportPlay = (result: ReturnType<NonNullable<typeof sound>['preview']>): void => {
    if (result === 'unavailable') {
      setNotice('Sound couldn’t play right now. Check that an output device is available.')
    } else if (sound?.deviceFallback) {
      setNotice(
        'Your selected output device isn’t available, so sounds play on the default device.'
      )
    } else {
      setNotice(null)
    }
  }

  const preview = (event: SoundEvent): void => {
    if (!sound) return
    reportPlay(sound.preview(event))
  }

  const previewCustom = (meta: CustomSoundMeta): void => {
    if (!sound) return
    void register(meta).then((ok) => reportPlay(ok ? sound.previewCustom(meta.id) : 'unavailable'))
  }

  const setEvent = (event: SoundEvent, on: boolean): void =>
    onChange({ soundEvents: { ...settings.soundEvents, [event]: on } })

  const setCustom = (event: SoundEvent, id: string): void => {
    const next = { ...settings.soundCustom }
    if (id) {
      next[event] = id
      const meta = library.find((m) => m.id === id)
      if (meta) void register(meta)
    } else {
      delete next[event]
    }
    onChange({ soundCustom: next })
  }

  const importFile = async (file: File): Promise<void> => {
    setLibraryError(null)
    setImporting(true)
    try {
      const result = await importCustomSound(file, library.length, decodeToMono)
      if (!result.ok) {
        setLibraryError(result.error)
        return
      }
      setLibrary((list) => [...list, result.meta])
      await register(result.meta)
    } catch {
      setLibraryError('That sound couldn’t be saved on this PC.')
    } finally {
      setImporting(false)
    }
  }

  const remove = async (meta: CustomSoundMeta): Promise<void> => {
    setLibraryError(null)
    try {
      await deleteCustomSound(meta.id)
    } catch {
      setLibraryError('That sound couldn’t be deleted.')
      return
    }
    sound?.setCustomSound(meta.id, null)
    setLibrary((list) => list.filter((m) => m.id !== meta.id))
    // Events that used it go back to their built-in sound.
    const custom = { ...settings.soundCustom }
    let changed = false
    for (const event of SOUND_EVENTS) {
      if (custom[event] === meta.id) {
        delete custom[event]
        changed = true
      }
    }
    if (changed) onChange({ soundCustom: custom })
  }

  const categoryVolume = (group: SoundInfo['group']): number =>
    settings.soundCategoryVolumes[group] ?? 100
  const eventVolume = (event: SoundEvent): number => settings.soundEventVolumes[event] ?? 100

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
          <label className="sound-volume-row">
            <span>{group.label} volume</span>
            <input
              className="slider"
              type="range"
              min={0}
              max={100}
              step={5}
              value={categoryVolume(group.id)}
              disabled={!settings.soundEffects}
              aria-valuetext={`${categoryVolume(group.id)}%`}
              onChange={(e) =>
                onChange({
                  soundCategoryVolumes: {
                    ...settings.soundCategoryVolumes,
                    [group.id]: Number(e.target.value)
                  }
                })
              }
            />
            <span className="sound-volume-value">{categoryVolume(group.id)}%</span>
          </label>
          {SOUND_EVENTS.filter((e) => SOUND_INFO[e].group === group.id).map((event) => {
            const info = SOUND_INFO[event]
            const customId = settings.soundCustom[event] ?? ''
            const missing = customId !== '' && !library.some((m) => m.id === customId)
            return (
              <div key={event} className={`sound-row${settings.soundEffects ? '' : ' disabled'}`}>
                <Toggle
                  label={info.label}
                  description={info.description}
                  checked={settings.soundEvents[event]}
                  onChange={(on) => setEvent(event, on)}
                />
                <div className="sound-row-controls">
                  <select
                    className="text-input sound-source"
                    value={missing ? '' : customId}
                    disabled={!settings.soundEffects}
                    aria-label={`Sound for “${info.label}”`}
                    onChange={(e) => setCustom(event, e.target.value)}
                  >
                    <option value="">Built-in sound</option>
                    {library.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className="slider sound-event-volume"
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={eventVolume(event)}
                    disabled={!settings.soundEffects}
                    aria-label={`“${info.label}” volume`}
                    aria-valuetext={`${eventVolume(event)}%`}
                    title={`Volume ${eventVolume(event)}%`}
                    onChange={(e) =>
                      onChange({
                        soundEventVolumes: {
                          ...settings.soundEventVolumes,
                          [event]: Number(e.target.value)
                        }
                      })
                    }
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
              </div>
            )
          })}
        </section>
      ))}

      <section className="sound-group" aria-labelledby="your-sounds-title">
        <h3 id="your-sounds-title" className="setting-field-label">
          Your sounds
        </h3>
        <p className="setting-description">
          Import short WAV, MP3 or OGG clips (up to 1 MB and {CUSTOM_SOUND_MAX_SECONDS} seconds) and
          pick them above. They stay on this PC and play at the same loudness as the built-in
          sounds.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept={CUSTOM_SOUND_ACCEPT}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void importFile(file)
          }}
        />
        {libraryError && (
          <p className="form-error" role="alert">
            {libraryError}
          </p>
        )}
        {library.length > 0 && (
          <ul className="custom-sound-list">
            {library.map((m) => (
              <li key={m.id}>
                <span className="custom-sound-name">{m.name}</span>
                <span className="custom-sound-meta">
                  {(m.durationMs / 1000).toFixed(1)} s · {formatBytes(m.size)} ·{' '}
                  {m.format.toUpperCase()}
                </span>
                <button
                  type="button"
                  className="button secondary small"
                  disabled={!audible || !sound}
                  onClick={() => previewCustom(m)}
                  aria-label={`Preview ${m.name}`}
                >
                  Preview
                </button>
                <button
                  type="button"
                  className="button secondary small danger-text"
                  onClick={() => void remove(m)}
                  aria-label={`Delete ${m.name}`}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="button secondary"
          disabled={importing || library.length >= MAX_CUSTOM_SOUNDS}
          onClick={() => fileRef.current?.click()}
        >
          {importing ? 'Importing…' : 'Import a sound…'}
        </button>
      </section>

      <div className="settings-actions">
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setNotice(null)
            onChange({
              soundEffects: true,
              soundVolume: DEFAULT_SOUND_VOLUME,
              soundEvents: { ...DEFAULT_SOUND_EVENTS },
              soundCategoryVolumes: {},
              soundEventVolumes: {},
              soundCustom: {}
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
