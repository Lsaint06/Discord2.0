import { useId, useMemo, useState } from 'react'
import { useDialog } from '../hooks/useDialog'
import { rankSwitchItems, type SwitchItem } from '../lib/quickSwitch'

interface QuickSwitcherProps {
  items: SwitchItem[]
  recent: readonly string[]
  onSelect: (item: SwitchItem) => void
  onClose: () => void
}

const KIND_MARK: Record<SwitchItem['kind'], string> = {
  text: '#',
  voice: '🔊',
  dm: '@',
  group: '👥',
  server: '★'
}
const KIND_LABEL: Record<SwitchItem['kind'], string> = {
  text: 'Text channel',
  voice: 'Voice channel',
  dm: 'Direct message',
  group: 'Group',
  server: 'Server'
}

/**
 * Ctrl+K: jump to any server, channel or conversation by typing part of its name.
 * Arrow keys move, Enter opens, Escape closes. Prefix with # (text), ! (voice), @ (people)
 * or * (servers) to narrow the results.
 */
function QuickSwitcher({
  items,
  recent,
  onSelect,
  onClose
}: QuickSwitcherProps): React.JSX.Element {
  const dialogRef = useDialog<HTMLDivElement>({ onClose })
  const ids = useId()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const results = useMemo(() => rankSwitchItems(items, query, { recent }), [items, query, recent])
  const index = Math.min(active, Math.max(0, results.length - 1))
  const choose = (item: SwitchItem | undefined): void => {
    if (item) onSelect(item)
  }

  return (
    <div className="modal-backdrop quick-switcher-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal quick-switcher"
        role="dialog"
        aria-modal="true"
        aria-label="Quick switcher"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          className="text-input quick-switcher-input"
          type="text"
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={`${ids}-list`}
          aria-autocomplete="list"
          aria-activedescendant={results.length ? `${ids}-opt-${index}` : undefined}
          aria-describedby={`${ids}-hint`}
          placeholder="Where would you like to go?"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) =>
                results.length ? (Math.min(i, results.length - 1) + 1) % results.length : 0
              )
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) =>
                results.length
                  ? (Math.min(i, results.length - 1) - 1 + results.length) % results.length
                  : 0
              )
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(results[index])
            }
          }}
        />
        <ul
          id={`${ids}-list`}
          className="quick-switcher-results"
          role="listbox"
          aria-label="Results"
        >
          {results.map((item, i) => (
            <li
              key={item.id}
              id={`${ids}-opt-${i}`}
              role="option"
              aria-selected={i === index}
              className={`quick-switcher-item${i === index ? ' active' : ''}`}
              onMouseMove={() => i !== index && setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(item)
              }}
            >
              <span className={`quick-switcher-mark ${item.kind}`} aria-hidden="true">
                {KIND_MARK[item.kind]}
              </span>
              <span className="quick-switcher-name">{item.name}</span>
              {item.unread && <span className="quick-switcher-unread">unread</span>}
              <span className="quick-switcher-context">
                <span className="sr-only">{KIND_LABEL[item.kind]}, </span>
                {item.context}
              </span>
            </li>
          ))}
          {results.length === 0 && (
            <li className="quick-switcher-empty" role="presentation">
              {query.trim() ? 'Nothing matches that name.' : 'Type to search.'}
            </li>
          )}
        </ul>
        <p id={`${ids}-hint`} className="quick-switcher-hint">
          Tip: start with <kbd>#</kbd> for text channels, <kbd>!</kbd> voice, <kbd>@</kbd> people,{' '}
          <kbd>*</kbd> servers. <kbd>↑</kbd>
          <kbd>↓</kbd> to move, <kbd>Enter</kbd> to open.
        </p>
      </div>
    </div>
  )
}

export default QuickSwitcher
