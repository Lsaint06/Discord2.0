import { useState, type ReactNode } from 'react'
import type { PresenceStatus, SelectableStatus } from '../types'
import type { ApiCustomStatus, AvatarDecorationId } from '../net/protocol'
import { statusLabels } from '../lib/format'
import StatusMenu from './profile/StatusMenu'
import { CustomStatusText } from './profile/ProfileCard'
import type { VoiceStatus } from '../media/voiceLogic'
import type { ConnectionQualityLabel } from '../media/MediaSession'
import type { ScreenShareState } from '../media/ScreenShareController'
import { SCREEN_PROFILES, type ScreenProfileId } from '../media/screenProfiles'
import Avatar from './Avatar'
import { gradeConnection, type ConnectionSummary } from '../media/connectionStats'
import type { CameraState } from '../media/CameraController'
import CameraButton, { type CameraAvailability } from './video/CameraButton'
import {
  EyeIcon,
  GearIcon,
  GridIcon,
  HangUpIcon,
  HeadphonesIcon,
  MicIcon,
  OverlayIcon,
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
  /** Measured telemetry (null until the first sample; never estimated). */
  stats?: ConnectionSummary | null
  detailsOpen?: boolean
  onToggleDetails?: () => void
  audioBlocked: boolean
  screenShare: ScreenShareState
  /** Present in push-to-talk mode. */
  pushToTalk?: { keyLabel: string; active: boolean; global: boolean; error?: string }
}

