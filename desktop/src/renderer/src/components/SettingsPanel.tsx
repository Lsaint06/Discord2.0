import { useState } from 'react'
import { useDialog } from '../hooks/useDialog'
import type { SelectableStatus, User, UserSettings } from '../types'
import { defaultSettings } from '../data/defaults'
import { formatMemberSince, presenceFromSetting, statusLabels } from '../lib/format'
import { describeStatusExpiry } from '../lib/appearance'
import type { MediaSession, MediaSnapshot } from '../media/MediaSession'
import {
  projectedEgressMbps,
  SCREEN_CODEC_LABELS,
  SCREEN_MODE_LABELS,
  SCREEN_PROFILES,
  type ScreenCodec,
  type ScreenContentHint,
  type ScreenLayering,
  type ScreenProfileId
} from '../media/screenProfiles'
import { CloseIcon } from './Icons'
import { Field, Toggle } from './SettingsControls'
import VoiceSettings from './VoiceSettings'
import DiagnosticsPanel from './DiagnosticsPanel'
import { AdminSection, DevicesSection, SecuritySection } from './manage/AccountSections'
import type { ApiClient, PreferencesPatch, ProfilePatch } from '../net/api'
import type {
  ApiMe,
  ApiPreferences,
  ApiServer,
  AppThemeId,
  ProfileImageKind
} from '../net/protocol'
import ProfileSettings from './profile/ProfileSettings'
import AppearanceSettings from './profile/AppearanceSettings'
import ProfileCard, { CustomStatusText } from './profile/ProfileCard'
import EncoderSettings from './EncoderSettings'
import SoundSettings from './SoundSettings'
import KeybindSettings from './KeybindSettings'
import { parseKeybinds, type CommandId } from '../lib/keybinds'
import type { ServerNotificationChoice } from '../chat/unread'
import PrivacySettings, { type PrivacyProps } from './PrivacySettings'
import WindowsSettings from './WindowsSettings'

export type SectionId =
  | 'account'
  | 'profile'
  | 'security'
  | 'devices'
  | 'privacy'
  | 'admin'
  | 'appearance'
  | 'voice'
  | 'streaming'
  | 'notifications'
  | 'sounds'
  | 'keybinds'
  | 'diagnostics'

const sections: { id: SectionId; label: string; adminOnly?: boolean }[] = [
  { id: 'account', label: 'My Account' },
  { id: 'profile', label: 'Profile' },
  { id: 'security', label: 'Security' },
  { id: 'devices', label: 'Devices' },
  { id: 'privacy', label: 'Privacy & Safety' },
  { id: 'admin', label: 'Administration', adminOnly: true },
  { id: 'appearance', label: 'Appearance' },
  { id: 'voice', label: 'Voice & Audio' },
  { id: 'streaming', label: 'Screen Share' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'sounds', label: 'Sounds' },
  { id: 'keybinds', label: 'Keybinds' },
  { id: 'diagnostics', label: 'Diagnostics' }
]

const statusOptions: SelectableStatus[] = ['online', 'idle', 'dnd', 'invisible']

interface SettingsPanelProps {
  settings: UserSettings
  voiceSession: MediaSession
  voiceState: MediaSnapshot
  userName: (userId: string) => string
  username: string
  serverUrl: string
  muted: boolean
  deafened: boolean
  /** Section to open first (e.g. 'profile' from "Edit Profile"). */
  initialSection?: SectionId
  onChange: (patch: Partial<UserSettings>) => void
  preferences: ApiPreferences
  preferencesLoaded: boolean
  onPreferencesChange: (patch: PreferencesPatch) => Promise<string | null>
  onProfileSave: (patch: ProfilePatch) => Promise<string | null>
  onProfileImageUpload: (
    kind: ProfileImageKind,
    image: Blob,
    onProgress: (fraction: number) => void,
    crop?: { left: number; top: number; width: number; height: number }
  ) => Promise<string | null>
  onProfileImageRemove: (kind: ProfileImageKind) => Promise<string | null>
  onSetStatus: (status: SelectableStatus) => void
  onEditCustomStatus: () => void
  onLogout: () => void
  api: ApiClient
  me: ApiMe | null
  servers: ApiServer[]
  /** Session already revoked on the server (sign out everywhere): just leave. */
  onSignedOutEverywhere: () => void
  onToggleMute: () => void
  onToggleDeafen: () => void
  onClose: () => void
  privacy: PrivacyProps
  /** Whether each system-wide shortcut could be registered (Keybinds). */
  shortcutStatus?: Partial<Record<CommandId, boolean>>
  /** Milestone 14: themes and profile customization. */
  customization: CustomizationProps
}

