import { useState } from 'react'
import type { Server } from '../types'
import { initials } from '../lib/format'
import { useServerIcon } from '../lib/profileMedia'
import { LogoIcon, PlusIcon } from './Icons'

/** The server's picture if it has one (and it loaded), otherwise its initials. */
export function ServerGlyph({
  server,
  size = 'small'
}: {
  server: Pick<Server, 'name' | 'iconId'>
  size?: 'small' | 'full'
}): React.JSX.Element {
  const { url } = useServerIcon(server.iconId, size)
  if (url) return <img className="server-icon-image" src={url} alt="" draggable={false} />
  return <>{initials(server.name)}</>
}

interface ServerSidebarProps {
  servers: Server[]
  /** The server on screen; null while Home (friends and conversations) is open. */
  activeServerId: string | null
  homeActive: boolean
  /** Pending friend requests + unread conversation messages. */
  homeBadge: number
  onSelectHome: () => void
  unreadServerIds: Set<string>
  /** Unread mentions of you per server (red badge on the icon). */
  mentionsByServer?: Record<string, number>
  onSelectServer: (id: string) => void
  onAddServer: () => void
}

interface Tooltip {
  label: string
  top: number
}

function ServerSidebar({
  servers,
  activeServerId,
  homeActive,
  homeBadge,
  onSelectHome,
  unreadServerIds,
  mentionsByServer,
  onSelectServer,
  onAddServer
}: ServerSidebarProps): React.JSX.Element {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null)

  const showTooltip = (label: string) => (event: React.SyntheticEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setTooltip({ label, top: rect.top + rect.height / 2 })
  }
  const hideTooltip = (): void => setTooltip(null)

  return (
    <nav className="server-sidebar" aria-label="Servers">
      <div
        className={`server-item brand${homeActive ? ' active' : ''}${homeBadge > 0 && !homeActive ? ' unread' : ''}`}
      >
        <span className="server-pill" />
        <button
          type="button"
          className="server-icon brand-icon"
          onClick={onSelectHome}
          onMouseEnter={showTooltip('Direct Messages')}
          onMouseLeave={hideTooltip}
          onFocus={showTooltip('Direct Messages')}
          onBlur={hideTooltip}
          aria-label={
            homeBadge > 0 ? `Direct Messages, ${homeBadge} notifications` : 'Direct Messages'
          }
          aria-current={homeActive ? 'page' : undefined}
        >
          <LogoIcon size={28} />
        </button>
        {homeBadge > 0 && (
          <span className="server-badge" aria-hidden="true">
            {homeBadge >= 99 ? '99+' : homeBadge}
          </span>
        )}
      </div>
      <div className="server-separator" />

      <div className="server-list">
        {servers.map((server) => {
          const active = server.id === activeServerId
          const unread = !active && unreadServerIds.has(server.id)
          const mentions = active ? 0 : (mentionsByServer?.[server.id] ?? 0)
          return (
            <div
              key={server.id}
              className={`server-item${active ? ' active' : ''}${unread ? ' unread' : ''}`}
            >
              <span className="server-pill" />
              <button
                type="button"
                className="server-icon"
                style={{ '--server-color': server.color } as React.CSSProperties}
                onClick={() => onSelectServer(server.id)}
                onMouseEnter={showTooltip(server.name)}
                onMouseLeave={hideTooltip}
                onFocus={showTooltip(server.name)}
                onBlur={hideTooltip}
                aria-label={
                  mentions > 0
                    ? `${server.name}, ${mentions} unread mention${mentions === 1 ? '' : 's'}`
                    : server.name
                }
                aria-current={active ? 'page' : undefined}
              >
                <ServerGlyph server={server} />
              </button>
              {mentions > 0 && (
                <span className="server-badge" aria-hidden="true">
                  {mentions >= 99 ? '99+' : mentions}
                </span>
              )}
            </div>
          )
        })}

        <div className="server-item">
          <span className="server-pill" />
          <button
            type="button"
            className="server-icon add-server"
            onClick={onAddServer}
            onMouseEnter={showTooltip('Add a Server')}
            onMouseLeave={hideTooltip}
            onFocus={showTooltip('Add a Server')}
            onBlur={hideTooltip}
            aria-label="Add a Server"
          >
            <PlusIcon size={22} />
          </button>
        </div>
      </div>

      {tooltip && (
        <div className="server-tooltip" style={{ top: tooltip.top }} role="tooltip">
          {tooltip.label}
        </div>
      )}
    </nav>
  )
}

export default ServerSidebar
