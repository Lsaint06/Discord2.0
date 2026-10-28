import { useEffect, useImperativeHandle, useReducer, useRef, useState, type Ref } from 'react'
import type { Channel, Message } from '../../types'
import { LIMITS, type ApiAttachment } from '../../net/protocol'
import { UploadAbortedError } from '../../net/api'
import {
  UPLOAD_ACCEPT,
  filesFromTransfer,
  formatBytes,
  nameForPastedFile,
  planUploads,
  uploadsReady,
  uploadsReducer
} from '../../chat/uploads'
import { CloseIcon, PlusIcon, SendIcon, SmileIcon } from '../Icons'
import EmojiPicker from './EmojiPicker'

const MAX_LENGTH = LIMITS.messageMaxLength

interface ComposerProps {
  channel: Channel
  draft: string
  onDraftChange: (value: string) => void
  replyTo: Message | null
  replyAuthorName?: string
  onCancelReply: () => void
  onSend: (input: { content: string; attachments: ApiAttachment[] }) => void
  upload: (
    file: Blob,
    filename: string,
    onProgress: (fraction: number) => void,
    signal: AbortSignal
  ) => Promise<ApiAttachment>
  deleteAttachment: (attachmentId: string) => void
  describeError: (err: unknown) => string
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
}

export interface ComposerHandle {
  addFiles: (files: File[]) => void
}

let keySeq = 0
const nextKey = (): string => `u${Date.now().toString(36)}-${(keySeq++).toString(36)}`

function Composer({ ref, ...props }: ComposerProps): React.JSX.Element {
  const { channel, draft, onDraftChange } = props
  const target = props.targetLabel ?? `#${channel.name}`
  const [uploads, dispatch] = useReducer(uploadsReducer, [])
  const [notice, setNotice] = useState<string | null>(null)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // Per upload: controller (to cancel), the stored attachment, local preview URL, source file.
  const controllers = useRef(new Map<string, AbortController>())
  const stored = useRef(new Map<string, ApiAttachment>())
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const sources = useRef(new Map<string, File>())
  const sentRef = useRef(false)
  const uploadRef = useRef(props.upload)
  const deleteRef = useRef(props.deleteAttachment)
  useEffect(() => {
    uploadRef.current = props.upload
    deleteRef.current = props.deleteAttachment
  }, [props.upload, props.deleteAttachment])

  const resize = (): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }

  useEffect(() => {
    resize()
    inputRef.current?.focus()
  }, [channel.id])

  useEffect(() => {
    if (props.replyTo) inputRef.current?.focus()
  }, [props.replyTo])

  // Leaving the channel (unmount): cancel running uploads and delete unsent ones.
  useEffect(() => {
    const ctrls = controllers.current
    const done = stored.current
    const sent = sentRef
    return () => {
      for (const c of ctrls.values()) c.abort()
      if (!sent.current) for (const a of done.values()) deleteRef.current(a.id)
    }
  }, [])
  useEffect(
    () => () => {
      for (const url of Object.values(previews)) URL.revokeObjectURL(url)
    },
    // Revoke whatever previews exist at unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const start = (key: string, file: File, name: string): void => {
    const controller = new AbortController()
    controllers.current.set(key, controller)
    uploadRef
      .current(
        file,
        name,
        (p) => dispatch({ type: 'progress', key, progress: p }),
        controller.signal
      )
      .then((attachment) => {
        controllers.current.delete(key)
        stored.current.set(key, attachment)
        dispatch({ type: 'done', key, attachmentId: attachment.id })
      })
      .catch((err: unknown) => {
        controllers.current.delete(key)
        if (err instanceof UploadAbortedError) return
        dispatch({ type: 'error', key, error: props.describeError(err) })
      })
  }

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
      nextKey
    )
    setNotice(rejected.length ? rejected.join(' · ') : null)
    if (accepted.length === 0) return
    dispatch({ type: 'add', items: accepted.map((a) => a.item) })
    const newPreviews: Record<string, string> = {}
    for (const { file, item } of accepted) {
      sources.current.set(item.key, file.source)
      if (item.isImage) newPreviews[item.key] = URL.createObjectURL(file.source)
      start(item.key, file.source, item.name)
    }
    setPreviews((prev) => ({ ...prev, ...newPreviews }))
  }
  // Latest addFiles for drag & drop (ChatPanel calls it through the ref handle).
  useImperativeHandle(ref, () => ({ addFiles }))

  const remove = (key: string): void => {
    controllers.current.get(key)?.abort()
    controllers.current.delete(key)
    const attachment = stored.current.get(key)
    if (attachment) props.deleteAttachment(attachment.id)
    stored.current.delete(key)
    sources.current.delete(key)
    const url = previews[key]
    if (url) URL.revokeObjectURL(url)
    setPreviews((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    dispatch({ type: 'remove', key })
  }

  const retry = (key: string): void => {
    const item = uploads.find((u) => u.key === key)
    const source = sources.current.get(key)
    if (!item || !source) return
    dispatch({ type: 'remove', key })
    dispatch({
      type: 'add',
      items: [{ ...item, status: 'uploading', progress: 0, error: undefined }]
    })
    start(key, source, item.name)
  }

  const ready = uploadsReady(uploads)
  const content = draft.trim()
  const canSend = ready && (content.length > 0 || uploads.length > 0) && !props.disabled

  const send = (): void => {
    if (!canSend) return
    const attachments = uploads
      .map((u) => stored.current.get(u.key))
      .filter((a): a is ApiAttachment => Boolean(a))
    props.onSend({ content, attachments })
    for (const url of Object.values(previews)) URL.revokeObjectURL(url)
    stored.current.clear()
    sources.current.clear()
    setPreviews({})
    dispatch({ type: 'clear' })
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
          {uploads.map((u) => (
            <li key={u.key} className={`upload-item ${u.status}`}>
              <div className="upload-thumb">
                {previews[u.key] ? (
                  <img src={previews[u.key]} alt="" />
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
          ))}
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
            onDraftChange(e.target.value)
            resize()
          }}
          onPaste={(e) => {
            const files = filesFromTransfer(e.clipboardData)
            if (files.length > 0) {
              e.preventDefault()
              addFiles(files)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            } else if (e.key === 'Escape') {
              if (emojiOpen) setEmojiOpen(false)
              else if (props.replyTo) props.onCancelReply()
            } else if (e.key === 'ArrowUp' && draft.length === 0 && uploads.length === 0) {
              e.preventDefault()
              props.onEditLast()
            }
          }}
        />
        <div className="composer-actions">
          <button
            type="button"
            className={`icon-button${emojiOpen ? ' selected' : ''}`}
            onClick={() => setEmojiOpen((open) => !open)}
            aria-label="Insert emoji"
            aria-expanded={emojiOpen}
            title="Emoji"
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
          />
        )}
      </div>
      <div className="composer-hint">
        <span>
          <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · <kbd>↑</kbd> edit
          last · paste or drop files to attach
        </span>
        {draft.length > MAX_LENGTH - 200 && (
          <span className="composer-count">{MAX_LENGTH - draft.length}</span>
        )}
      </div>
    </form>
  )
}

export default Composer
