import type { PresenceStatus } from '../types'
import Avatar from './Avatar'
import { GearIcon, HangUpIcon, HeadphonesIcon, MicIcon, SignalIcon } from './Icons'

interface VoiceConnection {
  channelName: string
  serverName: string
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
  onDisconnect
}: UserPanelProps): React.JSX.Element {
  const micOff = muted || deafened

  return (
    <div className="user-panel-wrap">
      {voice && (
        <div className="voice-panel">
          <div className="voice-panel-info">
            <div className="voice-panel-status">
              <SignalIcon size={16} />
              <span>Voice Connected</span>
            </div>
            <div className="voice-panel-where" title={`${voice.channelName} / ${voice.serverName}`}>
              {voice.channelName} / {voice.serverName}
            </div>
          </div>
          <button
            type="button"
            className="icon-button danger"
            onClick={onDisconnect}
            aria-label="Disconnect"
            title="Disconnect"
          >
            <HangUpIcon size={20} />
          </button>
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
