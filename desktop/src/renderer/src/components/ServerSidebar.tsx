import { useState } from 'react'
import type { Server } from '../types'
import { initials } from '../lib/format'
import { LogoIcon, PlusIcon } from './Icons'

interface ServerSidebarProps {
  servers: Server[]
  activeServerId: string
  unreadServerIds: Set<string>
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
  unreadServerIds,
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
        className="server-item brand"
        onMouseEnter={showTooltip('Discord 2.0')}
        onMouseLeave={hideTooltip}
      >
        <div className="server-icon brand-icon">
          <LogoIcon size={28} />
        </div>
      </div>
      <div className="server-separator" />

      <div className="server-list">
        {servers.map((server) => {
          const active = server.id === activeServerId
          const unread = !active && unreadServerIds.has(server.id)
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
                aria-label={server.name}
                aria-current={active ? 'page' : undefined}
              >
                {initials(server.name)}
              </button>
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
