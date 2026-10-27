import { describe, expect, it } from 'vitest'
import {
  highlightCode,
  inlineText,
  messageLink,
  parseInline,
  parseMarkdown,
  searchWords,
  splitMatches,
  type Inline
} from './markdown'

/** Every node type the renderer can receive (no raw HTML node exists). */
const SAFE_TYPES = new Set([
  'text',
  'code',
  'bold',
  'italic',
  'underline',
  'strike',
  'spoiler',
  'link',
  'messageLink',
  'mention',
  'br'
])
function walk(nodes: Inline[], visit: (n: Inline) => void): void {
  for (const n of nodes) {
    visit(n)
    if ('children' in n) walk(n.children, visit)
  }
}

describe('parseInline', () => {
  it('parses basic formatting', () => {
    expect(parseInline('**bold** and *it*')).toEqual([
      { type: 'bold', children: [{ type: 'text', text: 'bold' }] },
      { type: 'text', text: ' and ' },
      { type: 'italic', children: [{ type: 'text', text: 'it' }] }
    ])
    expect(parseInline('__u__ ~~s~~ ||sp||').map((n) => n.type)).toEqual([
      'underline',
      'text',
      'strike',
      'text',
      'spoiler'
    ])
  })

  it('keeps HTML as literal text', () => {
    const src = '<img src=x onerror=alert(1)><script>alert(1)</script>'
    const nodes = parseInline(src)
    expect(nodes).toEqual([{ type: 'text', text: src }])
  })

  it('only links http(s) URLs', () => {
    const nodes = parseInline('go https://example.com/a?b=1. javascript:alert(1) file:///c:/x')
    const links = nodes.filter((n) => n.type === 'link')
    expect(links).toEqual([
      { type: 'link', href: 'https://example.com/a?b=1', text: 'https://example.com/a?b=1' }
    ])
    walk(nodes, (n) => expect(SAFE_TYPES.has(n.type)).toBe(true))
  })

  it('does not support masked links', () => {
    const nodes = parseInline('[click](https://evil.example)')
    const link = nodes.find((n) => n.type === 'link')
    // The URL is shown as-is, never hidden behind other text.
    expect(link).toMatchObject({ href: 'https://evil.example', text: 'https://evil.example' })
  })

  it('treats code spans literally', () => {
    expect(parseInline('`**not bold** https://x.y`')).toEqual([
      { type: 'code', text: '**not bold** https://x.y' }
    ])
  })

  it('leaves unclosed markers and snake_case alone', () => {
    expect(inlineText(parseInline('**open'))).toBe('**open')
    expect(parseInline('snake_case_name')).toEqual([{ type: 'text', text: 'snake_case_name' }])
    expect(parseInline('\\*escaped\\*')).toEqual([{ type: 'text', text: '*escaped*' }])
  })

  it('bounds nesting depth', () => {
    const deep = '**'.repeat(30) + 'x' + '**'.repeat(30)
    let depth = 0
    const measure = (nodes: Inline[], d: number): void => {
      for (const n of nodes) {
        depth = Math.max(depth, d)
        if ('children' in n) measure(n.children, d + 1)
      }
    }
    measure(parseInline(deep), 0)
    expect(depth).toBeLessThanOrEqual(8)
  })

  it('parses mentions and in-app message links', () => {
    const nodes = parseInline(`hey @bob see ${messageLink('general', '42')}`)
    expect(nodes.find((n) => n.type === 'mention')).toEqual({ type: 'mention', text: '@bob' })
    expect(nodes.find((n) => n.type === 'messageLink')).toMatchObject({
      channelId: 'general',
      messageId: '42'
    })
    // An @ inside a word (email) is not a mention.
    expect(parseInline('a@b.c').some((n) => n.type === 'mention')).toBe(false)
  })
})

describe('parseMarkdown', () => {
  it('parses fenced code blocks with a language', () => {
    expect(parseMarkdown('before\n```ts\nconst a = 1\n```\nafter')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'before' }] },
      { type: 'codeblock', lang: 'ts', code: 'const a = 1' },
      { type: 'paragraph', children: [{ type: 'text', text: 'after' }] }
    ])
  })

  it('treats an unclosed fence as text', () => {
    expect(parseMarkdown('```ts\nconst a')[0].type).toBe('paragraph')
  })

  it('parses quotes with limited nesting', () => {
    const blocks = parseMarkdown('> quoted **bold**\nplain')
    expect(blocks[0].type).toBe('quote')
    expect(blocks[1]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: 'plain' }] })
  })
})

describe('highlightCode', () => {
  it('tokenizes keywords, strings, numbers and comments', () => {
    const tokens = highlightCode('const s = "hi" // note\nreturn 42', 'ts')
    const kinds = tokens.filter((t) => t.kind !== 'plain').map((t) => [t.kind, t.text])
    expect(kinds).toEqual([
      ['keyword', 'const'],
      ['string', '"hi"'],
      ['comment', '// note'],
      ['keyword', 'return'],
      ['number', '42']
    ])
    expect(tokens.map((t) => t.text).join('')).toBe('const s = "hi" // note\nreturn 42')
  })

  it('only treats # as a comment in languages that use it', () => {
    expect(highlightCode('# hi', 'py')[0]).toEqual({ kind: 'comment', text: '# hi' })
    expect(highlightCode('#include', 'c').some((t) => t.kind === 'comment')).toBe(false)
  })
})

describe('search highlighting', () => {
  it('splits text into case-insensitive matches', () => {
    expect(splitMatches('Hello world, hello', ['hello'])).toEqual([
      ['Hello', true],
      [' world, ', false],
      ['hello', true]
    ])
    expect(splitMatches('a.b', ['.'])).toEqual([
      ['a', false],
      ['.', true],
      ['b', false]
    ])
    expect(splitMatches('text', [])).toEqual([['text', false]])
  })

  it('extracts search words', () => {
    expect(searchWords('"hello" OR wörld-2')).toEqual(['hello', 'OR', 'wörld', '2'])
  })
})
