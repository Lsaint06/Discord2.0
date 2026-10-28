import { useState } from 'react'
import type { User } from '../types'
import Avatar from './Avatar'
import { Toggle } from './SettingsControls'

export interface PrivacyProps {
  allowServerDms: boolean
  /** Resolves to an error message or null. */
  onAllowServerDmsChange: (allow: boolean) => Promise<string | null>
  blocked: User[]
  onUnblock: (userId: string) => Promise<string | null>
}

/** Who can message you, and the people you've blocked. */
function PrivacySettings(props: PrivacyProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const run = async (key: string, action: () => Promise<string | null>): Promise<void> => {
    setBusy(key)
    setError(null)
    const failure = await action()
    setBusy(null)
    if (failure) setError(failure)
  }

  return (
    <>
      <h2>Privacy &amp; Safety</h2>
      <Toggle
        label="Allow direct messages from server members"
        description="People you share a server with can start a conversation with you even if you aren’t friends. Friends can always message you. Existing conversations stay readable either way."
        checked={props.allowServerDms}
        onChange={(allow) => void run('dms', () => props.onAllowServerDmsChange(allow))}
      />
      <p className="settings-note">
        Messages are protected in transit and stored on your community&rsquo;s own server. They are
        not end-to-end encrypted: whoever runs the server can technically read them.
      </p>

      <h3 className="settings-subheading">Blocked — {props.blocked.length}</h3>
      {props.blocked.length === 0 ? (
        <p className="muted">
          You haven&rsquo;t blocked anyone. Blocking someone stops their messages and friend
          requests and hides your status from each other. They aren&rsquo;t told.
        </p>
      ) : (
        <ul className="blocked-list">
          {props.blocked.map((user) => (
            <li key={user.id} className="blocked-row">
              <Avatar name={user.name} color={user.avatarColor} imageId={user.avatarId} size={32} />
              <span className="blocked-name">
                {user.name} <span className="friend-username">{user.username}</span>
              </span>
              <button
                type="button"
                className="button secondary small"
                disabled={busy !== null}
                onClick={() => void run(user.id, () => props.onUnblock(user.id))}
              >
                {busy === user.id ? 'Unblocking…' : 'Unblock'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

export default PrivacySettings
