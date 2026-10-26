import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { Channel, Message, User } from '../types'
import { formatDayDivider, formatTime, formatTimestamp, isSameDay } from '../lib/format'
import Avatar from './Avatar'
import { CloseIcon, HashIcon, MembersIcon, SearchIcon, SendIcon, SmileIcon } from './Icons'

const GROUP_WINDOW_MS = 7 * 60_000
const MAX_LENGTH = 2000
const QUICK_EMOJI = ['😀', '😂', '🥹', '😎', '🤔', '🔥', '🎉', '❤️', '👍', '👀', '🍜', '🎮']

interface ChatPanelProps {
  channel: Channel
  messages: Message[]
  selfName: string
  showMembers: boolean
  compactMode: boolean
  showTimestamps: boolean
  resolveUser: (id: string) => User
  roleColor: (userId: string) => string | undefined
  onToggleMembers: () => void
  onSendMessage: (content: string) => void
}

function ChatPanel({
  channel,
  messages,
  selfName,
  showMembers,
  compactMode,
  showTimestamps,
  resolveUser,
  roleColor,
  onToggleMembers,
  onSendMessage
}: ChatPanelProps): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [search, setSearch] = useState({ channelId: channel.id, query: '' })
  const [emojiOpen, setEmojiOpen] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const draft = drafts[channel.id] ?? ''
  const query = search.channelId === channel.id ? search.query : ''
  const trimmedQuery = query.trim().toLowerCase()

  const visibleMessages = useMemo(
    () =>
      trimmedQuery
        ? messages.filter(
            (m) =>
              m.content.toLowerCase().includes(trimmedQuery) ||
              resolveUser(m.authorId).name.toLowerCase().includes(trimmedQuery)
          )
        : messages,
    [messages, trimmedQuery, resolveUser]
  )

  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [channel.id, messages.length])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
    el.focus()
  }, [channel.id])

  const setDraft = (value: string): void => {
    setDrafts((prev) => ({ ...prev, [channel.id]: value }))
  }

  const resizeInput = (): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }

  const send = (): void => {
    const content = draft.trim()
    if (!content) return
    onSendMessage(content)
    setDraft('')
    setEmojiOpen(false)
    requestAnimationFrame(resizeInput)
  }

  const insertEmoji = (emoji: string): void => {
    const el = inputRef.current
    const start = el?.selectionStart ?? draft.length
    const end = el?.selectionEnd ?? draft.length
    const next = draft.slice(0, start) + emoji + draft.slice(end)
    setDraft(next.slice(0, MAX_LENGTH))
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      const caret = start + emoji.length
      el.setSelectionRange(caret, caret)
      resizeInput()
    })
  }

  const mentionToken = `@${selfName.toLowerCase()}`
  const mentionsSelf = (m: Message): boolean => {
    const text = m.content.toLowerCase()
    return text.includes('@everyone') || (selfName.length > 0 && text.includes(mentionToken))
  }

  return (
    <main className="chat-panel">
      <header className="chat-header">
        <div className="chat-header-title">
          <HashIcon size={22} className="chat-header-hash" />
          <h2>{channel.name}</h2>
          {channel.topic && (
            <>
              <span className="chat-header-divider" />
              <span className="chat-header-topic" title={channel.topic}>
                {channel.topic}
              </span>
            </>
          )}
        </div>

        <div className="chat-header-actions">
          <button
            type="button"
            className={`icon-button header-button${showMembers ? ' selected' : ''}`}
            onClick={onToggleMembers}
            aria-pressed={showMembers}
            aria-label={showMembers ? 'Hide Member List' : 'Show Member List'}
            title={showMembers ? 'Hide Member List' : 'Show Member List'}
          >
            <MembersIcon size={22} />
          </button>
          <label className="chat-search">
            <input
              type="text"
              placeholder="Search"
              value={query}
              onChange={(e) => setSearch({ channelId: channel.id, query: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearch({ channelId: channel.id, query: '' })
              }}
              aria-label={`Search #${channel.name}`}
            />
            {query ? (
              <button
                type="button"
                className="chat-search-clear"
                onClick={() => setSearch({ channelId: channel.id, query: '' })}
                aria-label="Clear search"
              >
                <CloseIcon size={14} />
              </button>
            ) : (
              <SearchIcon size={16} />
            )}
          </label>
        </div>
      </header>

      <div className="message-scroller" ref={scrollerRef}>
        <div className="message-list">
          {!trimmedQuery && (
            <div className="channel-welcome">
              <div className="channel-welcome-icon">
                <HashIcon size={42} />
              </div>
              <h3>Welcome to #{channel.name}!</h3>
              <p>
                This is the start of the #{channel.name} channel. {channel.topic}
              </p>
            </div>
          )}

          {trimmedQuery && (
            <div className="search-summary">
              {visibleMessages.length} result{visibleMessages.length === 1 ? '' : 's'} for &ldquo;
              {query.trim()}&rdquo;
            </div>
          )}

          {visibleMessages.map((message, index) => {
            const prev = visibleMessages[index - 1]
            const newDay = !prev || !isSameDay(prev.timestamp, message.timestamp)
            const grouped =
              !compactMode &&
              !newDay &&
              !!prev &&
              prev.authorId === message.authorId &&
              message.timestamp - prev.timestamp < GROUP_WINDOW_MS
            const author = resolveUser(message.authorId)
            const nameColor = roleColor(message.authorId)
            const highlighted = mentionsSelf(message)

            return (
              <Fragment key={message.id}>
                {newDay && (
                  <div className="day-divider" role="separator">
                    <span>{formatDayDivider(message.timestamp)}</span>
                  </div>
                )}

                {compactMode ? (
                  <article className={`message compact${highlighted ? ' mentioned' : ''}`}>
                    {showTimestamps && (
                      <time
                        className="message-compact-time"
                        title={formatTimestamp(message.timestamp)}
                      >
                        {formatTime(message.timestamp)}
                      </time>
                    )}
                    <span className="message-author" style={{ color: nameColor }}>
                      {author.name}
                    </span>
                    {author.bot && <span className="bot-tag">BOT</span>}
                    <span className="message-content">{message.content}</span>
                  </article>
                ) : grouped ? (
                  <article className={`message grouped${highlighted ? ' mentioned' : ''}`}>
                    <time className="message-hover-time" title={formatTimestamp(message.timestamp)}>
                      {formatTime(message.timestamp)}
                    </time>
                    <div className="message-content">{message.content}</div>
                  </article>
                ) : (
                  <article className={`message${highlighted ? ' mentioned' : ''}`}>
                    <Avatar name={author.name} color={author.avatarColor} size={40} />
                    <div className="message-body">
                      <div className="message-meta">
                        <span className="message-author" style={{ color: nameColor }}>
                          {author.name}
                        </span>
                        {author.bot && <span className="bot-tag">BOT</span>}
                        {showTimestamps && (
                          <time className="message-time">{formatTimestamp(message.timestamp)}</time>
                        )}
                      </div>
                      <div className="message-content">{message.content}</div>
                    </div>
                  </article>
                )}
              </Fragment>
            )
          })}
        </div>
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <div className="composer-box">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            maxLength={MAX_LENGTH}
            placeholder={`Message #${channel.name}`}
            aria-label={`Message #${channel.name}`}
            onChange={(e) => {
              setDraft(e.target.value)
              resizeInput()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              } else if (e.key === 'Escape') {
                setEmojiOpen(false)
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
              disabled={!draft.trim()}
              aria-label="Send message"
              title="Send"
            >
              <SendIcon size={20} />
            </button>
          </div>

          {emojiOpen && (
            <div className="emoji-picker" role="dialog" aria-label="Emoji picker">
              {QUICK_EMOJI.map((emoji) => (
                <button key={emoji} type="button" onClick={() => insertEmoji(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="composer-hint">
          <span>
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
          </span>
          {draft.length > MAX_LENGTH - 200 && (
            <span className="composer-count">{MAX_LENGTH - draft.length}</span>
          )}
        </div>
      </form>
    </main>
  )
}

export default ChatPanel
