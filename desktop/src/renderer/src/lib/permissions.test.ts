import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_PERMISSIONS, Permissions } from '../net/protocol'
import { PERMISSION_INFO, bit, hasPermission, ownerSuccessor } from './permissions'

describe('ownerSuccessor', () => {
  type Role = 'owner' | 'admin' | 'moderator' | 'member'
  const m = (
    userId: string,
    role: Role,
    joinedAt: number
  ): { userId: string; role: Role; joinedAt: number } => ({ userId, role, joinedAt })

  it('picks the highest role, then the longest-standing member, never a bot or the owner', () => {
    const members = [
      m('owner', 'owner', 0),
      m('early', 'member', 1),
      m('mod-late', 'moderator', 9),
      m('mod-early', 'moderator', 5),
      m('bot', 'admin', 2)
    ]
    const isBot = (id: string): boolean => id === 'bot'
    expect(ownerSuccessor(members, 'owner', isBot)?.userId).toBe('mod-early')
    expect(ownerSuccessor([...members, m('admin', 'admin', 10)], 'owner', isBot)?.userId).toBe(
      'admin'
    )
    expect(
      ownerSuccessor([m('owner', 'owner', 0), m('bot', 'admin', 1)], 'owner', isBot)
    ).toBeUndefined()
  })
})

describe('hasPermission', () => {
  it('checks bits and treats unknown (older server) as allowed', () => {
    const perms = Permissions.viewChannel | Permissions.sendMessages
    expect(hasPermission(perms, Permissions.sendMessages)).toBe(true)
    expect(hasPermission(perms, Permissions.attachFiles)).toBe(false)
    expect(hasPermission(perms, Permissions.viewChannel | Permissions.sendMessages)).toBe(true)
    expect(hasPermission(undefined, Permissions.manageRoles)).toBe(true)
    expect(hasPermission(0, Permissions.viewChannel)).toBe(false)
  })

  it('describes every permission bit exactly once', () => {
    const bits = PERMISSION_INFO.map((p) => bit(p.name))
    expect(new Set(bits).size).toBe(bits.length)
    expect(bits.reduce((a, b) => a | b, 0)).toBe(ALL_PERMISSIONS)
  })
})

describe('session storage', () => {
  const store = new Map<string, string>()
  const saved: unknown[] = []
  let stored: unknown = null

  beforeEach(() => {
    store.clear()
    saved.length = 0
    stored = null
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    })
    vi.stubGlobal('window', {
      d2: {
        credentials: {
          load: async () => stored,
          save: async (v: unknown) => {
            saved.push(v)
            stored = v
            return true
          },
          clear: async () => {
            stored = null
          },
          info: async () => ({ storage: 'encrypted', device: 'PC · Windows' })
        }
      }
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('moves a pre-Milestone-7 plaintext session out of localStorage into protected storage', async () => {
    const { loadSession } = await import('../net/session')
    const legacy = { token: 'a'.repeat(43), serverUrl: 'http://jetson:3001', username: 'alice' }
    store.set('d2.session', JSON.stringify(legacy))
    const session = await loadSession('http://jetson:3001')
    expect(session).toEqual(legacy)
    expect(store.has('d2.session')).toBe(false)
    expect(saved).toEqual([legacy])
  })

  it('ignores a session for a different server and clears everything on sign-out', async () => {
    const { clearSession, loadSession, saveSession } = await import('../net/session')
    await saveSession({ token: 'b'.repeat(43), serverUrl: 'http://other:3001', username: 'bob' })
    expect(await loadSession('http://jetson:3001')).toBeNull()
    store.set('d2.session', '{"token":"x"}')
    await clearSession()
    expect(stored).toBeNull()
    expect(store.has('d2.session')).toBe(false)
  })
})
