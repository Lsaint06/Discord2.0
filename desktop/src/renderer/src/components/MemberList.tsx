import type { Server, User } from '../types'
import Avatar from './Avatar'
import { StyledName } from './profile/ProfileCard'
import { decorationOf } from '../lib/profileStyle'
import { CustomStatusText } from './profile/ProfileCard'

interface MemberListProps {
  server: Server
  resolveUser: (id: string) => User
  onOpenProfile: (userId: string, anchor: DOMRect) => void
}

interface MemberGroup {
  id: string
  label: string
  color?: string
  users: User[]
}

function MemberList({ server, resolveUser, onOpenProfile }: MemberListProps): React.JSX.Element {
  const byName = (a: User, b: User): number => a.name.localeCompare(b.name)
  const roleOf = new Map(server.members.map((m) => [m.userId, m.roleId]))
  const members = server.members.map((m) => resolveUser(m.userId))
  const online = members.filter((u) => u.status !== 'offline')

  const groups: MemberGroup[] = [
    ...server.roles.map((role) => ({
      id: role.id,
      label: role.name,
      color: role.color,
      users: online.filter((u) => roleOf.get(u.id) === role.id).sort(byName)
    })),
    {
      id: 'online',
      label: 'Online',
      users: online.filter((u) => !roleOf.get(u.id)).sort(byName)
    },
    {
      id: 'offline',
      label: 'Offline',
      users: members.filter((u) => u.status === 'offline').sort(byName)
    }
  ].filter((g) => g.users.length > 0)

  const colorFor = (userId: string): string | undefined => {
    const roleId = roleOf.get(userId)
    return server.roles.find((r) => r.id === roleId)?.color
  }

  return (
    <aside className="member-list" aria-label="Members">
      {groups.map((group) => (
        <section key={group.id} className="member-group" aria-label={group.label}>
          <h3>
            {group.label} — {group.users.length}
          </h3>
          <ul>
            {group.users.map((user) => (
              <li key={user.id}>
                <button
                  type="button"
                  className={`member${user.status === 'offline' ? ' offline' : ''}`}
                  onClick={(e) => onOpenProfile(user.id, e.currentTarget.getBoundingClientRect())}
                  aria-haspopup="dialog"
                >
                  <Avatar
                    name={user.name}
                    color={user.avatarColor}
                    imageId={user.avatarId}
                    size={32}
                    status={user.status}
                    ringColor="var(--bg-secondary)"
                    decoration={decorationOf(user.profileStyle)}
                    animatedImage={user.avatarAnimated}
                  />
                  <span className="member-text">
                    <span className="member-name" style={{ color: colorFor(user.id) }}>
                      <StyledName user={user}>{user.name}</StyledName>
                      {user.bot && <span className="bot-tag">BOT</span>}
                    </span>
                    {user.status !== 'offline' && (
                      <CustomStatusText status={user.customStatus} className="member-activity" />
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  )
}

export default MemberList