interface UserPanelProps {
  displayName: string
  avatarColor: string
  avatarId?: string | null
  /** Milestone 14: your decoration and whether your picture is animated. */
  decoration?: AvatarDecorationId | null
  avatarAnimated?: boolean
  /** Presence shown on your avatar (from your chosen status). */
  status: PresenceStatus
  statusPreference: SelectableStatus
  customStatus: ApiCustomStatus | null
  onSetStatus: (status: SelectableStatus) => void
  onEditCustomStatus: () => void
  onClearCustomStatus: () => void
  onViewProfile: () => void
  onEditProfile: () => void
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
  /** Milestone 14: the soundboard (shown while connected to voice). */
  soundboard?: ReactNode
  /** Milestone 14.5: your camera and the video view / overlay quick controls. */
  video?: {
    camera: CameraState
    availability: CameraAvailability
    cameraCount: number
    stageOpen: boolean
    overlayEnabled: boolean
    onToggleCamera: () => void
    onDismissCamera: () => void
    onOpenView: () => void
    onToggleOverlay: () => void
  }
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

const UNAVAILABLE = 'Unavailable'
const fmt = (value: number | undefined, unit: string): string =>
  value === undefined ? UNAVAILABLE : `${value} ${unit}`

function transportLabel(stats: ConnectionSummary | null | undefined): string {
  const t = stats?.transport
  if (!t?.protocol) return UNAVAILABLE
  const relayed = t.candidateType === 'relay' ? ', relayed' : ''
  return t.protocol === 'tcp' ? `TCP (UDP blocked)${relayed}` : `UDP${relayed}`
}

/** Expandable, measured details of the voice connection. */
function ConnectionDetails({
  id,
  stats,
  quality
}: {
  id: string
  stats: ConnectionSummary | null | undefined
  quality: ConnectionQualityLabel
}): React.JSX.Element {
  return (
    <div className="voice-connection-details" id={id}>
      <dl>
        <dt>Round trip</dt>
        <dd>{fmt(stats?.rttMs, 'ms')}</dd>
        <dt>Jitter</dt>
        <dd>{fmt(stats?.jitterMs, 'ms')}</dd>
        <dt>Packet loss ↑</dt>
        <dd>{fmt(stats?.uploadLossPct, '%')}</dd>
        <dt>Packet loss ↓</dt>
        <dd>{fmt(stats?.downloadLossPct, '%')}</dd>
        <dt>Sending</dt>
        <dd>{fmt(stats?.sendKbps, 'kbit/s')}</dd>
        <dt>Receiving</dt>
        <dd>{fmt(stats?.receiveKbps, 'kbit/s')}</dd>
        <dt>Path</dt>
        <dd>{transportLabel(stats)}</dd>
        <dt>Server estimate</dt>
        <dd>{quality === 'unknown' ? UNAVAILABLE : quality}</dd>
      </dl>
      <p className="voice-connection-note">
        Measured from your voice connection. Values appear after a few seconds; “Unavailable” means
        there was nothing to measure (for example, your microphone is muted and nobody else is
        talking).
      </p>
    </div>
  )
}

function UserPanel({
  displayName,
  avatarColor,
  avatarId,
  decoration,
  avatarAnimated,
  status,
  statusPreference,
  customStatus,
  onSetStatus,
  onEditCustomStatus,
  onClearCustomStatus,
  onViewProfile,
  onEditProfile,
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
  shareStatus,
  soundboard,
  video
}: UserPanelProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
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
              {voice.status === 'connected' && voice.onToggleDetails ? (
                <button
                  type="button"
                  className={`voice-panel-status ${voice.status} quality-${voice.quality} grade-${gradeConnection(voice.stats ?? {})} as-button`}
                  aria-expanded={voice.detailsOpen === true}
                  aria-controls="voice-connection-details"
                  title={`${QUALITY_TITLE[voice.quality]}. Show connection details.`}
                  onClick={voice.onToggleDetails}
                >
                  <SignalIcon size={16} />
                  <span role="status">
                    {STATUS_LABEL[voice.status]}
                    {voice.stats?.rttMs !== undefined && (
                      <span className="voice-panel-ping"> · {voice.stats.rttMs} ms</span>
                    )}
                  </span>
                </button>
              ) : (
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
              )}
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

          {voice.status === 'connected' && voice.detailsOpen && (
            <ConnectionDetails
              id="voice-connection-details"
              stats={voice.stats}
              quality={voice.quality}
            />
          )}

          {voice.status === 'connected' && video && (
            <div className="voice-panel-video">
              <CameraButton
                camera={video.camera}
                availability={video.availability}
                onToggle={video.onToggleCamera}
              />
              <button
                type="button"
                className={`icon-button small${video.stageOpen ? ' on' : ''}`}
                onClick={video.onOpenView}
                aria-label={`Open video view${video.cameraCount > 0 ? ` (${video.cameraCount} camera${video.cameraCount === 1 ? '' : 's'} on)` : ''}`}
                title="Video view"
              >
                <GridIcon size={16} />
                {video.cameraCount > 0 && (
                  <span className="voice-panel-count">{video.cameraCount}</span>
                )}
              </button>
              <button
                type="button"
                className={`icon-button small${video.overlayEnabled ? ' on' : ''}`}
                onClick={video.onToggleOverlay}
                aria-pressed={video.overlayEnabled}
                aria-label={
                  video.overlayEnabled ? 'Turn off camera overlay' : 'Turn on camera overlay'
                }
                title={
                  video.overlayEnabled
                    ? 'Camera overlay on — click to turn off'
                    : 'Camera overlay off'
                }
              >
                <OverlayIcon size={16} slashed={!video.overlayEnabled} />
              </button>
            </div>
          )}
          {video && (video.camera.error || video.camera.notice) && (
            <div className={`voice-panel-message${video.camera.error ? ' error' : ''}`}>
              <span>{video.camera.error ?? video.camera.notice}</span>
              <button type="button" className="link-button" onClick={video.onDismissCamera}>
                Dismiss
              </button>
            </div>
          )}

          {voice.status === 'connected' && share && (
            <div className="voice-panel-share">
              {sharing ? (
                <>
                  <div className="share-live-row">
                    <span className={`live-badge${share.status === 'starting' ? ' starting' : ''}`}>
                      {share.status === 'starting' ? '…' : 'LIVE'}
                    </span>
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

          {voice.status === 'connected' && soundboard}

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
        <button
          type="button"
          className={`user-panel-identity${menuOpen ? ' open' : ''}`}
          onClick={() => setMenuOpen((v) => !v)}
          // The menu closes on outside clicks; this button toggles it instead.
          onMouseDown={(e) => e.stopPropagation()}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Set status"
        >
          <Avatar
            name={displayName}
            color={avatarColor}
            imageId={avatarId}
            size={34}
            status={status}
            ringColor="var(--bg-panel)"
            decoration={decoration}
            animatedImage={avatarAnimated}
          />
          <span className="user-panel-names">
            <span className="user-panel-name">{displayName}</span>
            <span className="user-panel-status">
              {customStatus ? (
                <CustomStatusText status={customStatus} />
              ) : (
                statusLabels[statusPreference]
              )}
            </span>
          </span>
        </button>
        {menuOpen && (
          <StatusMenu
            current={statusPreference}
            customStatus={customStatus}
            onSelect={onSetStatus}
            onEditCustomStatus={onEditCustomStatus}
            onClearCustomStatus={onClearCustomStatus}
            onViewProfile={onViewProfile}
            onEditProfile={onEditProfile}
            onClose={() => setMenuOpen(false)}
          />
        )}

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
