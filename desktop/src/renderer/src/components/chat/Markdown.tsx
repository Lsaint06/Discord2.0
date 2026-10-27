import { memo, useMemo, useState, type ReactNode } from 'react'
import {
  highlightCode,
  parseMarkdown,
  splitMatches,
  type Block,
  type Inline
} from '../../chat/markdown'

interface MarkdownProps {
  content: string
  /** In-app jump for discord2:// message links. */
  onJump?: (channelId: string, messageId: string) => void
  /** Words to highlight (search results). */
  highlight?: string[]
  /** Lower-cased "@name" of the current user, highlighted as a self-mention. */
  selfMention?: string
}

function Spoiler({ children }: { children: ReactNode }): React.JSX.Element {
  const [shown, setShown] = useState(false)
  return (
    <span
      className={`md-spoiler${shown ? ' shown' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={shown ? undefined : 'Spoiler, click to reveal'}
      onClick={() => setShown(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') setShown(true)
      }}
    >
      {children}
    </span>
  )
}

function Text({ text, highlight }: { text: string; highlight?: string[] }): React.JSX.Element {
  if (!highlight?.length) return <>{text}</>
  return (
    <>
      {splitMatches(text, highlight).map(([part, match], i) =>
        match ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>
      )}
    </>
  )
}

function renderInline(nodes: Inline[], props: MarkdownProps): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return <Text key={i} text={node.text} highlight={props.highlight} />
      case 'br':
        return <br key={i} />
      case 'code':
        return (
          <code key={i} className="md-inline-code">
            {node.text}
          </code>
        )
      case 'bold':
        return <strong key={i}>{renderInline(node.children, props)}</strong>
      case 'italic':
        return <em key={i}>{renderInline(node.children, props)}</em>
      case 'underline':
        return <u key={i}>{renderInline(node.children, props)}</u>
      case 'strike':
        return <s key={i}>{renderInline(node.children, props)}</s>
      case 'spoiler':
        return <Spoiler key={i}>{renderInline(node.children, props)}</Spoiler>
      case 'mention': {
        const self = props.selfMention && node.text.toLowerCase() === props.selfMention
        return (
          <span key={i} className={`md-mention${self ? ' self' : ''}`}>
            {node.text}
          </span>
        )
      }
      case 'link':
        // target=_blank: the main process opens http(s) links in the system browser.
        return (
          <a key={i} href={node.href} target="_blank" rel="noreferrer noopener" title={node.href}>
            {node.text}
          </a>
        )
      case 'messageLink':
        return (
          <button
            key={i}
            type="button"
            className="md-message-link"
            onClick={() => props.onJump?.(node.channelId, node.messageId)}
            title="Jump to message"
          >
            ↪ message
          </button>
        )
    }
  })
}

function CodeBlock({ lang, code }: { lang: string; code: string }): React.JSX.Element {
  const tokens = useMemo(() => highlightCode(code, lang), [code, lang])
  const [copied, setCopied] = useState(false)
  return (
    <div className="md-codeblock">
      <button
        type="button"
        className="md-code-copy"
        onClick={() =>
          void navigator.clipboard.writeText(code).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre>
        <code data-lang={lang || undefined}>
          {tokens.map((t, i) =>
            t.kind === 'plain' ? (
              <span key={i}>{t.text}</span>
            ) : (
              <span key={i} className={`tok-${t.kind}`}>
                {t.text}
              </span>
            )
          )}
        </code>
      </pre>
    </div>
  )
}

function renderBlocks(blocks: Block[], props: MarkdownProps): ReactNode[] {
  return blocks.map((block, i) => {
    switch (block.type) {
      case 'paragraph':
        return (
          <div key={i} className="md-paragraph">
            {renderInline(block.children, props)}
          </div>
        )
      case 'codeblock':
        return <CodeBlock key={i} lang={block.lang} code={block.code} />
      case 'quote':
        return (
          <blockquote key={i} className="md-quote">
            {renderBlocks(block.children, props)}
          </blockquote>
        )
    }
  })
}

/** Safe Markdown rendering (React elements only; see chat/markdown.ts). */
function Markdown(props: MarkdownProps): React.JSX.Element {
  const blocks = useMemo(() => parseMarkdown(props.content), [props.content])
  return <>{renderBlocks(blocks, props)}</>
}

export default memo(Markdown)
