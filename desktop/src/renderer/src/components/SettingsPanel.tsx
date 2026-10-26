import { useEffect, useState } from 'react'
import type { SelectableStatus, UserSettings } from '../types'
import { accentChoices, defaultSettings } from '../data/defaults'
import { presenceFromSetting, statusLabels } from '../lib/format'
import { LIMITS } from '../net/protocol'
import type { MediaSession, MediaSnapshot } from '../media/MediaSession'
import {
  projectedEgressMbps,
  SCREEN_CODEC_LABELS,
  SCREEN_PROFILES,
  type ScreenCodec,
  type ScreenContentHint,
  type ScreenProfileId
} from '../media/screenProfiles'
import Avatar from './Avatar'
import { CloseIcon } from './Icons'
import { Field, Toggle } from './SettingsControls'
import VoiceSettings from './VoiceSettings'
import DiagnosticsPanel from './DiagnosticsPanel'

type SectionId = 'account' | 'appearance' | 'voice' | 'streaming' | 'notifications' | 'diagnostics'

const sections: { id: SectionId; label: string }[] = [
  { id: 'account', label: 'My Account' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'voice', label: 'Voice & Audio' },
  { id: 'streaming', label: 'Screen Share' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'diagnostics', label: 'Diagnostics' }
]

const statusOptions: SelectableStatus[] = ['online', 'idle', 'dnd', 'invisible']

interface SettingsPanelProps {
  settings: UserSettings
  voiceSession: MediaSession
  voiceState: MediaSnapshot
  userName: (userId: string) => string
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

function SettingsPanel({
  settings,
  voiceSession,
  voiceState,
  userName,
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
            <VoiceSettings
              session={voiceSession}
              settings={settings}
              muted={muted}
              deafened={deafened}
              onChange={onChange}
              onToggleMute={onToggleMute}
              onToggleDeafen={onToggleDeafen}
            />
          )}

          {section === 'streaming' && (
            <>
              <h2>Screen Share</h2>
              <p className="settings-note">
                Defaults for the Go Live dialog. You can change quality during a stream from the
                voice panel.
              </p>
              <div className="settings-grid">
                <Field label="Default Quality">
                  <select
                    className="text-input"
                    value={settings.screenShareProfile}
                    onChange={(e) =>
                      onChange({ screenShareProfile: e.target.value as ScreenProfileId })
                    }
                  >
                    {Object.values(SCREEN_PROFILES).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Optimize For">
                  <select
                    className="text-input"
                    value={settings.screenShareHint}
                    onChange={(e) =>
                      onChange({ screenShareHint: e.target.value as ScreenContentHint })
                    }
                  >
                    <option value="motion">Motion (games, video)</option>
                    <option value="detail">Clarity (text, code)</option>
                  </select>
                </Field>
              </div>
              <Field label="Video Codec">
                <select
                  className="text-input"
                  value={settings.screenShareCodec}
                  onChange={(e) => onChange({ screenShareCodec: e.target.value as ScreenCodec })}
                >
                  {(Object.keys(SCREEN_CODEC_LABELS) as ScreenCodec[]).map((c) => (
                    <option key={c} value={c}>
                      {SCREEN_CODEC_LABELS[c]}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="settings-note">
                Projected upload from the server at{' '}
                {SCREEN_PROFILES[settings.screenShareProfile].label}: about{' '}
                {projectedEgressMbps(SCREEN_PROFILES[settings.screenShareProfile], 1)} Mbps per
                viewer ({projectedEgressMbps(SCREEN_PROFILES[settings.screenShareProfile], 5)} Mbps
                for 5 viewers). These are encoder ceilings, not measurements.
              </p>
              <Toggle
                label="Share system audio by default"
                description="Windows only. On Windows 10 other people's voices can be captured too."
                checked={settings.screenShareAudio}
                onChange={(screenShareAudio) => onChange({ screenShareAudio })}
              />
              <Toggle
                label="Show stream stats when watching"
                checked={settings.showStreamStats}
                onChange={(showStreamStats) => onChange({ showStreamStats })}
              />
            </>
          )}

          {section === 'diagnostics' && (
            <DiagnosticsPanel session={voiceSession} state={voiceState} userName={userName} />
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
