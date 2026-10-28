import { useContext, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../net/api'
import { ApiError } from '../../net/api'
import type { ApiGif, ApiGifPage } from '../../net/protocol'
import { useGifMedia } from '../../lib/profileMedia'
import { GifContext, ReducedMotionContext } from '../../chat/gifContext'

const SEARCH_DELAY_MS = 350
const COLUMNS = 3

function describe(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Something went wrong.'
  if (err.code === 'gifs_busy' || err.status === 429) {
    return 'GIF search is resting for a moment. Try again soon.'
  }
  if (err.code === 'gifs_disabled') return 'GIFs aren’t set up on this server.'
  if (err.isNetwork) return 'Can’t reach the server.'
  return 'The GIF service isn’t answering right now.'
}

interface GifPickerProps {
  api: ApiClient
  onPick: (gif: ApiGif) => void
  onClose: () => void
  /** After Escape closed it (e.g. focus goes back to the message box). */
  onEscape?: () => void
}

function GifTile({
  gif,
  reduced,
  tabIndex,
  onPick,
  onKeyDown,
  buttonRef
}: {
  gif: ApiGif
  reduced: boolean
  tabIndex: number
  onPick: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  buttonRef: (el: HTMLButtonElement | null) => void
}): React.JSX.Element {
  const [hover, setHover] = useState(false)
  // Under reduced motion the grid shows still frames; hovering or focusing plays one.
  const { url } = useGifMedia(gif.id, reduced && !hover ? 'still' : 'preview')
  return (
    <button
      ref={buttonRef}
      type="button"
      className="gif-tile"
      tabIndex={tabIndex}
      style={{ aspectRatio: `${gif.width} / ${gif.height}` }}
      onClick={onPick}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      aria-label={gif.title || 'GIF'}
      title={gif.title || undefined}
    >
      {url ? <img src={url} alt="" draggable={false} /> : <span className="gif-tile-loading" />}
    </button>
  )
}

/** Searchable GIF grid (trending when empty). Escape or a click outside closes it. */
function GifPicker({ api, onPick, onClose, onEscape }: GifPickerProps): React.JSX.Element {
  const support = useContext(GifContext)
  const reduced = useContext(ReducedMotionContext)
  const [query, setQuery] = useState('')
  const [term, setTerm] = useState('')
  const [page, setPage] = useState<{ term: string; items: ApiGif[]; next: number | null } | null>(
    null
  )
  const [error, setError] = useState<{ term: string; text: string } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const tiles = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    // Its own toggle button handles open/close (closing here on mousedown would reopen it).
    const outside = (target: EventTarget | null): boolean =>
      !!rootRef.current &&
      target instanceof Node &&
      !rootRef.current.contains(target) &&
      !(target instanceof Element && target.closest('[data-picker-toggle]'))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        onEscape?.()
      }
    }
    const onDown = (e: MouseEvent): void => {
      if (outside(e.target)) onClose()
    }
    // Keyboard focus moving elsewhere (Tab) closes it too, like a menu.
    const onFocus = (e: FocusEvent): void => {
      if (outside(e.target)) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown)
    document.addEventListener('focusin', onFocus)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown)
      document.removeEventListener('focusin', onFocus)
    }
  }, [onClose, onEscape])

  // Debounced search; an empty box shows trending.
  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), query.trim() ? SEARCH_DELAY_MS : 0)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    let cancelled = false
    const request: Promise<ApiGifPage> = term ? api.gifSearch(term) : api.gifTrending()
    request.then(
      (result) => {
        if (cancelled) return
        setPage({ term, items: result.items, next: result.next })
        setError(null)
        setActive(0)
      },
      (err: unknown) => !cancelled && setError({ term, text: describe(err) })
    )
    return () => {
      cancelled = true
    }
  }, [api, term])

  const current = page && page.term === term ? page : null
  const currentError = error && error.term === term ? error.text : null

  const loadMore = (): void => {
    if (!current || current.next === null || loadingMore) return
    setLoadingMore(true)
    const request = term ? api.gifSearch(term, current.next) : api.gifTrending(current.next)
    request
      .then(
        (result) =>
          setPage((prev) =>
            prev && prev.term === term
              ? { term, items: [...prev.items, ...result.items], next: result.next }
              : prev
          ),
        (err: unknown) => setError({ term, text: describe(err) })
      )
      .finally(() => setLoadingMore(false))
  }

  const items = current?.items ?? []
  const focusTile = (index: number): void => {
    const next = Math.max(0, Math.min(items.length - 1, index))
    setActive(next)
    tiles.current[next]?.focus()
  }
  const onTileKey = (index: number) => (e: React.KeyboardEvent) => {
    const moves: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: COLUMNS,
      ArrowUp: -COLUMNS
    }
    if (e.key in moves) {
      e.preventDefault()
      if (e.key === 'ArrowUp' && index < COLUMNS) {
        rootRef.current?.querySelector<HTMLInputElement>('.gif-search')?.focus()
        return
      }
      focusTile(index + moves[e.key]!)
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusTile(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      focusTile(items.length - 1)
    }
  }

  return (
    <div ref={rootRef} className="gif-picker-panel" role="dialog" aria-label="GIF picker">
      <input
        className="gif-search emoji-search"
        type="text"
        autoFocus
        placeholder={`Search ${support?.provider === 'giphy' ? 'GIPHY' : 'GIFs'}`}
        value={query}
        maxLength={50}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && items.length > 0) {
            e.preventDefault()
            focusTile(active)
          } else if (e.key === 'Enter' && items[0]) {
            e.preventDefault()
            onPick(items[0])
          }
        }}
        aria-label="Search GIFs"
      />
      <div className="gif-scroll" aria-busy={!current && !currentError}>
        {currentError ? (
          <p className="gif-message" role="alert">
            {currentError}
          </p>
        ) : !current ? (
          <p className="gif-message">Loading…</p>
        ) : items.length === 0 ? (
          <p className="gif-message">No GIFs found for “{term}”.</p>
        ) : (
          <>
            <h3 className="gif-heading">{term ? `Results for “${term}”` : 'Trending'}</h3>
            <div className="gif-grid" role="list">
              {items.map((gif, i) => (
                <div key={`${gif.id}-${i}`} role="listitem">
                  <GifTile
                    gif={gif}
                    reduced={reduced}
                    tabIndex={i === active ? 0 : -1}
                    onPick={() => onPick(gif)}
                    onKeyDown={onTileKey(i)}
                    buttonRef={(el) => {
                      tiles.current[i] = el
                    }}
                  />
                </div>
              ))}
            </div>
            {current.next !== null && (
              <button
                type="button"
                className="button secondary small gif-more"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        )}
      </div>
      {support && (
        <a
          className="gif-attribution"
          href={support.attribution.url}
          target="_blank"
          rel="noreferrer"
        >
          {support.attribution.text}
        </a>
      )}
    </div>
  )
}

export default GifPicker
