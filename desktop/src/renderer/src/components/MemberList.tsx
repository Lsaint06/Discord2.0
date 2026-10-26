import type { Server, User } from '../types'
import Avatar from './Avatar'

interface MemberListProps {
  server: Server
  resolveUser: (id: string) => User
}

interface MemberGroup {
  id: string
  label: string
  color?: string
  users: User[]
}

function MemberList({ server, resolveUser }: MemberListProps): React.JSX.Element {
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
        <section key={group.id} className="member-group">
          <h3>
            {group.label} — {group.users.length}
          </h3>
          <ul>
            {group.users.map((user) => (
              <li
                key={user.id}
                className={`member${user.status === 'offline' ? ' offline' : ''}`}
                title={user.name}
              >
                <Avatar
                  name={user.name}
                  color={user.avatarColor}
                  size={32}
                  status={user.status}
                  ringColor="var(--bg-secondary)"
                />
                <div className="member-text">
                  <span className="member-name" style={{ color: colorFor(user.id) }}>
                    {user.name}
                    {user.bot && <span className="bot-tag">BOT</span>}
                  </span>
                  {user.activity && user.status !== 'offline' && (
                    <span className="member-activity">{user.activity}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  )
}

export default MemberList
