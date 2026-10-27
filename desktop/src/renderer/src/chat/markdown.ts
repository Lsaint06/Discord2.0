/**
 * A small, safe Markdown dialect for chat (Discord-like). It produces a plain AST that is
 * rendered with React elements only — no HTML strings, no dangerouslySetInnerHTML — so user
 * content can never inject markup or scripts.
 *
 * Supported: ```code blocks```, `inline code`, **bold**, *italic* / _italic_, __underline__,
 * ~~strike~~, ||spoiler||, > quotes, auto-linked http(s) URLs, discord2:// message links,
 * @mentions. Not supported (by design): raw HTML, images from URLs, masked [text](url) links.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'; children: Inline[] }
  | { type: 'link'; href: string; text: string }
  | { type: 'messageLink'; channelId: string; messageId: string; text: string }
  | { type: 'mention'; text: string }
  | { type: 'br' }

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'codeblock'; lang: string; code: string }
  | { type: 'quote'; children: Block[] }

const URL_RE = /^https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/i
const MESSAGE_LINK_RE = /^discord2:\/\/channels\/([A-Za-z0-9_-]{1,64})\/(\d{1,19})/
const MENTION_RE = /^@[\p{L}\p{N}_.-]{1,32}/u

export function messageLink(channelId: string, messageId: string): string {
  return `discord2://channels/${channelId}/${messageId}`
}

const DELIMS: { marker: string; type: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler' }[] = [
  { marker: '**', type: 'bold' },
  { marker: '__', type: 'underline' },
  { marker: '~~', type: 'strike' },
  { marker: '||', type: 'spoiler' },
  { marker: '*', type: 'italic' },
  { marker: '_', type: 'italic' }
]

const MAX_DEPTH = 8

/** Parses inline formatting. Unclosed markers are kept as literal text. */
export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = (): void => {
    if (text) out.push({ type: 'text', text })
    text = ''
  }
  let i = 0
  while (i < src.length) {
    const rest = src.slice(i)
    const ch = src[i]

    if (ch === '\\' && i + 1 < src.length && /[\\`*_~|>@]/.test(src[i + 1])) {
      text += src[i + 1]
      i += 2
      continue
    }
    if (ch === '\n') {
      flush()
      out.push({ type: 'br' })
      i++
      continue
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ type: 'code', text: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    const internal = MESSAGE_LINK_RE.exec(rest)
    if (internal) {
      flush()
      out.push({
        type: 'messageLink',
        channelId: internal[1],
        messageId: internal[2],
        text: internal[0]
      })
      i += internal[0].length
      continue
    }
    if (ch === 'h' || ch === 'H') {
      const url = URL_RE.exec(rest)
      if (url) {
        flush()
        out.push({ type: 'link', href: url[0], text: url[0] })
        i += url[0].length
        continue
      }
    }
    if (ch === '@' && (i === 0 || /\s/.test(src[i - 1]))) {
      const mention = MENTION_RE.exec(rest)
      if (mention) {
        flush()
        out.push({ type: 'mention', text: mention[0] })
        i += mention[0].length
        continue
      }
    }
    if (depth < MAX_DEPTH) {
      const delim = DELIMS.find((d) => rest.startsWith(d.marker))
      if (delim) {
        const start = i + delim.marker.length
        const end = findClose(src, start, delim.marker)
        // `_` only formats at word boundaries (snake_case stays as-is).
        const wordOk =
          delim.marker !== '_' ||
          ((i === 0 || !/[\p{L}\p{N}]/u.test(src[i - 1])) &&
            (end + 1 >= src.length || !/[\p{L}\p{N}]/u.test(src[end + 1])))
        if (end > start && wordOk && src[start] !== ' ') {
          flush()
          out.push({ type: delim.type, children: parseInline(src.slice(start, end), depth + 1) })
          i = end + delim.marker.length
          continue
        }
      }
    }
    text += ch
    i++
  }
  flush()
  return out
}

function findClose(src: string, from: number, marker: string): number {
  let i = from
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2
      continue
    }
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i) {
        i = end + 1
        continue
      }
    }
    if (src.startsWith(marker, i)) {
      // For single-char markers, don't close on a doubled marker ("*" vs "**").
      if (marker.length === 1 && src[i + 1] === marker) {
        i += 2
        continue
      }
      return i
    }
    i++
  }
  return -1
}

/** Parses blocks: fenced code, quotes and paragraphs. */
export function parseMarkdown(src: string, depth = 0): Block[] {
  const blocks: Block[] = []
  const lines = src.split('\n')
  let para: string[] = []
  const flushPara = (): void => {
    if (para.length) blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^```([\w+#.-]{0,20})\s*(.*)$/.exec(line)
    if (fence) {
      // Find the closing fence (can be on the same line: ```code```).
      const sameLine = fence[2].endsWith('```') && fence[2].length > 3
      if (sameLine) {
        flushPara()
        blocks.push({
          type: 'codeblock',
          lang: '',
          code: `${fence[1]} ${fence[2].slice(0, -3)}`.trim()
        })
        continue
      }
      const end = lines.findIndex((l, j) => j > i && l.trimEnd().endsWith('```'))
      if (end > i) {
        flushPara()
        const body = [fence[2], ...lines.slice(i + 1, end), lines[end].trimEnd().slice(0, -3)]
          .filter((l, k, arr) => !(l === '' && (k === 0 || k === arr.length - 1)))
          .join('\n')
        blocks.push({ type: 'codeblock', lang: fence[1].toLowerCase(), code: body })
        i = end
        continue
      }
    }
    if (depth < 2 && /^>\s?/.test(line)) {
      flushPara()
      const quoted: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      i--
      blocks.push({ type: 'quote', children: parseMarkdown(quoted.join('\n'), depth + 1) })
      continue
    }
    para.push(line)
  }
  flushPara()
  return blocks
}

/** Plain text of inline nodes (for previews and search highlighting). */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) =>
      n.type === 'br' ? '\n' : 'children' in n ? inlineText(n.children) : 'text' in n ? n.text : ''
    )
    .join('')
}

