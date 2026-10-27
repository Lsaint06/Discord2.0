import { useEffect, useRef } from 'react'
import type { SelectableStatus } from '../../types'
import type { ApiCustomStatus } from '../../net/protocol'
import { presenceFromSetting, statusLabels } from '../../lib/format'
import { CustomStatusText } from './ProfileCard'

const OPTIONS: { status: SelectableStatus; description?: string }[] = [
  { status: 'online' },
  { status: 'idle' },
  { status: 'dnd', description: 'You won’t get desktop notifications.' },
  { status: 'invisible', description: 'You’ll appear offline, but have full access.' }
]

interface StatusMenuProps {
  current: SelectableStatus
  customStatus: ApiCustomStatus | null
  onSelect: (status: SelectableStatus) => void
  onEditCustomStatus: () => void
  onClearCustomStatus: () => void
  onViewProfile: () => void
  onEditProfile: () => void
  onClose: () => void
}

/** Menu above the user panel: presence, custom status and profile shortcuts. */
function StatusMenu({
  current,
  customStatus,
  onSelect,
  onEditCustomStatus,
  onClearCustomStatus,
  onViewProfile,
  onEditProfile,
  onClose
}: StatusMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current
      ?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
      ?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
      next?.focus()
      e.preventDefault()
    }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown)
      previous?.focus?.()
    }
  }, [onClose])

  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }

  return (
    <div ref={ref} className="status-menu" role="menu" aria-label="Status">
      <button
        type="button"
        role="menuitem"
        className="status-menu-item custom"
        onClick={act(onEditCustomStatus)}
      >
        {customStatus ? (
          <CustomStatusText status={customStatus} />
        ) : (
          <span>😀 Set a custom status</span>
        )}
      </button>
      {customStatus && (
        <button
          type="button"
          role="menuitem"
          className="status-menu-item subtle"
          onClick={act(onClearCustomStatus)}
        >
          Clear custom status
        </button>
      )}
      <div className="status-menu-separator" />
      {OPTIONS.map(({ status, description }) => (
        <button
          key={status}
          type="button"
          role="menuitemradio"
          aria-checked={current === status}
          className={`status-menu-item${current === status ? ' selected' : ''}`}
          onClick={act(() => onSelect(status))}
        >
          <span
            className={`status-dot inline status-${presenceFromSetting(status)}`}
            aria-hidden="true"
          />
          <span className="status-menu-text">
            <span>{statusLabels[status]}</span>
            {description && <span className="status-menu-description">{description}</span>}
          </span>
        </button>
      ))}
      <div className="status-menu-separator" />
      <button
        type="button"
        role="menuitem"
        className="status-menu-item"
        onClick={act(onViewProfile)}
      >
        View Profile
      </button>
      <button
        type="button"
        role="menuitem"
        className="status-menu-item"
        onClick={act(onEditProfile)}
      >
        Edit Profile
      </button>
    </div>
  )
}

export default StatusMenu
