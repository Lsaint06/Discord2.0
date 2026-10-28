import {
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref
} from 'react'
import type { Channel, Message } from '../../types'
import { LIMITS, type ApiAttachment, type ApiGif } from '../../net/protocol'
import type { ApiClient, LargeFileSupport } from '../../net/api'
import { expiryNote } from '../../chat/largeUpload'
import { UploadContext } from '../../chat/uploadContext'
import {
  UPLOAD_ACCEPT,
  filesFromTransfer,
  formatBytes,
  nameForPastedFile,
  planUploads,
  uploadsReady
} from '../../chat/uploads'
import { CloseIcon, PlusIcon, SendIcon, SmileIcon } from '../Icons'
import EmojiPicker from './EmojiPicker'
import GifPicker from './GifPicker'
import {
  completeEmojiShortcode,
  emojiName,
  findEmojiQuery,
  insertEmojiAt,
  suggestEmoji,
  type EmojiQuery
} from '../../chat/emojiAutocomplete'

const MAX_LENGTH = LIMITS.messageMaxLength

interface ComposerProps {
  channel: Channel
  draft: string
  onDraftChange: (value: string) => void
  replyTo: Message | null
  replyAuthorName?: string
  onCancelReply: () => void
  onSend: (input: { content: string; attachments: ApiAttachment[] }) => void
  recentEmoji: string[]
  onEmojiUsed: (emoji: string) => void
  /** Up-arrow in an empty composer edits your last message. */
  onEditLast: () => void
  /** Lets ChatPanel push dropped files into the tray. */
  ref?: Ref<ComposerHandle>
  disabled?: boolean
  /** Shown instead of the placeholder while sending isn't allowed. */
  disabledReason?: string
  /** Attach Files permission (false hides uploads; the server enforces it too). */
  canAttach?: boolean
  /** Who/where you're writing to ("#general", "@Ana", a group name). Defaults to the channel. */
  targetLabel?: string
  /** GIF picker: the API client (the server proxies the provider); absent = no GIF button. */
  gifApi?: ApiClient
  /** Sends a GIF the picker returned (as its own message). */
  onSendGif?: (gif: ApiGif) => void
  /** The server accepts large files (chunked uploads up to `maxBytes`). */
  largeFiles?: LargeFileSupport | null
}

export interface ComposerHandle {
  addFiles: (files: File[]) => void
}

let keySeq = 0
const nextKey = (): string => `u${Date.now().toString(36)}-${(keySeq++).toString(36)}`