// ---- Code highlighting (tokens only; rendered as text spans) ----

export type CodeToken = {
  kind: 'plain' | 'keyword' | 'string' | 'comment' | 'number'
  text: string
}

const KEYWORDS = new Set(
  (
    'const let var function return if else for while do switch case break continue new class ' +
    'extends import export from default async await try catch finally throw typeof instanceof ' +
    'in of true false null undefined this interface type enum public private protected static ' +
    'def elif lambda pass yield with as None True False and or not is print fn mut impl struct ' +
    'use pub match loop where SELECT FROM WHERE INSERT UPDATE DELETE JOIN ORDER BY GROUP LIMIT'
  ).split(' ')
)

const TOKEN_RE =
  /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|([A-Za-z_][A-Za-z0-9_]*)/g

export function highlightCode(code: string, lang: string): CodeToken[] {
  // Comment syntax that would misfire: '#' isn't a comment in C-like code, '--' only in SQL/Lua.
  const hashComments = [
    'py',
    'python',
    'sh',
    'bash',
    'shell',
    'ps1',
    'powershell',
    'yaml',
    'yml',
    'toml',
    'rb',
    'r'
  ].includes(lang)
  const dashComments = ['sql', 'lua'].includes(lang)
  const tokens: CodeToken[] = []
  let last = 0
  for (const m of code.matchAll(TOKEN_RE)) {
    const [whole, comment, str, num, word] = m
    let kind: CodeToken['kind'] = 'plain'
    if (comment !== undefined) {
      if (comment.startsWith('#') && !hashComments) continue
      if (comment.startsWith('--') && !dashComments) continue
      kind = 'comment'
    } else if (str !== undefined) kind = 'string'
    else if (num !== undefined) kind = 'number'
    else if (word !== undefined) kind = KEYWORDS.has(word) ? 'keyword' : 'plain'
    if (kind === 'plain') continue
    if (m.index > last) tokens.push({ kind: 'plain', text: code.slice(last, m.index) })
    tokens.push({ kind, text: whole })
    last = m.index + whole.length
  }
  if (last < code.length) tokens.push({ kind: 'plain', text: code.slice(last) })
  return tokens
}

// ---- Search highlighting ----

/** Splits text into [text, isMatch] runs for the given search words (case-insensitive). */
export function splitMatches(text: string, words: string[]): [string, boolean][] {
  const terms = words.map((w) => w.trim()).filter((w) => w.length > 0)
  if (terms.length === 0) return [[text, false]]
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${escaped.join('|')})`, 'giu')
  const out: [string, boolean][] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push([text.slice(last, m.index), false])
    out.push([m[0], true])
    last = m.index + m[0].length
  }
  if (last < text.length) out.push([text.slice(last), false])
  return out
}

export function searchWords(query: string): string[] {
  return query.match(/[\p{L}\p{N}]+/gu) ?? []
}
