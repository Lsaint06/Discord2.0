import { useEffect, useRef, useState } from 'react'
import type { Channel, Message, User } from '../../types'
import type { SearchParams } from '../../net/api'
import { searchWords } from '../../chat/markdown'
import { formatTimestamp } from '../../lib/format'
import Avatar from '../Avatar'
import { CloseIcon } from '../Icons'
import Markdown from './Markdown'

interface SearchPanelProps {
  channel: Channel
  serverId: string
  initialQuery: string
  users: User[]
  resolveUser: (id: string) => User
  channelName: (channelId: string) => string
  search: (params: SearchParams) => Promise<{ messages: Message[]; nextBefore: string | null }>
  describeError: (err: unknown) => string
  onJump: (message: Message) => void
  onClose: () => void
}

/** Server-side search with filters and pagination ("Load more" uses the id cursor). */
function SearchPanel(props: SearchPanelProps): React.JSX.Element {
  const [query, setQuery] = useState(props.initialQuery)
  const [scope, setScope] = useState<'channel' | 'server'>('channel')
  const [authorId, setAuthorId] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [results, setResults] = useState<Message[] | null>(null)
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const { search, describeError } = props

  const params = (before?: string): SearchParams => ({
    q: query.trim() || undefined,
    channelId: scope === 'channel' ? props.channel.id : undefined,
    serverId: scope === 'server' ? props.serverId : undefined,
    authorId: authorId || undefined,
    since: since || undefined,
    until: until || undefined,
    before,
    limit: 25
  })

  const run = async (append: boolean): Promise<void> => {
    if (!query.trim() && !authorId && !since && !until) {
      setResults(null)
      setError(null)
      return
    }
    const mySeq = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const page = await search(params(append ? (nextBefore ?? undefined) : undefined))
      if (mySeq !== seq.current) return
      setResults((prev) => (append && prev ? [...prev, ...page.messages] : page.messages))
      setNextBefore(page.nextBefore)
    } catch (err) {
      if (mySeq === seq.current) setError(describeError(err))
    } finally {
      if (mySeq === seq.current) setLoading(false)
    }
  }

  // Search as you type (debounced) and whenever filters change.
  useEffect(() => {
    const t = setTimeout(() => void run(false), 300)
    return () => clearTimeout(t)
    // run depends on the inputs listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, scope, authorId, since, until, props.channel.id])

  const words = searchWords(query)

  return (
    <aside className="search-panel" aria-label="Search messages">
      <header className="search-panel-header">
        <input
          type="search"
          className="text-input"
          autoFocus
          placeholder={`Search ${scope === 'channel' ? `#${props.channel.name}` : 'this server'}`}
          value={query}
          maxLength={100}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') props.onClose()
          }}
          aria-label="Search text"
        />
        <button
          type="button"
          className="icon-button"
          onClick={props.onClose}
          aria-label="Close search"
        >
          <CloseIcon size={18} />
        </button>
      </header>
      <div className="search-filters">
        <select
          className="text-input"
          value={scope}
          onChange={(e) => setScope(e.target.value as 'channel' | 'server')}
          aria-label="Where to search"
        >
          <option value="channel">This channel</option>
          <option value="server">Whole server</option>
        </select>
        <select
          className="text-input"
          value={authorId}
          onChange={(e) => setAuthorId(e.target.value)}
          aria-label="From user"
        >
          <option value="">From anyone</option>
          {props.users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <label>
          <span>After</span>
          <input
            type="date"
            className="text-input"
            value={since}
            onChange={(e) => setSince(e.target.value)}
          />
        </label>
        <label>
          <span>Before</span>
          <input
            type="date"
            className="text-input"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
        </label>
      </div>
      <div className="search-results" aria-live="polite">
        {error && <div className="search-status error">{error}</div>}
        {!error && results === null && (
          <div className="search-status">Type to search messages, or pick a user or date.</div>
        )}
        {!error && results?.length === 0 && !loading && (
          <div className="search-status">No results.</div>
        )}
        {results?.map((m) => {
          const author = props.resolveUser(m.authorId)
          return (
            <button
              key={m.id}
              type="button"
              className="search-result"
              onClick={() => props.onJump(m)}
            >
              <div className="search-result-meta">
                <Avatar
                  name={author.name}
                  color={author.avatarColor}
                  imageId={author.avatarId}
                  size={20}
                />
                <span className="search-result-author">{author.name}</span>
                <span className="search-result-where">#{props.channelName(m.channelId)}</span>
                <time>{formatTimestamp(m.timestamp)}</time>
              </div>
              <div className="search-result-content">
                {m.content ? (
                  <Markdown content={m.content} highlight={words} />
                ) : (
                  <em>{m.attachments?.length ?? 0} attachment(s)</em>
                )}
              </div>
            </button>
          )
        })}
        {loading && <div className="search-status">Searching…</div>}
        {nextBefore && !loading && (
          <button type="button" className="link-button search-more" onClick={() => void run(true)}>
            Load more results
          </button>
        )}
      </div>
    </aside>
  )
}

export default SearchPanel