function Composer({ ref, ...props }: ComposerProps): React.JSX.Element {
  const { channel, draft, onDraftChange } = props
  const target = props.targetLabel ?? `#${channel.name}`
  // Uploads belong to the workspace (they keep going when you switch channels); this box shows
  // and sends the ones for its own channel.
  const manager = useContext(UploadContext)
  if (!manager) throw new Error('Composer needs an UploadContext')
  const uploads = useSyncExternalStore(manager.subscribe, () => manager.tray(channel.id))
  const [notice, setNotice] = useState<string | null>(null)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [gifOpen, setGifOpen] = useState(false)
  // ":name" autocomplete (null = not typing an emoji name).
  const [emojiQuery, setEmojiQuery] = useState<EmojiQuery | null>(null)
  const [suggestIndex, setSuggestIndex] = useState(0)
  const suggestions = emojiQuery && !props.disabled ? suggestEmoji(emojiQuery.query) : []
  const ids = useId()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const resize = (): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }

  useEffect(() => {
    resize()
    const el = inputRef.current
    if (!el) return
    el.focus()
    // Continue a saved draft where it ends, not in front of it.
    el.setSelectionRange(el.value.length, el.value.length)
  }, [channel.id])

  useEffect(() => {
    if (props.replyTo) inputRef.current?.focus()
  }, [props.replyTo])

  const addFiles = (files: File[]): void => {
    if (files.length === 0) return
    if (props.canAttach === false || props.disabled) {
      setNotice('You can’t attach files in this channel.')
      return
    }
    const { accepted, rejected } = planUploads(
      uploads,
      files.map((source) => ({
        name: nameForPastedFile(source),
        size: source.size,
        type: source.type,
        source
      })),
      nextKey,
      props.largeFiles?.maxBytes
    )
    // Large files that will be deleted after a while: say so up front.
    const large = props.largeFiles
    const expiring = large
      ? accepted
          .map((a) => expiryNote(a.file.size, large.ephemeralThresholdBytes, large.ephemeralMs))
          .find(Boolean)
      : null
    setNotice([...rejected, ...(expiring ? [expiring] : [])].join(' · ') || null)
    if (accepted.length === 0) return
    manager.add(
      channel.id,
      accepted.map(({ file, item }) => ({ source: file.source, item }))
    )
  }
  // Latest addFiles for drag & drop (ChatPanel calls it through the ref handle).
  useImperativeHandle(ref, () => ({ addFiles }))

  const remove = (key: string): void => manager.remove(channel.id, key)
  const retry = (key: string): void => manager.retry(channel.id, key)

  const ready = uploadsReady(uploads)
  const content = draft.trim()
  const canSend = ready && (content.length > 0 || uploads.length > 0) && !props.disabled

  const send = (): void => {
    if (!canSend) return
    const attachments = manager.take(channel.id)
    if (!attachments) return
    props.onSend({ content, attachments })
    onDraftChange('')
    setEmojiOpen(false)
    setNotice(null)
    requestAnimationFrame(resize)
  }

  const insertEmoji = (emoji: string): void => {
    const el = inputRef.current
    const startPos = el?.selectionStart ?? draft.length
    const end = el?.selectionEnd ?? draft.length
    onDraftChange((draft.slice(0, startPos) + emoji + draft.slice(end)).slice(0, MAX_LENGTH))
    props.onEmojiUsed(emoji)
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      const caret = startPos + emoji.length
      el.setSelectionRange(caret, caret)
      resize()
    })
  }

  /** Moves the caret after React has applied the new draft. */
  const placeCaret = (caret: number): void => {
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(caret, caret)
      resize()
    })
  }

  const applySuggestion = (emoji: string): void => {
    const el = inputRef.current
    if (!emojiQuery) return
    const caret = el?.selectionStart ?? draft.length
    const next = insertEmojiAt(draft, emojiQuery.start, caret, emoji, MAX_LENGTH)
    onDraftChange(next.text)
    props.onEmojiUsed(emoji)
    setEmojiQuery(null)
    placeCaret(next.caret)
  }

  const uploading = uploads.some((u) => u.status === 'uploading')
  const failed = uploads.some((u) => u.status === 'error')

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
      {props.replyTo && (
        <div className="composer-reply">
          <span>
            Replying to <strong>{props.replyAuthorName ?? 'message'}</strong>
          </span>
          <button
            type="button"
            className="icon-button small"
            onClick={props.onCancelReply}
            aria-label="Cancel reply"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      )}

      {uploads.length > 0 && (
        <ul className="upload-tray" aria-label="Attachments to send">
          {uploads.map((u) => {
            const preview = manager.preview(u.key)
            return (
              <li key={u.key} className={`upload-item ${u.status}`}>
                <div className="upload-thumb">
                  {preview ? (
                    <img src={preview} alt="" />
                  ) : (
                    <span>{u.name.split('.').pop()?.toUpperCase()}</span>
                  )}
                </div>
                <span className="upload-name" title={u.name}>
                  {u.name}
                </span>
                <span className="upload-meta">
                  {u.status === 'error' ? (
                    <span className="upload-error" role="alert">
                      {u.error}
                    </span>
                  ) : u.status === 'uploading' ? (
                    `${Math.round(u.progress * 100)}% · ${formatBytes(u.size)}`
                  ) : (
                    formatBytes(u.size)
                  )}
                </span>
                {u.status === 'uploading' && (
                  <progress max={1} value={u.progress} aria-label={`Uploading ${u.name}`} />
                )}
                <div className="upload-actions">
                  {u.status === 'error' && (
                    <button type="button" className="link-button" onClick={() => retry(u.key)}>
                      Retry
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button small"
                    onClick={() => remove(u.key)}
                    aria-label={
                      u.status === 'uploading' ? `Cancel upload of ${u.name}` : `Remove ${u.name}`
                    }
                    title={u.status === 'uploading' ? 'Cancel upload' : 'Remove'}
                  >
                    <CloseIcon size={14} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {notice && (
        <div className="composer-notice" role="alert">
          {notice}
          <button type="button" className="link-button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="composer-box">
        <button
          type="button"
          className="icon-button composer-attach"
          onClick={() => fileRef.current?.click()}
          aria-label="Upload a file"
          title={props.canAttach === false ? 'You can’t attach files here' : 'Upload a file'}
          disabled={props.disabled || props.canAttach === false}
        >
          <PlusIcon size={20} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          maxLength={MAX_LENGTH}
          placeholder={
            props.disabled
              ? (props.disabledReason ?? 'You can’t send messages here')
              : `Message ${target}`
          }
          aria-label={`Message ${target}`}
          disabled={props.disabled}
          onChange={(e) => {
            const value = e.target.value
            const caret = e.target.selectionStart ?? value.length
            // ":name:" typed in full becomes the emoji right away.
            const done = completeEmojiShortcode(value, caret, MAX_LENGTH)
            if (done) {
              onDraftChange(done.text)
              props.onEmojiUsed(done.emoji)
              setEmojiQuery(null)
              placeCaret(done.caret)
            } else {
              onDraftChange(value)
              setEmojiQuery(findEmojiQuery(value, caret))
              setSuggestIndex(0)
            }
            resize()
          }}
          onSelect={(e) => {
            const el = e.currentTarget
            if (el.selectionStart !== el.selectionEnd) setEmojiQuery(null)
          }}
          onBlur={() => setEmojiQuery(null)}
          aria-autocomplete="list"
          aria-controls={suggestions.length ? `${ids}-emoji-suggest` : undefined}
          aria-activedescendant={
            suggestions.length
              ? `${ids}-emoji-${Math.min(suggestIndex, suggestions.length - 1)}`
              : undefined
          }
          onPaste={(e) => {
            const files = filesFromTransfer(e.clipboardData)
            if (files.length > 0) {
              e.preventDefault()
              addFiles(files)
            }
          }}
          onKeyDown={(e) => {
            const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
            if (suggestions.length > 0 && !e.nativeEvent.isComposing) {
              const current = Math.min(suggestIndex, suggestions.length - 1)
              if (plain && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault()
                const step = e.key === 'ArrowDown' ? 1 : -1
                setSuggestIndex((current + step + suggestions.length) % suggestions.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                applySuggestion(suggestions[current]!.emoji)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setEmojiQuery(null)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            } else if (e.key === 'Escape') {
              if (emojiOpen) setEmojiOpen(false)
              else if (props.replyTo) props.onCancelReply()
            } else if (plain && e.key === 'ArrowUp' && draft.length === 0 && uploads.length === 0) {
              e.preventDefault()
              props.onEditLast()
            }
          }}
        />
        <div className="composer-actions">
          {props.gifApi && props.onSendGif && (
            <button
              type="button"
              className={`icon-button gif-button${gifOpen ? ' selected' : ''}`}
              onClick={() => {
                setEmojiOpen(false)
                setGifOpen((open) => !open)
              }}
              disabled={props.disabled}
              aria-label="Send a GIF"
              aria-expanded={gifOpen}
              data-picker-toggle
              title="GIF"
            >
              GIF
            </button>
          )}
          <button
            type="button"
            className={`icon-button${emojiOpen ? ' selected' : ''}`}
            onClick={() => {
              setGifOpen(false)
              setEmojiOpen((open) => !open)
            }}
            aria-label="Insert emoji"
            aria-expanded={emojiOpen}
            data-picker-toggle
            title="Emoji"
            disabled={props.disabled}
          >
            <SmileIcon size={22} />
          </button>
          <button
            type="submit"
            className="icon-button send-button"
            disabled={!canSend}
            aria-label="Send message"
            title={
              uploading
                ? 'Waiting for uploads…'
                : failed
                  ? 'Remove or retry failed uploads'
                  : 'Send'
            }
          >
            <SendIcon size={20} />
          </button>
        </div>
        {emojiOpen && (
          <EmojiPicker
            recent={props.recentEmoji}
            onPick={insertEmoji}
            onClose={() => setEmojiOpen(false)}
            onEscape={() => inputRef.current?.focus()}
          />
        )}
        {gifOpen && props.gifApi && props.onSendGif && (
          <GifPicker
            api={props.gifApi}
            onPick={(gif) => {
              setGifOpen(false)
              props.onSendGif?.(gif)
              inputRef.current?.focus()
            }}
            onClose={() => setGifOpen(false)}
            onEscape={() => inputRef.current?.focus()}
          />
        )}
        {suggestions.length > 0 && (
          <ul
            id={`${ids}-emoji-suggest`}
            className="emoji-suggest"
            role="listbox"
            aria-label={`Emoji matching :${emojiQuery?.query ?? ''}`}
          >
            {suggestions.map((entry, i) => (
              <li
                key={entry.emoji}
                id={`${ids}-emoji-${i}`}
                role="option"
                aria-selected={i === Math.min(suggestIndex, suggestions.length - 1)}
                className={i === Math.min(suggestIndex, suggestions.length - 1) ? 'active' : ''}
                onMouseDown={(e) => {
                  e.preventDefault()
                  applySuggestion(entry.emoji)
                }}
              >
                <span className="emoji-suggest-glyph" aria-hidden="true">
                  {entry.emoji}
                </span>
                <span>:{emojiName(entry)}:</span>
              </li>
            ))}
            <li className="emoji-suggest-hint" role="presentation">
              <kbd>↑</kbd>
              <kbd>↓</kbd> choose · <kbd>Enter</kbd>/<kbd>Tab</kbd> insert · <kbd>Esc</kbd> close
            </li>
          </ul>
        )}
      </div>
      <div className="composer-hint">
        {!props.disabled && (
          <span>
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · <kbd>↑</kbd>{' '}
            edit last · paste or drop files to attach
          </span>
        )}
        {draft.length > MAX_LENGTH - 200 && (
          <span className="composer-count">{MAX_LENGTH - draft.length}</span>
        )}
      </div>
    </form>
  )
}

export default Composer
