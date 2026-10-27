import { useEffect, useRef, useState } from 'react'
import { EMOJI_CATEGORIES, searchEmoji, type EmojiEntry } from '../../chat/emoji'

interface EmojiPickerProps {
  onPick: (emoji: string) => void
  onClose: () => void
  recent: string[]
  /** Where to anchor: above the composer or next to a message. */
  placement?: 'composer' | 'message'
  label?: string
}

/** Searchable emoji grid. Escape or a click outside closes it. */
function EmojiPicker({
  onPick,
  onClose,
  recent,
  placement = 'composer',
  label = 'Emoji picker'
}: EmojiPickerProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const grid = (entries: EmojiEntry[]): React.JSX.Element => (
    <div className="emoji-grid">
      {entries.map((entry) => (
        <button
          key={entry.emoji}
          type="button"
          onClick={() => onPick(entry.emoji)}
          title={entry.keywords.split(' ')[0]}
          aria-label={entry.keywords.split(' ')[0]}
        >
          {entry.emoji}
        </button>
      ))}
    </div>
  )

  const results = query.trim() ? searchEmoji(query) : null

  return (
    <div
      ref={rootRef}
      className={`emoji-picker-panel ${placement}`}
      role="dialog"
      aria-label={label}
    >
      <input
        className="emoji-search"
        type="text"
        autoFocus
        placeholder="Find the perfect emoji"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results?.[0]) onPick(results[0].emoji)
        }}
        aria-label="Search emoji"
      />
      <div className="emoji-scroll">
        {results ? (
          results.length ? (
            grid(results)
          ) : (
            <div className="emoji-empty">No emoji found</div>
          )
        ) : (
          <>
            {recent.length > 0 && (
              <section>
                <h4>Recently used</h4>
                {grid(recent.map((emoji) => ({ emoji, keywords: emoji })))}
              </section>
            )}
            {EMOJI_CATEGORIES.map((c) => (
              <section key={c.id}>
                <h4>{c.label}</h4>
                {grid(c.emojis)}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

export default EmojiPicker
