import { useEffect, useRef, useState } from 'react'
import type { PreferencesPatch } from '../../net/api'
import {
  LIMITS,
  type ApiPreferences,
  type MessageDensity,
  type ReducedMotionPreference,
  type ThemePreference
} from '../../net/protocol'
import { accentChoices, DEFAULT_ACCENT } from '../../data/defaults'
import { Field, Toggle } from '../SettingsControls'

interface AppearanceSettingsProps {
  preferences: ApiPreferences
  loaded: boolean
  onChange: (patch: PreferencesPatch) => Promise<string | null>
  fontSize: number
  onFontSizeChange: (size: number) => void
}

const THEMES: { id: ThemePreference; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Sync with computer' }
]

const DENSITIES: { id: MessageDensity; label: string; description: string }[] = [
  { id: 'cozy', label: 'Cozy', description: 'Avatars and comfortable spacing.' },
  { id: 'compact', label: 'Compact', description: 'Fit more messages on screen.' }
]

const MOTION: { id: ReducedMotionPreference; label: string }[] = [
  { id: 'system', label: 'Sync with computer' },
  { id: 'on', label: 'Reduce motion' },
  { id: 'off', label: 'Allow all animations' }
]

const IDLE_CHOICES = [5, 10, 15, 30, 60].filter(
  (m) => m >= LIMITS.idleTimeoutMinMinutes && m <= LIMITS.idleTimeoutMaxMinutes
)

function AppearanceSettings({
  preferences,
  loaded,
  onChange,
  fontSize,
  onFontSizeChange
}: AppearanceSettingsProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const change = (patch: PreferencesPatch): void => {
    setError(null)
    void onChange(patch).then((failure) => failure && setError(`Couldn’t save: ${failure}`))
  }
  // The color picker fires continuously while dragging: show it live, save once it settles.
  const [liveAccent, setLiveAccent] = useState<string | null>(null)
  const accentTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (accentTimer.current) clearTimeout(accentTimer.current)
    },
    []
  )
  const pickCustomAccent = (color: string): void => {
    setLiveAccent(color)
    if (accentTimer.current) clearTimeout(accentTimer.current)
    accentTimer.current = setTimeout(() => {
      setLiveAccent(null)
      change({ accentColor: color })
    }, 400)
  }
  const accent = liveAccent ?? preferences.accentColor ?? DEFAULT_ACCENT

  return (
    <>
      <h2>Appearance</h2>
      <p className="settings-note">
        These settings follow your account to every PC you sign in on.
        {!loaded && ' Loading your saved preferences…'}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <Field label="Theme">
        <div className="theme-options" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <label
              key={t.id}
              className={`theme-option ${t.id}${preferences.theme === t.id ? ' selected' : ''}`}
            >
              <input
                type="radio"
                name="theme"
                value={t.id}
                checked={preferences.theme === t.id}
                onChange={() => change({ theme: t.id })}
              />
              <span className="theme-swatch" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>{t.label}</span>
            </label>
          ))}
        </div>
      </Field>

      <Field label="Accent Color">
        <div className="swatches">
          {accentChoices.map((color) => (
            <button
              key={color}
              type="button"
              className={`swatch${accent === color ? ' selected' : ''}`}
              style={{ background: color }}
              onClick={() => change({ accentColor: color === DEFAULT_ACCENT ? null : color })}
              aria-label={`Accent ${color}`}
              aria-pressed={accent === color}
            />
          ))}
          <label className="swatch custom" title="Custom color">
            <span className="sr-only">Custom accent color</span>
            <input type="color" value={accent} onChange={(e) => pickCustomAccent(e.target.value)} />
          </label>
        </div>
      </Field>

      <Field label="Message Display">
        <div className="radio-cards" role="radiogroup" aria-label="Message display">
          {DENSITIES.map((d) => (
            <label
              key={d.id}
              className={`radio-card${preferences.density === d.id ? ' selected' : ''}`}
            >
              <input
                type="radio"
                name="density"
                value={d.id}
                checked={preferences.density === d.id}
                onChange={() => change({ density: d.id })}
              />
              <span className="radio-card-text">
                <span className="setting-label">{d.label}</span>
                <span className="setting-description">{d.description}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>

      <Toggle
        label="Show Timestamps"
        description="Display the time each message was sent."
        checked={preferences.showTimestamps}
        onChange={(showTimestamps) => change({ showTimestamps })}
      />

      <Field label="Animations">
        <select
          className="text-input"
          value={preferences.reducedMotion}
          onChange={(e) => change({ reducedMotion: e.target.value as ReducedMotionPreference })}
        >
          {MOTION.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Show me as Idle after">
        <select
          className="text-input"
          value={preferences.idleTimeoutMinutes}
          onChange={(e) => change({ idleTimeoutMinutes: Number(e.target.value) })}
        >
          {[...new Set([...IDLE_CHOICES, preferences.idleTimeoutMinutes])]
            .sort((a, b) => a - b)
            .map((m) => (
              <option key={m} value={m}>
                {m} minutes without activity
              </option>
            ))}
        </select>
      </Field>

      <div className="settings-subsection">
        <h3>This device only</h3>
        <Field label={`Chat Font Size — ${fontSize}px`}>
          <input
            className="slider"
            type="range"
            min={12}
            max={20}
            step={1}
            value={fontSize}
            onChange={(e) => onFontSizeChange(Number(e.target.value))}
          />
        </Field>
      </div>
    </>
  )
}

export default AppearanceSettings
