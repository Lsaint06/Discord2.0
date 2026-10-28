import { memo, useEffect, useRef, useState } from 'react'
import type { Message, User } from '../../types'
import type { ApiAttachment } from '../../net/protocol'
import type { AttachmentCache } from '../../chat/attachmentCache'
import { QUICK_REACTIONS } from '../../chat/emoji'
import { formatTime, formatTimestamp } from '../../lib/format'
import { LIMITS } from '../../net/protocol'
import Avatar from '../Avatar'
import Markdown from './Markdown'
import AttachmentList from './AttachmentList'
import GifEmbed from './GifEmbed'
import { deleteMode } from '../../chat/messageDelete'
import { parseGifMessage } from '../../chat/gifs'

function TrashGlyph(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export interface MessageActions {
  reply: (m: Message) => void
  startEdit: (m: Message) => void
  cancelEdit: () => void
  saveEdit: (m: Message, content: string) => Promise<string | null>
  requestDelete: (m: Message) => void
  /** Deletes without the confirmation dialog (Shift + Delete button). */
  quickDelete: (m: Message) => void
  react: (m: Message, emoji: string) => void
  openReactionPicker: (m: Message, anchor: DOMRect) => void
  openMenu: (m: Message, x: number, y: number) => void
  openImage: (a: ApiAttachment) => void
  jump: (channelId: string, messageId: string) => void
  retry: (nonce: string) => void
  discard: (nonce: string) => void
  /** Opens the profile popout of a user next to the clicked element. */
  openProfile: (userId: string, anchor: DOMRect) => void
}

interface MessageItemProps {
  message: Message
  author: User
  /** Author of the replied-to message (if it still exists). */
  replyAuthor?: User
  nameColor?: string
  grouped: boolean
  compact: boolean
  showTimestamps: boolean
  isSelf: boolean
  /** Own message or Manage Messages (the server re-checks). */
  canDelete?: boolean
  /** What the viewer may do here (the server re-checks); hides the matching controls. */
  canReact?: boolean
  canReply?: boolean
  /** Own message, and not timed out. */
  canEdit?: boolean
  /** A delete request for this message is in flight. */
  deleting?: boolean
  mentioned: boolean
  flash: boolean
  editing: boolean
  /** Known names for mention rendering (stable array from the mention detector). */
  mentionNames?: readonly string[]
  selfMentionNames?: ReadonlySet<string>
  highlight?: string[]
  cache: AttachmentCache
  actions: MessageActions
}

function EditBox({
  message,
  actions
}: {
  message: Message
  actions: MessageActions
}): React.JSX.Element {
  const [value, setValue] = useState(message.content)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 300)}px`
  }, [])

  const save = async (): Promise<void> => {
    const content = value.trim()
    if (content === message.content.trim()) return actions.cancelEdit()
    if (!content && !message.attachments?.length) {
      // Empty edit with no attachments = offer deletion instead, like most chat apps.
      actions.cancelEdit()
      actions.requestDelete(message)
      return
    }
    setSaving(true)
    const failure = await actions.saveEdit(message, content)
    setSaving(false)
    if (failure) setError(failure)
    else actions.cancelEdit()
  }

  return (
    <div className="message-edit">
      <textarea
        ref={ref}
        value={value}
        maxLength={LIMITS.messageMaxLength}
        aria-label="Edit message"
        disabled={saving}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
          e.target.style.height = 'auto'
          e.target.style.height = `${Math.min(e.target.scrollHeight, 300)}px`
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            actions.cancelEdit()
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void save()
          }
        }}
      />
      <div className="message-edit-hint">
        escape to{' '}
        <button type="button" className="link-button" onClick={actions.cancelEdit}>
          cancel
        </button>{' '}
        · enter to{' '}
        <button type="button" className="link-button" onClick={() => void save()}>
          save
        </button>
        {error && <span className="message-edit-error"> — {error}</span>}
      </div>
    </div>
  )
}

/**
 * Reaction count that lifts briefly when it goes up while on screen. Mounting (history loads,
 * channel switches) and unchanged counts after a reconnect never animate.
 */
function ReactionCount({ count }: { count: number }): React.JSX.Element {
  const [shown, setShown] = useState(count)
  const [bumps, setBumps] = useState(0)
  if (count !== shown) {
    setShown(count)
    if (count > shown) setBumps((n) => n + 1)
  }
  return (
    <span key={bumps} className={`reaction-count${bumps > 0 ? ' bump' : ''}`}>
      {count}
    </span>
  )
}

function AuthorName({
  author,
  color,
  actions
}: {
  author: User
  color?: string
  actions: MessageActions
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="message-author"
      style={{ color }}
      onClick={(e) => actions.openProfile(author.id, e.currentTarget.getBoundingClientRect())}
    >
      {author.name}
    </button>
  )
}

function MessageItem(props: MessageItemProps): React.JSX.Element {
  const { message, author, actions, editing } = props
  const local = message.pending || Boolean(message.failed)
  // A message that is just one GIF link shows the GIF (when this server's provider knows it).
  const gif = message.attachments?.length ? null : parseGifMessage(message.content)
  const status = message.failed ? ' failed' : message.pending ? ' pending' : ''
  // Selection state as it was before this press: Shift+mousedown would otherwise extend the
  // selection to the button and make every Shift+click look like "text is selected".
  const selectionAtPress = useRef<boolean | null>(null)
  const hasTextSelection = (): boolean => {
    const selection = window.getSelection()
    return Boolean(selection && !selection.isCollapsed)
  }
  const startDelete = (shiftKey: boolean): void => {
    const selected = selectionAtPress.current ?? hasTextSelection()
    selectionAtPress.current = null
    if (deleteMode({ shiftKey, hasTextSelection: selected }) === 'quick')
      actions.quickDelete(message)
    else actions.requestDelete(message)
  }

  const reply = message.replyTo && (
    <button
      type="button"
      className={`message-reply-ref${message.replyTo.deleted ? ' deleted' : ''}`}
      onClick={() =>
        !message.replyTo!.deleted && actions.jump(message.channelId, message.replyTo!.id)
      }
      disabled={message.replyTo.deleted}
      title={message.replyTo.deleted ? undefined : 'Jump to the original message'}
    >
      <span className="reply-spine" aria-hidden="true" />
      {message.replyTo.deleted ? (
        <span className="reply-deleted">Original message was deleted</span>
      ) : (
        <>
          {props.replyAuthor && (
            <Avatar
              name={props.replyAuthor.name}
              color={props.replyAuthor.avatarColor}
              imageId={props.replyAuthor.avatarId}
              size={16}
            />
          )}
          <span className="reply-author">{props.replyAuthor?.name ?? 'Unknown'}</span>
          <span className="reply-content">
            {message.replyTo.content ||
              (message.replyTo.attachmentCount ? 'Click to see attachment' : '')}
          </span>
        </>
      )}
    </button>
  )

  const content = editing ? (
    <EditBox message={message} actions={actions} />
  ) : (
    <>
      {message.content && gif ? (
        <GifEmbed
          gif={gif}
          fallback={
            <div className="message-content">
              <Markdown content={message.content} onJump={actions.jump} />
            </div>
          }
        />
      ) : message.content ? (
        <div className="message-content">
          <Markdown
            content={message.content}
            onJump={actions.jump}
            highlight={props.highlight}
            mentionNames={props.mentionNames}
            selfNames={props.selfMentionNames}
          />
          {message.editedAt ? (
            <span className="message-edited" title={`Edited ${formatTimestamp(message.editedAt)}`}>
              (edited)
            </span>
          ) : null}
        </div>
      ) : null}
      {message.attachments && message.attachments.length > 0 && (
        <AttachmentList
          attachments={message.attachments}
          cache={props.cache}
          onOpenImage={actions.openImage}
        />
      )}
    </>
  )

  const reactions = message.reactions && message.reactions.length > 0 && (
    <div className="message-reactions">
      {message.reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className={`reaction${r.me ? ' me' : ''}`}
          onClick={() => actions.react(message, r.emoji)}
          aria-pressed={r.me}
          aria-label={`${r.emoji} ${r.count} reaction${r.count === 1 ? '' : 's'}${r.me ? ', including you' : ''}`}
          disabled={local || props.canReact === false}
        >
          <span className="reaction-emoji">{r.emoji}</span>
          <ReactionCount count={r.count} />
        </button>
      ))}
      {props.canReact !== false && (
        <button
          type="button"
          className="reaction add"
          onClick={(e) =>
            actions.openReactionPicker(message, e.currentTarget.getBoundingClientRect())
          }
          aria-label="Add reaction"
          title="Add reaction"
          disabled={local}
        >
          +
        </button>
      )}
    </div>
  )

  const failure = message.failed && message.nonce && (
    <div className="message-failure" role="alert">
      <span>Not sent: {message.failed}</span>
      <button type="button" className="link-button" onClick={() => actions.retry(message.nonce!)}>
        Retry
      </button>
      <button type="button" className="link-button" onClick={() => actions.discard(message.nonce!)}>
        Discard
      </button>
    </div>
  )

  const toolbar = !local && !editing && (
    <div
      className="message-toolbar"
      role="toolbar"
      aria-label="Message actions"
      onMouseDown={(e) => {
        // Rapid Shift+clicks (e.g. on a button that just became disabled) must not start a text
        // selection, which would make the next quick delete fall back to the confirmation.
        if (e.shiftKey) e.preventDefault()
      }}
    >
      {props.canReact !== false &&
        QUICK_REACTIONS.slice(0, 3).map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => actions.react(message, emoji)}
            aria-label={`React with ${emoji}`}
            title={`React with ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      {props.canReact !== false && (
        <button
          type="button"
          onClick={(e) =>
            actions.openReactionPicker(message, e.currentTarget.getBoundingClientRect())
          }
          aria-label="Add reaction"
          title="Add reaction"
        >
          ☺
        </button>
      )}
      {props.canReply !== false && (
        <button
          type="button"
          onClick={() => actions.reply(message)}
          aria-label="Reply"
          title="Reply"
        >
          ↩
        </button>
      )}
      {(props.canEdit ?? props.isSelf) && (
        <button
          type="button"
          onClick={() => actions.startEdit(message)}
          aria-label="Edit"
          title="Edit"
        >
          ✎
        </button>
      )}
      {props.canDelete && (
        <button
          type="button"
          className="message-toolbar-delete"
          disabled={props.deleting}
          onMouseDown={(e) => {
            selectionAtPress.current = hasTextSelection()
            if (e.shiftKey) e.preventDefault()
          }}
          onClick={(e) => startDelete(e.shiftKey)}
          onKeyDown={(e) => {
            // Keyboard: Shift+Enter / Shift+Space delete immediately, like Shift+click.
            if (e.shiftKey && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              startDelete(true)
            }
          }}
          aria-label="Delete message (hold Shift to skip confirmation)"
          title="Delete — hold Shift to skip confirmation"
        >
          <TrashGlyph />
        </button>
      )}
      <button
        type="button"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          actions.openMenu(message, r.left, r.bottom + 4)
        }}
        aria-label="More"
        title="More"
      >
        ⋯
      </button>
    </div>
  )

  const className = `message${props.compact ? ' compact' : props.grouped && !message.replyTo ? ' grouped' : ''}${
    props.mentioned ? ' mentioned' : ''
  }${props.flash ? ' flash' : ''}${editing ? ' editing' : ''}${message.pinned ? ' pinned' : ''}${
    props.deleting ? ' deleting' : ''
  }${status}`

  const onContextMenu = (e: React.MouseEvent): void => {
    if (local || editing) return
    e.preventDefault()
    actions.openMenu(message, e.clientX, e.clientY)
  }

  // Each message is one Tab stop; keyboard focus reveals its toolbar (Tab again to reach it).
  const articleProps = {
    className,
    'data-message-id': message.id,
    onContextMenu,
    tabIndex: 0
  }

  if (props.compact) {
    return (
      <article {...articleProps}>
        {reply}
        <div className="message-compact-line">
          {props.showTimestamps && (
            <time className="message-compact-time" title={formatTimestamp(message.timestamp)}>
              {formatTime(message.timestamp)}
            </time>
          )}
          <AuthorName author={author} color={props.nameColor} actions={actions} />
          {author.bot && <span className="bot-tag">BOT</span>}
          <div className="message-compact-body">{content}</div>
        </div>
        {reactions}
        {failure}
        {toolbar}
      </article>
    )
  }

  if (props.grouped && !message.replyTo) {
    return (
      <article {...articleProps}>
        <time className="message-hover-time" title={formatTimestamp(message.timestamp)}>
          {formatTime(message.timestamp)}
        </time>
        <div className="message-body">
          {content}
          {reactions}
          {failure}
        </div>
        {toolbar}
      </article>
    )
  }

  return (
    <article {...articleProps}>
      {reply}
      <div className="message-main">
        <button
          type="button"
          className="message-avatar-button"
          onClick={(e) => actions.openProfile(author.id, e.currentTarget.getBoundingClientRect())}
          aria-label={`View ${author.name}’s profile`}
          tabIndex={-1}
        >
          <Avatar
            name={author.name}
            color={author.avatarColor}
            imageId={author.avatarId}
            size={40}
          />
        </button>
        <div className="message-body">
          <div className="message-meta">
            <AuthorName author={author} color={props.nameColor} actions={actions} />
            {author.bot && <span className="bot-tag">BOT</span>}
            {props.showTimestamps && (
              <time className="message-time" title={new Date(message.timestamp).toLocaleString()}>
                {formatTimestamp(message.timestamp)}
              </time>
            )}
          </div>
          {content}
          {reactions}
          {failure}
        </div>
      </div>
      {toolbar}
    </article>
  )
}

export default memo(MessageItem)
