import { useEffect, useState, type ReactNode } from 'react'
import type { SelectableStatus, UserSettings } from '../types'
import { accentChoices, defaultSettings } from '../data/defaults'
import { presenceFromSetting, statusLabels } from '../lib/format'
import { LIMITS } from '../net/protocol'
import Avatar from './Avatar'
import { CloseIcon } from './Icons'

type SectionId = 'account' | 'appearance' | 'voice' | 'notifications'

const sections: { id: SectionId; label: string }[] = [
  { id: 'account', label: 'My Account' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'voice', label: 'Voice & Audio' },
  { id: 'notifications', label: 'Notifications' }
]

const statusOptions: SelectableStatus[] = ['online', 'idle', 'dnd', 'invisible']

interface SettingsPanelProps {
  settings: UserSettings
  displayName: string
  username: string
  avatarColor: string
  serverUrl: string
  muted: boolean
  deafened: boolean
  onChange: (patch: Partial<UserSettings>) => void
  onSaveDisplayName: (name: string) => Promise<string | null>
  onLogout: () => void
  onToggleMute: () => void
  onToggleDeafen: () => void
  onClose: () => void
}

function Toggle({
  label,
  description,
  checked,
  onChange
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <label className="setting-row">
      <div className="setting-row-text">
        <span className="setting-label">{label}</span>
        {description && <span className="setting-description">{description}</span>}
      </div>
      <input
        type="checkbox"
        className="switch"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="setting-field">
      <span className="setting-field-label">{label}</span>
      {children}
    </div>
  )
}

