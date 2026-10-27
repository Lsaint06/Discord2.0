/**
 * Reduced-motion rules live in CSS; these tests read the stylesheet so a later edit can't
 * silently break them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '..', 'assets', 'main.css'), 'utf8')

/** Bodies of every `@media (prefers-reduced-motion: reduce) { … }` block. */
function reducedMotionBlocks(): string[] {
  const blocks: string[] = []
  const re = /@media \(prefers-reduced-motion: reduce\) \{/g
  let match: RegExpExecArray | null
  while ((match = re.exec(css))) {
    let depth = 1
    let i = match.index + match[0].length
    const start = i
    while (depth > 0 && i < css.length) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
      i++
    }
    blocks.push(css.slice(start, i - 1))
  }
  return blocks
}

describe('reduced motion', () => {
  it('the explicit "Reduce motion" preference disables animations and transitions', () => {
    expect(css).toMatch(
      /:root\[data-reduced-motion='on'\] \*,[\s\S]*?animation-duration: 0\.01ms !important;[\s\S]*?transition-duration: 0\.01ms !important;/
    )
  })

  it('Windows\' setting applies unless the preference is "Allow all animations"', () => {
    const blocks = reducedMotionBlocks()
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      const selectors = block
        .split('}')
        .map((rule) => rule.split('{')[0]!.trim())
        .filter(Boolean)
      for (const selector of selectors) {
        for (const part of selector.split(',')) {
          expect(part.trim(), `unscoped selector in reduced-motion block: ${part}`).toMatch(
            /^:root:not\(\[data-reduced-motion='off'\]\)/
          )
        }
      }
    }
  })

  it('jump highlights stay visible (static) under reduced motion instead of vanishing', () => {
    expect(css).toMatch(
      /:root\[data-reduced-motion='on'\] \.message\.flash \{\s*animation: none !important;\s*background:/
    )
    expect(
      reducedMotionBlocks().some((b) =>
        /\.message\.flash \{\s*animation: none !important;\s*background:/.test(b)
      )
    ).toBe(true)
  })

  it('new motion uses the shared tokens and no scaling entrance animations', () => {
    for (const token of [
      '--motion-fast',
      '--motion-base',
      '--ease-out',
      '--shadow-modal',
      '--focus-ring'
    ]) {
      expect(css).toContain(`${token}:`)
    }
    const popIn = /@keyframes pop-in \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(popIn).not.toContain('scale')
    const settingsIn = /@keyframes settings-in \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(settingsIn).not.toContain('scale')
  })
})
