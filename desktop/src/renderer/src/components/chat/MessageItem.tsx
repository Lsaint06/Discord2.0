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

export interface MessageActions {
  reply: (m: Message) => void
  startEdit: (m: Message) => void
  cancelEdit: () => void
  saveEdit: (m: Message, content: string) => Promise<string | null>
  requestDelete: (m: Message) => void
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
  const status = message.failed ? ' failed' : message.pending ? ' pending' : ''

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
      {message.content && (
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
      )}
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
          disabled={local}
        >
          <span className="reaction-emoji">{r.emoji}</span>
          <ReactionCount count={r.count} />
        </button>
      ))}
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
    <div className="message-toolbar" role="toolbar" aria-label="Message actions">
      {QUICK_REACTIONS.slice(0, 3).map((emoji) => (
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
      <button type="button" onClick={() => actions.reply(message)} aria-label="Reply" title="Reply">
        ↩
      </button>
      {props.isSelf && (
        <button
          type="button"
          onClick={() => actions.startEdit(message)}
          aria-label="Edit"
          title="Edit"
        >
          ✎
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
  }${props.flash ? ' flash' : ''}${editing ? ' editing' : ''}${message.pinned ? ' pinned' : ''}${status}`

  const onContextMenu = (e: React.MouseEvent): void => {
    if (local || editing) return
    e.preventDefault()
    actions.openMenu(message, e.clientX, e.clientY)
  }

  if (props.compact) {
    return (
      <article className={className} data-message-id={message.id} onContextMenu={onContextMenu}>
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
      <article className={className} data-message-id={message.id} onContextMenu={onContextMenu}>
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
    <article className={className} data-message-id={message.id} onContextMenu={onContextMenu}>
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
