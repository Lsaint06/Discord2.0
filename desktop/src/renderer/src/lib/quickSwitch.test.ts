import { describe, expect, it } from 'vitest'
import { pushVisit, rankSwitchItems, type SwitchItem } from './quickSwitch'

const items: SwitchItem[] = [
  { id: 'c-general', kind: 'text', name: 'general', context: 'The Hangout' },
  { id: 'c-gaming', kind: 'text', name: 'gaming-news', context: 'Game Night' },
  { id: 'c-art', kind: 'text', name: 'pixel-art', context: 'Pixel Art Club', unread: true },
  { id: 'c-lounge', kind: 'voice', name: 'Lounge', context: 'The Hangout' },
  { id: 'dm-ann', kind: 'dm', name: 'Ann Lee', context: 'Direct message' },
  { id: 'g-1', kind: 'group', name: 'Weekend plans', context: 'Group' },
  { id: 'server:hangout', kind: 'server', name: 'The Hangout', context: 'Server' },
  { id: 'c-cafe', kind: 'text', name: 'Café', context: 'Study Hall' }
]
const ids = (list: SwitchItem[]): string[] => list.map((i) => i.id)

describe('quick switcher ranking', () => {
  it('prefers prefix, then word prefix, then substring, then letters in order', () => {
    expect(ids(rankSwitchItems(items, 'ga'))[0]).toBe('c-gaming')
    expect(ids(rankSwitchItems(items, 'art'))).toEqual(['c-art'])
    expect(ids(rankSwitchItems(items, 'news'))).toEqual(['c-gaming'])
    expect(ids(rankSwitchItems(items, 'gnrl'))).toEqual(['c-general'])
    expect(rankSwitchItems(items, 'zzz')).toEqual([])
  })

  it('matches case- and accent-insensitively', () => {
    expect(ids(rankSwitchItems(items, 'CAFE'))).toEqual(['c-cafe'])
    expect(ids(rankSwitchItems(items, 'lee'))).toEqual(['dm-ann'])
  })

  it('narrows by kind with #, !, @ and *', () => {
    expect(ids(rankSwitchItems(items, '#'))).not.toContain('dm-ann')
    expect(ids(rankSwitchItems(items, '@'))).toEqual(['dm-ann', 'g-1'])
    expect(ids(rankSwitchItems(items, '!lou'))).toEqual(['c-lounge'])
    expect(ids(rankSwitchItems(items, '*hang'))).toEqual(['server:hangout'])
    expect(ids(rankSwitchItems(items, '#hang'))).toEqual([])
  })

  it('breaks ties with unread, then recent visits', () => {
    const a: SwitchItem = { id: 'a', kind: 'text', name: 'alpha', context: 'x' }
    const b: SwitchItem = { id: 'b', kind: 'text', name: 'alpine', context: 'x' }
    const c: SwitchItem = { id: 'c', kind: 'text', name: 'altos', context: 'x', unread: true }
    expect(ids(rankSwitchItems([a, b, c], 'al'))[0]).toBe('c')
    expect(ids(rankSwitchItems([a, b], 'al', { recent: ['b'] }))).toEqual(['b', 'a'])
  })

  it('an empty query shows recent places, then unread ones', () => {
    const result = rankSwitchItems(items, '', { recent: ['dm-ann', 'missing', 'c-general'] })
    expect(ids(result)).toEqual(['dm-ann', 'c-general', 'c-art'])
  })

  it('limits the result count', () => {
    expect(rankSwitchItems(items, 'e', { limit: 2 })).toHaveLength(2)
  })

  it('keeps a short de-duplicated visit history', () => {
    expect(pushVisit(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    expect(pushVisit(['a', 'b'], 'c', 2)).toEqual(['c', 'a'])
  })
})
