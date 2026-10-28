import { describe, expect, it } from 'vitest'
import {
  layoutOf,
  moveCategory,
  moveChannel,
  renameCategory,
  sameLayout,
  setChannelCategory,
  type LayoutEntry
} from './channelLayout'

const ch = (
  id: string,
  category: string,
  position: number,
  type: 'text' | 'voice' = 'text'
): { id: string; name: string; type: 'text' | 'voice'; category: string; position: number } => ({
  id,
  name: id,
  type,
  category,
  position
})
const ids = (layout: LayoutEntry[]): string => layout.map((e) => `${e.category}:${e.id}`).join(' ')

describe('channel layout', () => {
  // A typical server: a text channel created later gets the next position (after the voice one).
  const server = [
    ch('general', 'Text', 0),
    ch('lounge', 'Voice', 1, 'voice'),
    ch('memes', 'Text', 2),
    ch('games', 'Voice', 3, 'voice')
  ]

  it('groups like the sidebar: categories by first channel, channels by position', () => {
    expect(ids(layoutOf(server))).toBe('Text:general Text:memes Voice:lounge Voice:games')
  })

  it('moves channels within and across categories', () => {
    const layout = layoutOf(server)
    expect(ids(moveChannel(layout, 'memes', -1))).toBe(
      'Text:memes Text:general Voice:lounge Voice:games'
    )
    // Last in its category → first of the next one.
    expect(ids(moveChannel(layout, 'memes', 1))).toBe(
      'Text:general Voice:memes Voice:lounge Voice:games'
    )
    // First in its category → last of the previous one.
    expect(ids(moveChannel(layout, 'lounge', -1))).toBe(
      'Text:general Text:memes Text:lounge Voice:games'
    )
    // Edges are no-ops.
    expect(ids(moveChannel(layout, 'general', -1))).toBe(ids(layout))
    expect(ids(moveChannel(layout, 'games', 1))).toBe(ids(layout))
    expect(ids(moveChannel(layout, 'missing', 1))).toBe(ids(layout))
  })

  it('moves whole categories', () => {
    const layout = layoutOf(server)
    expect(ids(moveCategory(layout, 'Voice', -1))).toBe(
      'Voice:lounge Voice:games Text:general Text:memes'
    )
    expect(ids(moveCategory(layout, 'Voice', 1))).toBe(ids(layout))
  })

  it('renames and merges categories', () => {
    const layout = layoutOf(server)
    expect(ids(renameCategory(layout, 'Voice', '  Hangouts  '))).toBe(
      'Text:general Text:memes Hangouts:lounge Hangouts:games'
    )
    expect(ids(renameCategory(layout, 'Voice', 'Text'))).toBe(
      'Text:general Text:memes Text:lounge Text:games'
    )
    expect(ids(renameCategory(layout, 'Voice', '   '))).toBe(ids(layout))
  })

  it('moves a channel into another or a new category', () => {
    const layout = layoutOf(server)
    expect(ids(setChannelCategory(layout, 'general', 'Voice'))).toBe(
      'Text:memes Voice:lounge Voice:games Voice:general'
    )
    expect(ids(setChannelCategory(layout, 'lounge', 'AFK'))).toBe(
      'Text:general Text:memes Voice:games AFK:lounge'
    )
    expect(sameLayout(setChannelCategory(layout, 'lounge', 'Voice'), layout)).toBe(true)
    expect(sameLayout(moveChannel(layout, 'memes', -1), layout)).toBe(false)
  })
})
