import { describe, expect, it } from 'vitest'
import { gifMessageContent, parseGifMessage } from './gifs'

describe('GIF messages', () => {
  it('round-trips the picker’s links', () => {
    expect(parseGifMessage(gifMessageContent('giphy', '3o7TKSjRrfIPjeiVyM'))).toEqual({
      provider: 'giphy',
      id: '3o7TKSjRrfIPjeiVyM'
    })
    expect(parseGifMessage(gifMessageContent('mock', 'mock-cat-12'))).toEqual({
      provider: 'mock',
      id: 'mock-cat-12'
    })
  })

  it('understands pasted GIPHY page links with a slug', () => {
    expect(parseGifMessage('https://giphy.com/gifs/happy-dance-3o7TKSjRrfIPjeiVyM')?.id).toBe(
      '3o7TKSjRrfIPjeiVyM'
    )
    expect(parseGifMessage('  https://giphy.com/gifs/xT9IgG50Fb7Mi0prBC \n')?.id).toBe(
      'xT9IgG50Fb7Mi0prBC'
    )
  })

  it('leaves everything else as text', () => {
    expect(parseGifMessage('look https://giphy.com/gifs/xT9IgG50Fb7Mi0prBC')).toBeNull()
    expect(parseGifMessage('http://giphy.com/gifs/xT9IgG50Fb7Mi0prBC')).toBeNull()
    expect(parseGifMessage('https://giphy.com.evil.com/gifs/xT9IgG50Fb7Mi0prBC')).toBeNull()
    expect(parseGifMessage('https://giphy.com/gifs/abc')).toBeNull()
    expect(parseGifMessage('https://gifs.invalid/../../etc')).toBeNull()
    expect(parseGifMessage('')).toBeNull()
  })
})
