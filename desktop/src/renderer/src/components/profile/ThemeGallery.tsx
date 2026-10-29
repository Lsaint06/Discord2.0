/**
 * Milestone 14: the theme gallery. Choosing a card previews the theme across the whole app at
 * once; Apply saves it (to your account on servers that support it, otherwise on this device),
 * Cancel goes back. Leaving the gallery without applying also goes back. Arrow keys move
 * between cards (one tab stop for the whole grid), Enter/Space previews.
 */
import { useEffect, useRef, useState } from 'react'
import type { AppThemeId } from '../../net/protocol'
import { APP_THEME_DEFS, appThemeById, type AppThemeDef } from '../../lib/themes'

interface ThemeGalleryProps {
  /** The saved theme (null = Classic). */
  value: AppThemeId | null
  /** Classic follows Dark/Light/Sync; shown on its card. */
  classicBase: 'dark' | 'light'
  onApply: (id: AppThemeId | null) => Promise<string | null>
  onPreview: (id: AppThemeId | null | undefined) => void
  /** Where the choice is stored (for the note under the gallery). */
  synced: boolean
}

const CLASSIC_DARK = {
  rail: '#1b1c20',
  secondary: '#26282d',
  primary: '#2f3136',
  textNormal: '#dcdee3',
  textMuted: '#969aa3',
  accent: '#6d72f6'
}
const CLASSIC_LIGHT = {
  rail: '#e3e5e8',
  secondary: '#f2f3f5',
  primary: '#ffffff',
  textNormal: '#2e3338',
  textMuted: '#5c6370',
  accent: '#6d72f6'
}

function MiniPreview({
  theme,
  classic
}: {
  theme: AppThemeDef | null
  classic: 'dark' | 'light'
}): React.JSX.Element {
  const p = theme?.palette ?? (classic === 'dark' ? CLASSIC_DARK : CLASSIC_LIGHT)
  const backdrop = theme?.backdrop
    ? `linear-gradient(${theme.backdrop.angle}deg, ${theme.backdrop.stops.join(', ')})`
    : p.rail
  const alpha = theme?.backdrop ? Math.round(theme.backdrop.panelAlpha * 100) : 100
  return (
    <span
      className={`theme-mini${theme ? ` ambient-${theme.ambient}` : ''}`}
      style={
        {
          background: backdrop,
          '--m-rail': p.rail,
          '--m-side': p.secondary,
          '--m-chat': p.primary,
          '--m-text': p.textNormal,
          '--m-muted': p.textMuted,
          '--m-accent': p.accent,
          '--m-alpha': `${alpha}%`
        } as React.CSSProperties
      }
      aria-hidden="true"
    >
      <span className="m-rail">
        <i />
        <i />
        <i />
      </span>
      <span className="m-side">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="m-chat">
        <b />
        <b />
        <b />
        <span className="m-input" />
      </span>
    </span>
  )
}

function ThemeGallery({
  value,
  classicBase,
  onApply,
  onPreview,
  synced
}: ThemeGalleryProps): React.JSX.Element {
  /** The card being previewed (undefined = nothing pending). */
  const [pending, setPending] = useState<AppThemeId | null | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const options: (AppThemeDef | null)[] = [null, ...APP_THEME_DEFS]
  const shown = pending !== undefined ? pending : value
  const focusIndex = Math.max(
    0,
    options.findIndex((t) => (t?.id ?? null) === shown)
  )
  const cards = useRef<(HTMLButtonElement | null)[]>([])

  // Leaving the gallery (closing Settings or switching sections) cancels a preview.
  const previewRef = useRef(onPreview)
  useEffect(() => {
    previewRef.current = onPreview
  })
  useEffect(() => () => previewRef.current(undefined), [])

  const preview = (id: AppThemeId | null): void => {
    setError(null)
    if (id === value) {
      setPending(undefined)
      onPreview(undefined)
      return
    }
    setPending(id)
    onPreview(id)
  }

  const apply = async (): Promise<void> => {
    if (pending === undefined) return
    setSaving(true)
    const failure = await onApply(pending)
    setSaving(false)
    if (failure) {
      setError(`Couldn’t save: ${failure}`)
      return
    }
    setPending(undefined)
    onPreview(undefined)
  }

  const cancel = (): void => {
    setPending(undefined)
    setError(null)
    onPreview(undefined)
  }

  const onKeyDown = (e: React.KeyboardEvent, index: number): void => {
    const columns = Math.max(
      1,
      Math.round(
        (e.currentTarget.parentElement?.clientWidth ?? 600) /
          Math.max(1, e.currentTarget.getBoundingClientRect().width)
      )
    )
    const moves: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns,
      ArrowUp: -columns
    }
    let next: number | null = null
    if (e.key in moves) next = index + moves[e.key]!
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = options.length - 1
    if (next === null) return
    e.preventDefault()
    next = Math.min(options.length - 1, Math.max(0, next))
    cards.current[next]?.focus()
  }

  const pendingName =
    pending === undefined
      ? null
      : pending === null
        ? 'Classic'
        : (appThemeById(pending)?.name ?? '')

  return (
    <div className="theme-gallery">
      <div className="theme-grid" role="radiogroup" aria-label="App theme">
        {options.map((theme, index) => {
          const id = theme?.id ?? null
          const selected = shown === id
          const saved = value === id
          return (
            <button
              key={id ?? 'classic'}
              ref={(el) => {
                cards.current[index] = el
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={index === focusIndex ? 0 : -1}
              className={`theme-card${selected ? ' selected' : ''}${saved ? ' saved' : ''}`}
              onClick={() => preview(id)}
              onKeyDown={(e) => onKeyDown(e, index)}
              data-theme-id={id ?? 'classic'}
            >
              <MiniPreview theme={theme} classic={classicBase} />
              <span className="theme-card-text">
                <span className="theme-card-name">
                  {theme?.name ?? 'Classic'}
                  {saved && <span className="theme-card-badge">Current</span>}
                </span>
                <span className="theme-card-description">
                  {theme?.description ??
                    'The original Discord 2.0 look. Follows Dark / Light / Sync below.'}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {pending !== undefined && (
        <div className="theme-preview-bar" role="status">
          <span>
            Previewing <strong>{pendingName}</strong> — it isn’t saved yet.
          </span>
          <button type="button" className="button link" onClick={cancel} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => void apply()}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Apply'}
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="setting-description">
        {synced
          ? 'Your theme follows your account to every PC you sign in on.'
          : 'This server doesn’t sync themes yet, so your theme is saved on this PC only.'}{' '}
        {value !== null && (
          <button
            type="button"
            className="button link inline"
            onClick={() => {
              setPending(undefined)
              onPreview(undefined)
              void onApply(null)
            }}
          >
            Reset to Classic
          </button>
        )}
      </p>
    </div>
  )
}

export default ThemeGallery