function SettingsPanel({
  settings,
  displayName,
  username,
  avatarColor,
  serverUrl,
  muted,
  deafened,
  onChange,
  onSaveDisplayName,
  onLogout,
  onToggleMute,
  onToggleDeafen,
  onClose
}: SettingsPanelProps): React.JSX.Element {
  const [section, setSection] = useState<SectionId>('account')
  const [nameDraft, setNameDraft] = useState(displayName)
  const [nameSaving, setNameSaving] = useState(false)
  const [nameMessage, setNameMessage] = useState<{ error: boolean; text: string } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const trimmedName = nameDraft.trim()
  const nameChanged = trimmedName.length > 0 && trimmedName !== displayName

  const saveName = async (): Promise<void> => {
    if (!nameChanged || nameSaving) return
    setNameSaving(true)
    setNameMessage(null)
    const error = await onSaveDisplayName(trimmedName)
    setNameSaving(false)
    setNameMessage(error ? { error: true, text: error } : { error: false, text: 'Saved' })
  }

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="User Settings">
      <nav className="settings-nav">
        <div className="settings-nav-inner">
          <h4>User Settings</h4>
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settings-nav-item${section === s.id ? ' active' : ''}`}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
          <div className="settings-nav-separator" />
          <button
            type="button"
            className="settings-nav-item"
            onClick={() => onChange({ ...defaultSettings })}
          >
            Reset to Defaults
          </button>
          <button type="button" className="settings-nav-item danger" onClick={onLogout}>
            Sign Out
          </button>
        </div>
      </nav>

      <div className="settings-content">
        <div className="settings-content-inner">
          {section === 'account' && (
            <>
              <h2>My Account</h2>
              <div className="profile-card">
                <div className="profile-banner" style={{ background: settings.accentColor }} />
                <div className="profile-card-body">
                  <Avatar
                    name={displayName}
                    color={avatarColor}
                    size={80}
                    status={presenceFromSetting(settings.status)}
                    ringColor="var(--bg-floating)"
                  />
                  <div>
                    <div className="profile-name">{displayName}</div>
                    <div className="profile-sub">
                      {settings.customStatus || statusLabels[settings.status]}
                    </div>
                  </div>
                </div>
              </div>

              <Field label="Display Name">
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void saveName()
                  }}
                >
                  <input
                    className="text-input"
                    type="text"
                    value={nameDraft}
                    maxLength={LIMITS.displayNameMaxLength}
                    onChange={(e) => {
                      setNameDraft(e.target.value)
                      setNameMessage(null)
                    }}
                  />
                  <button
                    type="submit"
                    className="button primary"
                    disabled={!nameChanged || nameSaving}
                  >
                    {nameSaving ? 'Saving…' : 'Save'}
                  </button>
                </form>
                {nameMessage && (
                  <span className={`field-hint${nameMessage.error ? ' error' : ''}`}>
                    {nameMessage.text}
                  </span>
                )}
              </Field>

              <div className="dev-notice">
                <strong>Development identity</strong>
                <span>
                  Signed in as <code>@{username}</code> on <code>{serverUrl}</code>. Dev identities
                  have no password and are not secure authentication.
                </span>
              </div>

              <Field label="Custom Status">
                <input
                  className="text-input"
                  type="text"
                  value={settings.customStatus}
                  maxLength={64}
                  placeholder="What are you up to?"
                  onChange={(e) => onChange({ customStatus: e.target.value })}
                />
              </Field>

              <Field label="Online Status">
                <div className="status-options" role="radiogroup">
                  {statusOptions.map((status) => (
                    <label
                      key={status}
                      className={`status-option${settings.status === status ? ' selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="status"
                        value={status}
                        checked={settings.status === status}
                        onChange={() => onChange({ status })}
                      />
                      <span className={`status-dot inline status-${presenceFromSetting(status)}`} />
                      {statusLabels[status]}
                    </label>
                  ))}
                </div>
              </Field>
            </>
          )}

          {section === 'appearance' && (
            <>
              <h2>Appearance</h2>
              <Field label="Accent Color">
                <div className="swatches">
                  {accentChoices.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={`swatch${settings.accentColor === color ? ' selected' : ''}`}
                      style={{ background: color }}
                      onClick={() => onChange({ accentColor: color })}
                      aria-label={`Accent ${color}`}
                      aria-pressed={settings.accentColor === color}
                    />
                  ))}
                </div>
              </Field>

              <Field label={`Chat Font Size — ${settings.fontSize}px`}>
                <input
                  className="slider"
                  type="range"
                  min={12}
                  max={20}
                  step={1}
                  value={settings.fontSize}
                  onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
                />
              </Field>

              <Toggle
                label="Compact Mode"
                description="Fit more messages on screen by removing avatars and spacing."
                checked={settings.compactMode}
                onChange={(compactMode) => onChange({ compactMode })}
              />
              <Toggle
                label="Show Timestamps"
                description="Display the time each message was sent."
                checked={settings.showTimestamps}
                onChange={(showTimestamps) => onChange({ showTimestamps })}
              />
            </>
          )}

          {section === 'voice' && (
            <>
              <h2>Voice &amp; Audio</h2>
              <Field label={`Input Volume — ${settings.inputVolume}%`}>
                <input
                  className="slider"
                  type="range"
                  min={0}
                  max={100}
                  value={settings.inputVolume}
                  onChange={(e) => onChange({ inputVolume: Number(e.target.value) })}
                />
              </Field>
              <Field label={`Output Volume — ${settings.outputVolume}%`}>
                <input
                  className="slider"
                  type="range"
                  min={0}
                  max={200}
                  value={settings.outputVolume}
                  onChange={(e) => onChange({ outputVolume: Number(e.target.value) })}
                />
              </Field>
              <Toggle label="Mute Microphone" checked={muted || deafened} onChange={onToggleMute} />
              <Toggle label="Deafen" checked={deafened} onChange={onToggleDeafen} />
              <p className="settings-note">
                Voice is simulated for now — no audio devices are accessed yet.
              </p>
            </>
          )}

          {section === 'notifications' && (
            <>
              <h2>Notifications</h2>
              <Toggle
                label="Desktop Notifications"
                description="Show a notification when you are mentioned."
                checked={settings.desktopNotifications}
                onChange={(desktopNotifications) => onChange({ desktopNotifications })}
              />
              <Toggle
                label="Notification Sounds"
                description="Play a sound for new messages."
                checked={settings.notificationSounds}
                onChange={(notificationSounds) => onChange({ notificationSounds })}
              />
            </>
          )}
        </div>

        <div className="settings-close">
          <button type="button" onClick={onClose} aria-label="Close settings">
            <CloseIcon size={18} />
          </button>
          <span>ESC</span>
        </div>
      </div>
    </div>
  )
}

export default SettingsPanel
