import { describe, expect, it } from 'vitest'
import {
  completeEmojiShortcode,
  emojiByName,
  findEmojiQuery,
  insertEmojiAt,
  suggestEmoji
} from './emojiAutocomplete'

describe('emoji autocomplete', () => {
  it('finds the ":query" at the caret', () => {
    expect(findEmojiQuery(':gr', 3)).toEqual({ start: 0, query: 'gr' })
    expect(findEmojiQuery('hello :Joy', 10)).toEqual({ start: 6, query: 'joy' })
    expect(findEmojiQuery('(:thumb', 7)).toEqual({ start: 1, query: 'thumb' })
  })

  it('ignores times, URLs, smileys and finished words', () => {
    expect(findEmojiQuery('meet at 10:30', 13)).toBeNull()
    expect(findEmojiQuery('see https://example.com', 23)).toBeNull()
    expect(findEmojiQuery('nice :)', 7)).toBeNull()
    expect(findEmojiQuery(':g', 2)).toBeNull() // too short
    expect(findEmojiQuery(':grin smile', 11)).toBeNull() // space ends it
    expect(findEmojiQuery('no colon', 8)).toBeNull()
  })

  it('suggests by name first, then other keywords', () => {
    const names = suggestEmoji('joy').map((e) => e.emoji)
    expect(names[0]).toBe('😂')
    expect(suggestEmoji('smile').length).toBeGreaterThan(1)
    expect(suggestEmoji('qqqq')).toEqual([])
    expect(suggestEmoji('s', 3)).toHaveLength(3)
  })

  it('inserts the emoji in place of the query with a trailing space', () => {
    expect(insertEmojiAt('hi :jo there', 3, 6, '😂', 2000)).toEqual({
      text: 'hi 😂 there',
      caret: 5
    })
    expect(insertEmojiAt('hi :jo', 3, 6, '😂', 2000)).toEqual({ text: 'hi 😂 ', caret: 6 })
  })

  it('turns a typed ":name:" into the emoji', () => {
    expect(emojiByName('joy')?.emoji).toBe('😂')
    expect(completeEmojiShortcode('so funny :joy:', 14, 2000)).toEqual({
      text: 'so funny 😂',
      caret: 11,
      emoji: '😂'
    })
    expect(completeEmojiShortcode('time 10:30:', 11, 2000)).toBeNull()
    expect(completeEmojiShortcode(':notanemoji:', 12, 2000)).toBeNull()
  })
})
