import type { PresenceStatus } from '../types'
import type { VoiceStatus } from '../media/voiceLogic'
import Avatar from './Avatar'
import { GearIcon, HangUpIcon, HeadphonesIcon, MicIcon, SignalIcon } from './Icons'

export interface VoiceConnection {
  channelName: string
  serverName: string
  status: VoiceStatus
  error?: string
  micError?: string
  retryInMs?: number
  /** Present in push-to-talk mode. */
  pushToTalk?: { keyLabel: string; active: boolean; global: boolean; error?: string }
}

interface UserPanelProps {
  displayName: string
  avatarColor: string
  status: PresenceStatus
  statusText: string
  muted: boolean
  deafened: boolean
  voice: VoiceConnection | null
  onToggleMute: () => void
  onToggleDeafen: () => void
  onOpenSettings: () => void
  onDisconnect: () => void
  onRetryVoice: () => void
  onOpenMicSettings?: () => void
}

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: 'Voice Disconnected',
  connecting: 'Connecting…',
  connected: 'Voice Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Voice Disconnected',
  error: 'Voice Error'
}

function UserPanel({
  displayName,
  avatarColor,
  status,
  statusText,
  muted,
  deafened,
  voice,
  onToggleMute,
  onToggleDeafen,
  onOpenSettings,
  onDisconnect,
  onRetryVoice,
  onOpenMicSettings
}: UserPanelProps): React.JSX.Element {
  const micOff = muted || deafened
  const failed = voice?.status === 'error' || voice?.status === 'disconnected'

  return (
    <div className="user-panel-wrap">
      {voice && (
        <div className="voice-panel">
          <div className="voice-panel-row">
            <div className="voice-panel-info">
              <div className={`voice-panel-status ${voice.status}`} role="status">
                <SignalIcon size={16} />
                <span>
                  {STATUS_LABEL[voice.status]}
                  {voice.status === 'reconnecting' && voice.retryInMs !== undefined
                    ? ` (${Math.max(1, Math.round(voice.retryInMs / 1000))}s)`
                    : ''}
                </span>
              </div>
              <div
                className="voice-panel-where"
                title={`${voice.channelName} / ${voice.serverName}`}
              >
                {voice.channelName} / {voice.serverName}
              </div>
            </div>
            <button
              type="button"
              className="icon-button danger"
              onClick={onDisconnect}
              aria-label={failed ? 'Dismiss' : 'Disconnect'}
              title={failed ? 'Dismiss' : 'Disconnect'}
            >
              <HangUpIcon size={20} />
            </button>
          </div>

          {voice.error && voice.status !== 'connected' && (
            <div className="voice-panel-message error">
              <span>{voice.error}</span>
              {failed && (
                <button type="button" className="link-button" onClick={onRetryVoice}>
                  Retry
                </button>
              )}
            </div>
          )}
          {voice.micError && (
            <div className="voice-panel-message error">
              <span>{voice.micError}</span>
              {onOpenMicSettings && (
                <button type="button" className="link-button" onClick={onOpenMicSettings}>
                  Open settings
                </button>
              )}
            </div>
          )}
          {voice.pushToTalk && voice.status === 'connected' && (
            <div className={`voice-panel-message ptt${voice.pushToTalk.active ? ' active' : ''}`}>
              {voice.pushToTalk.error ??
                (voice.pushToTalk.global
                  ? `Push-to-talk (toggle): ${voice.pushToTalk.keyLabel} — ${voice.pushToTalk.active ? 'talking' : 'off'}`
                  : `Push-to-talk: hold ${voice.pushToTalk.keyLabel}${voice.pushToTalk.active ? ' — talking' : ''}`)}
            </div>
          )}
        </div>
      )}

      <div className="user-panel">
        <div className="user-panel-identity">
          <Avatar
            name={displayName}
            color={avatarColor}
            size={34}
            status={status}
            ringColor="var(--bg-panel)"
          />
          <div className="user-panel-names">
            <span className="user-panel-name">{displayName}</span>
            <span className="user-panel-status">{statusText}</span>
          </div>
        </div>

        <div className="user-panel-actions">
          <button
            type="button"
            className={`icon-button${micOff ? ' off' : ''}`}
            onClick={onToggleMute}
            aria-pressed={micOff}
            aria-label={micOff ? 'Unmute' : 'Mute'}
            title={micOff ? 'Unmute' : 'Mute'}
          >
            <MicIcon size={20} slashed={micOff} />
          </button>
          <button
            type="button"
            className={`icon-button${deafened ? ' off' : ''}`}
            onClick={onToggleDeafen}
            aria-pressed={deafened}
            aria-label={deafened ? 'Undeafen' : 'Deafen'}
            title={deafened ? 'Undeafen' : 'Deafen'}
          >
            <HeadphonesIcon size={20} slashed={deafened} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onOpenSettings}
            aria-label="User Settings"
            title="User Settings"
          >
            <GearIcon size={20} />
          </button>
        </div>
      </div>
    </div>
  )
}

export default UserPanel