export interface CustomizationProps {
  /** The server stores profile styles, animated images and the synced theme (API 6). */
  supported: boolean
  appTheme: AppThemeId | null
  onAppThemeChange: (id: AppThemeId | null) => Promise<string | null>
  /** Show a theme everywhere without saving it (undefined = stop previewing). */
  onPreviewTheme: (id: AppThemeId | null | undefined) => void
}

function SettingsPanel({
  settings,
  voiceSession,
  voiceState,
  userName,
  username,
  serverUrl,
  muted,
  deafened,
  initialSection = 'account',
  onChange,
  preferences,
  preferencesLoaded,
  onPreferencesChange,
  onProfileSave,
  onProfileImageUpload,
  onProfileImageRemove,
  onSetStatus,
  onEditCustomStatus,
  onLogout,
  api,
  me,
  servers,
  onSignedOutEverywhere,
  onToggleMute,
  onToggleDeafen,
  onClose,
  privacy,
  shortcutStatus = {},
  customization
}: SettingsPanelProps): React.JSX.Element {
  const [section, setSection] = useState<SectionId>(initialSection)
  const [now] = useState(() => Date.now())

  const dialogRef = useDialog<HTMLDivElement>({ onClose })

  const statusPreference = me?.statusPreference ?? 'online'
  const self: User | null = me
    ? {
        id: me.id,
        name: me.displayName,
        username: me.username,
        avatarColor: me.avatarColor,
        status: presenceFromSetting(statusPreference),
        avatarId: me.avatarId,
        bannerId: me.bannerId,
        accentColor: me.accentColor,
        bio: me.bio,
        pronouns: me.pronouns,
        createdAt: me.createdAt,
        customStatus: me.ownCustomStatus
      }
    : null

  return (
    <div
      ref={dialogRef}
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="User Settings"
    >
      <nav className="settings-nav">
        <div className="settings-nav-inner">
          <h4>User Settings</h4>
          {sections
            .filter((s) => !s.adminOnly || me?.instanceAdmin)
            .map((s) => (
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
            onClick={() => {
              if (
                window.confirm(
                  'Reset all settings on this PC to their defaults? This clears your keybinds, sound choices, notification, volume and device settings, and text size. Your account, profile and imported sounds are kept.'
                )
              )
                onChange({ ...defaultSettings })
            }}
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
              {self && me ? (
                <>
                  <div className="account-card">
                    <ProfileCard user={self} variant="preview" customStatus={me.ownCustomStatus}>
                      <div className="profile-card-actions">
                        <button
                          type="button"
                          className="button primary small"
                          onClick={() => setSection('profile')}
                        >
                          Edit User Profile
                        </button>
                      </div>
                    </ProfileCard>
                  </div>

                  <dl className="account-details">
                    <div>
                      <dt>Display Name</dt>
                      <dd>{me.displayName}</dd>
                    </div>
                    <div>
                      <dt>Username</dt>
                      <dd>
                        @{username}
                        <span className="muted"> · permanent, used to sign in</span>
                      </dd>
                    </div>
                    <div>
                      <dt>Account</dt>
                      <dd>
                        {me.hasPassword ? 'Password account' : 'Development identity (no password)'}
                        {me.instanceAdmin ? ' · Administrator' : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>Member Since</dt>
                      <dd>{formatMemberSince(me.createdAt) ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Server</dt>
                      <dd>
                        <code>{serverUrl}</code>
                      </dd>
                    </div>
                  </dl>
                  {!me.hasPassword && (
                    <div className="dev-notice">
                      <strong>Development identity</strong>
                      <span>
                        This identity has no password. See Security to claim it as a real account.
                      </span>
                    </div>
                  )}

                  <Field label="Custom Status">
                    <div className="custom-status-row">
                      {me.ownCustomStatus ? (
                        <span>
                          <CustomStatusText status={me.ownCustomStatus} />
                          {me.ownCustomStatus.expiresAt && (
                            <span className="muted">
                              {' '}
                              · {describeStatusExpiry(me.ownCustomStatus.expiresAt, now)}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="muted">No custom status</span>
                      )}
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={onEditCustomStatus}
                      >
                        {me.ownCustomStatus ? 'Edit' : 'Set Status'}
                      </button>
                    </div>
                  </Field>

                  <Field label="Online Status">
                    <div className="status-options" role="radiogroup" aria-label="Online status">
                      {statusOptions.map((status) => (
                        <label
                          key={status}
                          className={`status-option${statusPreference === status ? ' selected' : ''}`}
                        >
                          <input
                            type="radio"
                            name="status"
                            value={status}
                            checked={statusPreference === status}
                            onChange={() => onSetStatus(status)}
                          />
                          <span
                            className={`status-dot inline status-${presenceFromSetting(status)}`}
                          />
                          {statusLabels[status]}
                        </label>
                      ))}
                    </div>
                    <span className="field-hint muted">
                      Synced to all your devices. Invisible shows you as offline to everyone else.
                    </span>
                  </Field>
                </>
              ) : (
                <div className="spinner" aria-label="Loading" />
              )}
            </>
          )}

          {section === 'profile' && (
            <>
              <h2>Profile</h2>
              {me ? (
                <ProfileSettings
                  me={me}
                  onSave={onProfileSave}
                  onUpload={onProfileImageUpload}
                  onRemove={onProfileImageRemove}
                  customizationSupported={customization.supported}
                />
              ) : (
                <div className="spinner" aria-label="Loading" />
              )}
            </>
          )}

          {section === 'appearance' && (
            <AppearanceSettings
              preferences={preferences}
              loaded={preferencesLoaded}
              onChange={onPreferencesChange}
              fontSize={settings.fontSize}
              onFontSizeChange={(fontSize) => onChange({ fontSize })}
              contrast={settings.contrast}
              onContrastChange={(contrast) => onChange({ contrast })}
              appTheme={customization.appTheme}
              onAppThemeChange={customization.onAppThemeChange}
              onPreviewTheme={customization.onPreviewTheme}
              themeSynced={customization.supported}
              themeEffects={settings.themeEffects}
              onThemeEffectsChange={(themeEffects) => onChange({ themeEffects })}
              profileEffects={settings.profileEffects}
              onProfileEffectsChange={(profileEffects) => onChange({ profileEffects })}
              chatWallpaper={settings.chatWallpaper}
              chatWallpaperIntensity={settings.chatWallpaperIntensity}
              onChatWallpaperChange={(chatWallpaper) => onChange({ chatWallpaper })}
              onChatWallpaperIntensityChange={(chatWallpaperIntensity) =>
                onChange({ chatWallpaperIntensity })
              }
            />
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
                <Field label="Mode">
                  <select
                    className="text-input"
                    value={settings.screenShareHint}
                    onChange={(e) =>
                      onChange({ screenShareHint: e.target.value as ScreenContentHint })
                    }
                  >
                    {(Object.keys(SCREEN_MODE_LABELS) as ScreenContentHint[]).map((h) => (
                      <option key={h} value={h}>
                        {SCREEN_MODE_LABELS[h].label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <p className="settings-note">
                {SCREEN_MODE_LABELS[settings.screenShareHint].description}
              </p>
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
              {settings.screenShareCodec !== 'h264' && (
                <Field label="AV1 / VP9 Layering">
                  <select
                    className="text-input"
                    value={settings.screenShareLayering}
                    onChange={(e) =>
                      onChange({ screenShareLayering: e.target.value as ScreenLayering })
                    }
                  >
                    <option value="simulcast">
                      Single-layer simulcast (GPU encoder, recommended)
                    </option>
                    <option value="svc">
                      Temporal SVC L1T3 (LiveKit default, software encoder)
                    </option>
                  </select>
                </Field>
              )}
              <Toggle
                label="Send a 720p backup layer"
                description="Lets viewers on slow connections fall back to 720p30 instead of stuttering. Costs about 1.8 Mbps of extra upload."
                checked={settings.screenShareBackupLayer}
                onChange={(screenShareBackupLayer) => onChange({ screenShareBackupLayer })}
              />
              <EncoderSettings />
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

          {section === 'security' && (
            <SecuritySection api={api} me={me} onSignedOutEverywhere={onSignedOutEverywhere} />
          )}
          {section === 'devices' && <DevicesSection api={api} />}
          {section === 'privacy' && <PrivacySettings {...privacy} />}
          {section === 'admin' && me?.instanceAdmin && (
            <AdminSection api={api} servers={servers} meId={me?.id} />
          )}

          {section === 'notifications' && (
            <>
              <h2>Notifications</h2>
              <Toggle
                label="Desktop Notifications"
                description="Show a notification for new messages in channels you haven’t muted while you’re looking elsewhere."
                checked={settings.desktopNotifications}
                onChange={(desktopNotifications) => onChange({ desktopNotifications })}
              />
              <Toggle
                label="Show Message Preview"
                description="Include message text in notifications. Off by default so content isn’t shown on a shared screen."
                checked={settings.notificationPreview}
                onChange={(notificationPreview) => onChange({ notificationPreview })}
              />
              <p className="settings-note">
                Message and mention sounds are under{' '}
                <button type="button" className="link-button" onClick={() => setSection('sounds')}>
                  Sounds
                </button>
                . Windows notifications themselves are silent unless the app can&rsquo;t play its
                own sound.
              </p>
              <WindowsSettings />
              {servers.length > 0 && (
                <>
                  <h3 className="settings-subheading">Per server</h3>
                  <p className="settings-note">
                    Choose what each server notifies you about (sounds and desktop notifications).
                    Direct messages always notify you.
                  </p>
                  <ul className="server-notify-list">
                    {servers.map((s) => {
                      const serverDefault = s.defaultNotifications ?? 'all'
                      return (
                        <li key={s.id} className="server-notify-row">
                          <span className="server-notify-name">{s.name}</span>
                          <select
                            className="text-input compact"
                            aria-label={`Notifications for ${s.name}`}
                            value={settings.serverNotifications[s.id] ?? 'default'}
                            onChange={(e) => {
                              const value = e.target.value as ServerNotificationChoice
                              const next = { ...settings.serverNotifications }
                              if (value === 'default') delete next[s.id]
                              else next[s.id] = value
                              onChange({ serverNotifications: next })
                            }}
                          >
                            <option value="default">
                              Server default (
                              {serverDefault === 'mentions' ? 'only @mentions' : 'all messages'})
                            </option>
                            <option value="all">All messages</option>
                            <option value="mentions">Only @mentions</option>
                          </select>
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </>
          )}

          {section === 'sounds' && <SoundSettings settings={settings} onChange={onChange} />}
          {section === 'keybinds' && (
            <KeybindSettings
              keybinds={parseKeybinds(settings.keybinds)}
              onChange={(keybinds) => onChange({ keybinds })}
              globalStatus={shortcutStatus}
              pushToTalkKey={settings.pushToTalkKey}
              onOpenVoiceSettings={() => setSection('voice')}
            />
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
