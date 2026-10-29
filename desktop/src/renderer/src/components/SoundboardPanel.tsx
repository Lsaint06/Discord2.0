/**
 * Milestone 14: the soundboard for the voice channel you're in. Clicking a sound plays it for
 * everyone in your voice channel (the server checks you're there and limits how often).
 * Preview plays it only for you. People who can manage the server add and remove sounds.
 */
import { useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../net/api'
import { SOUNDBOARD_LIMITS, type ApiSoundboardSound } from '../net/protocol'
import { clipToWav } from '../chat/wav'
import { describeError } from '../hooks/useBackend'

interface SoundboardPanelProps {
  api: ApiClient
  serverId: string
  serverName: string
  canManage: boolean
  /** Plays a clip only for you. */
  onPreview: (sound: ApiSoundboardSound) => void
}

function SoundboardPanel({
  api,
  serverId,
  serverName,
  canManage,
  onPreview
}: SoundboardPanelProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [sounds, setSounds] = useState<ApiSoundboardSound[] | null>(null)
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    api.listSoundboard(serverId).then(
      (list) => alive && setSounds(list),
      (err: unknown) => alive && setMessage({ error: true, text: describeError(err) })
    )
    return () => {
      alive = false
    }
  }, [api, serverId, open])

  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>('input, button')?.focus()
  }, [open])

  const play = async (sound: ApiSoundboardSound): Promise<void> => {
    setMessage(null)
    try {
      await api.playSoundboard(sound.id)
    } catch (err) {
      const status = (err as { status?: number }).status
      setMessage({
        error: true,
        text:
          status === 429 ? 'Easy there — wait a moment before the next sound.' : describeError(err)
      })
    }
  }

  const add = async (file: File): Promise<void> => {
    setBusy(true)
    setMessage(null)
    let wav: Blob
    try {
      wav = (await clipToWav(file)).wav
    } catch {
      setBusy(false)
      setMessage({ error: true, text: 'That file couldn’t be read as audio.' })
      return
    }
    try {
      const name =
        file.name
          .replace(/\.[a-z0-9]{1,5}$/i, '')
          .replace(/[_-]+/g, ' ')
          .trim()
          .slice(0, SOUNDBOARD_LIMITS.nameMaxLength) || 'Sound'
      const added = await api.uploadSoundboard(serverId, { name, emoji: null, wav })
      setSounds((list) => [...(list ?? []), added])
      setMessage({ error: false, text: `Added “${added.name}”.` })
    } catch (err) {
      setMessage({ error: true, text: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (sound: ApiSoundboardSound): Promise<void> => {
    if (!window.confirm(`Remove “${sound.name}” from ${serverName}’s soundboard?`)) return
    try {
      await api.deleteSoundboard(sound.id)
      setSounds((list) => (list ?? []).filter((s) => s.id !== sound.id))
    } catch (err) {
      setMessage({ error: true, text: describeError(err) })
    }
  }

  const needle = query.trim().toLowerCase()
  const shown = (sounds ?? []).filter((s) => s.name.toLowerCase().includes(needle))

  return (
    <div className="soundboard">
      <button
        type="button"
        className={`button secondary small soundboard-toggle${open ? ' active' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Soundboard
      </button>
      {open && (
        <div
          ref={panelRef}
          className="soundboard-panel"
          role="dialog"
          aria-label={`${serverName} soundboard`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setOpen(false)
            }
          }}
        >
          <div className="soundboard-head">
            <input
              className="text-input compact"
              type="search"
              placeholder="Search sounds"
              aria-label="Search sounds"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {canManage && (
              <>
                <button
                  type="button"
                  className="button primary small"
                  disabled={busy || (sounds?.length ?? 0) >= SOUNDBOARD_LIMITS.maxSoundsPerServer}
                  onClick={() => fileRef.current?.click()}
                >
                  {busy ? 'Adding…' : 'Add'}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="audio/*"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (file) void add(file)
                  }}
                />
              </>
            )}
          </div>
          {message && (
            <p
              className={message.error ? 'form-error' : 'form-notice'}
              role={message.error ? 'alert' : 'status'}
            >
              {message.text}
            </p>
          )}
          {sounds === null ? (
            <div className="spinner" aria-label="Loading sounds" />
          ) : shown.length === 0 ? (
            <p className="soundboard-empty">
              {sounds.length > 0
                ? 'No sounds match.'
                : canManage
                  ? 'No sounds yet. Add a short clip (up to 5 seconds).'
                  : 'No sounds yet. Someone who manages the server can add some.'}
            </p>
          ) : (
            <ul className="soundboard-grid">
              {shown.map((s) => (
                <li key={s.id} className="soundboard-item">
                  <button
                    type="button"
                    className="soundboard-play"
                    onClick={() => void play(s)}
                    title={`Play “${s.name}” for everyone in your voice channel`}
                  >
                    {s.emoji && <span aria-hidden="true">{s.emoji}</span>}
                    <span className="soundboard-name">{s.name}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button small"
                    onClick={() => onPreview(s)}
                    aria-label={`Preview “${s.name}” (only you hear it)`}
                    title="Preview (only you)"
                  >
                    ▶
                  </button>
                  {canManage && (
                    <button
                      type="button"
                      className="icon-button small danger-text"
                      onClick={() => void remove(s)}
                      aria-label={`Remove “${s.name}”`}
                      title="Remove"
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="soundboard-note">
            Everyone in your voice channel hears it at their own soundboard volume.
          </p>
        </div>
      )}
    </div>
  )
}

export default SoundboardPanel
