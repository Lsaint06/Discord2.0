import { describe, expect, it } from 'vitest'
import {
  MAX_DRAFTS,
  clearDrafts,
  draftsKey,
  loadDrafts,
  parseDrafts,
  saveDrafts,
  setDraft,
  type Drafts
} from './drafts'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v)
  }
}

describe('message drafts', () => {
  it('keeps one draft per conversation; whitespace is kept while typing but never saved', () => {
    let d: Drafts = {}
    d = setDraft(d, 'general', 'hello', 1)
    d = setDraft(d, 'dm-1', 'secret plan', 2)
    expect(d.general?.text).toBe('hello')
    expect(d['dm-1']?.text).toBe('secret plan')
    // A first space or blank line stays in the composer…
    d = setDraft(d, 'general', ' ', 3)
    expect(d.general?.text).toBe(' ')
    d = setDraft(d, 'general', '\n', 4)
    expect(d.general?.text).toBe('\n')
    // …but isn't written to disk, and clearing the box removes the draft.
    const storage = memoryStorage()
    saveDrafts('k', d, storage)
    expect(Object.keys(loadDrafts('k', storage))).toEqual(['dm-1'])
    d = setDraft(d, 'general', '', 5)
    expect(d.general).toBeUndefined()
    expect(Object.keys(d)).toEqual(['dm-1'])
    expect(parseDrafts(JSON.stringify({ a: { text: '  \n ', at: 1 } }))).toEqual({})
  })

  it('returns the same object when nothing changes (no needless saves)', () => {
    const d = setDraft({}, 'a', 'x', 1)
    expect(setDraft(d, 'a', 'x', 2)).toBe(d)
    expect(setDraft(d, 'b', '', 2)).toBe(d)
  })

  it('caps the length and the number of drafts (oldest go first)', () => {
    let d: Drafts = {}
    for (let i = 0; i < MAX_DRAFTS + 5; i++) d = setDraft(d, `c${i}`, `draft ${i}`, i)
    expect(Object.keys(d)).toHaveLength(MAX_DRAFTS)
    expect(d.c0).toBeUndefined()
    expect(d[`c${MAX_DRAFTS + 4}`]).toBeDefined()
    expect(setDraft({}, 'long', 'x'.repeat(5000), 1).long?.text).toHaveLength(2000)
  })

  it('isolates accounts and servers', () => {
    const storage = memoryStorage()
    const alice = draftsKey('https://landhoev3.duckdns.org', 'Alice')
    const bob = draftsKey('https://landhoev3.duckdns.org', 'bob')
    const aliceLan = draftsKey('http://192.168.68.65:3001', 'alice')
    expect(new Set([alice, bob, aliceLan]).size).toBe(3)
    saveDrafts(alice, setDraft({}, 'general', 'from alice', 1), storage)
    expect(loadDrafts(bob, storage)).toEqual({})
    expect(loadDrafts(aliceLan, storage)).toEqual({})
    expect(loadDrafts(alice, storage).general?.text).toBe('from alice')
    // Username case doesn't create a second store.
    expect(draftsKey('https://landhoev3.duckdns.org', 'ALICE')).toBe(alice)
  })

  it('survives a restart and is removed on sign-out', () => {
    const storage = memoryStorage()
    const key = draftsKey('https://x.example', 'u')
    saveDrafts(key, setDraft({}, 'c', 'half-written', 5), storage)
    expect(loadDrafts(key, storage)).toEqual({ c: { text: 'half-written', at: 5 } })
    saveDrafts(key, {}, storage)
    expect(storage.getItem(key)).toBeNull()
    saveDrafts(key, setDraft({}, 'c', 'again', 6), storage)
    clearDrafts(key, storage)
    expect(loadDrafts(key, storage)).toEqual({})
  })

  it('ignores corrupt or tampered storage', () => {
    expect(parseDrafts('not json')).toEqual({})
    expect(parseDrafts('[1,2]')).toEqual({})
    expect(parseDrafts('null')).toEqual({})
    expect(
      parseDrafts(
        JSON.stringify({
          ok: { text: 'fine', at: 1 },
          blank: { text: '', at: 1 },
          noTime: { text: 'x' },
          wrong: { text: 5, at: 1 },
          [`${'x'.repeat(65)}`]: { text: 'id too long', at: 1 }
        })
      )
    ).toEqual({ ok: { text: 'fine', at: 1 } })
  })
})
