import type { ReactNode } from 'react'
import type { PresenceStatus } from '../types'
import type { VoiceStatus } from '../media/voiceLogic'
import type { ConnectionQualityLabel } from '../media/MediaSession'
import type { ScreenShareState } from '../media/ScreenShareController'
import { SCREEN_PROFILES, type ScreenProfileId } from '../media/screenProfiles'
import Avatar from './Avatar'
import {
  EyeIcon,
  GearIcon,
  HangUpIcon,
  HeadphonesIcon,
  MicIcon,
  ScreenShareIcon,
  SignalIcon
} from './Icons'

export interface VoiceConnection {
  channelName: string
  serverName: string
  status: VoiceStatus
  error?: string
  micError?: string
  deviceNotice?: string
  retryInMs?: number
  quality: ConnectionQualityLabel
  audioBlocked: boolean
  screenShare: ScreenShareState
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
  onShareScreen: () => void
  onStopShare: () => void
  onPreviewShare: () => void
  onChangeShareProfile: (profileId: ScreenProfileId) => void
  onDismissShareMessage: () => void
  onDismissDeviceNotice: () => void
  onStartAudio: () => void
  /** Rendered while sharing (e.g. a "limited by CPU/bandwidth" note). */
  shareStatus?: ReactNode
}

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: 'Voice Disconnected',
  connecting: 'Connecting…',
  connected: 'Voice Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Voice Disconnected',
  error: 'Voice Failed'
}

const QUALITY_TITLE: Record<ConnectionQualityLabel, string> = {
  excellent: 'Connection: excellent',
  good: 'Connection: good',
  poor: 'Connection: poor',
  lost: 'Connection: lost',
  unknown: 'Connection quality'
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
  onOpenMicSettings,
  onShareScreen,
  onStopShare,
  onPreviewShare,
  onChangeShareProfile,
  onDismissShareMessage,
  onDismissDeviceNotice,
  onStartAudio,
  shareStatus
}: UserPanelProps): React.JSX.Element {
  const micOff = muted || deafened
  const failed = voice?.status === 'error' || voice?.status === 'disconnected'
  const share = voice?.screenShare
  const sharing = share?.status === 'live' || share?.status === 'starting'

  return (
    <div className="user-panel-wrap">
      {voice && (
        <div className="voice-panel">
          <div className="voice-panel-row">
            <div className="voice-panel-info">
              <div
                className={`voice-panel-status ${voice.status} quality-${voice.quality}`}
                role="status"
                title={voice.status === 'connected' ? QUALITY_TITLE[voice.quality] : undefined}
              >
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

          {voice.status === 'connected' && share && (
            <div className="voice-panel-share">
              {sharing ? (
                <>
                  <div className="share-live-row">
                    <span className="live-badge">{share.status === 'starting' ? '…' : 'LIVE'}</span>
                    <span className="share-source" title={share.sourceName}>
                      {share.status === 'starting' ? 'Starting stream…' : share.sourceName}
                    </span>
                    {share.status === 'live' && (
                      <button
                        type="button"
                        className="icon-button small"
                        onClick={onPreviewShare}
                        aria-label="Preview your stream"
                        title="Preview your stream"
                      >
                        <EyeIcon size={16} />
                      </button>
                    )}
                  </div>
                  {share.status === 'live' && share.options && (
                    <select
                      className="text-input compact"
                      value={share.options.profileId}
                      onChange={(e) => onChangeShareProfile(e.target.value as ScreenProfileId)}
                      aria-label="Stream quality"
                    >
                      {Object.values(SCREEN_PROFILES).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button type="button" className="button danger small" onClick={onStopShare}>
                    <ScreenShareIcon size={16} slashed />
                    Stop Streaming
                  </button>
                </>
              ) : (
                <button type="button" className="button secondary small" onClick={onShareScreen}>
                  <ScreenShareIcon size={16} />
                  Share Screen
                </button>
              )}
            </div>
          )}

          {share?.status === 'live' && shareStatus}
          {share?.status === 'live' && share.audio === 'live' && !share.audioEchoProtected && (
            <div className="voice-panel-message warn">
              System audio may include other people&rsquo;s voices on this version of Windows. Use
              headphones.
            </div>
          )}
          {share?.status === 'live' &&
            (share.audio === 'failed' || share.audio === 'unavailable') && (
              <div className="voice-panel-message warn">
                {share.audio === 'failed'
                  ? 'System audio could not be shared; streaming video only.'
                  : 'No system audio was captured; streaming video only.'}
              </div>
            )}
          {share && (share.error || share.notice) && share.status !== 'live' && (
            <div className={`voice-panel-message${share.error ? ' error' : ''}`}>
              <span>{share.error ?? share.notice}</span>
              <button type="button" className="link-button" onClick={onDismissShareMessage}>
                Dismiss
              </button>
            </div>
          )}
          {voice.audioBlocked && voice.status === 'connected' && (
            <div className="voice-panel-message warn">
              <span>Audio playback is paused.</span>
              <button type="button" className="link-button" onClick={onStartAudio}>
                Enable audio
              </button>
            </div>
          )}
          {voice.deviceNotice && (
            <div className="voice-panel-message">
              <span>{voice.deviceNotice}</span>
              <button type="button" className="link-button" onClick={onDismissDeviceNotice}>
                OK
              </button>
            </div>
          )}

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
