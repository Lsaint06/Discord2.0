import { describe, expect, it } from 'vitest'
import {
  addableFriends,
  applyRelationship,
  bumpConversation,
  canSend,
  conversationTitle,
  dmPartnerId,
  matchesUser,
  pendingRequestCount,
  relationshipsOfType,
  sortConversations,
  sortFriends,
  type Relationships
} from './conversations'
import { Permissions, type ApiConversation, type ApiUser } from '../net/protocol'

function user(id: string, displayName: string, status: ApiUser['status'] = 'online'): ApiUser {
  return {
    id,
    username: displayName.toLowerCase(),
    displayName,
    avatarColor: '#123456',
    bot: false,
    status,
    avatarId: null,
    bannerId: null,
    accentColor: null,
    bio: null,
    pronouns: null,
    createdAt: 0,
    customStatus: null
  }
}

const users: Record<string, ApiUser> = {
  me: user('me', 'Me'),
  ana: user('ana', 'Ana'),
  ben: user('ben', 'Ben', 'offline'),
  cy: user('cy', 'Cy', 'idle'),
  dee: user('dee', 'Dee')
}

function conv(partial: Partial<ApiConversation> & { id: string }): ApiConversation {
  return {
    kind: 'group',
    name: null,
    ownerId: 'me',
    memberIds: ['me'],
    lastMessageId: null,
    createdAt: 0,
    permissions: Permissions.viewChannel | Permissions.sendMessages,
    ...partial
  }
}

describe('conversation titles', () => {
  it('names a DM after the other person', () => {
    const dm = conv({ id: 'd', kind: 'dm', ownerId: null, memberIds: ['me', 'ana'] })
    expect(dmPartnerId(dm, 'me')).toBe('ana')
    expect(conversationTitle(dm, users, 'me')).toBe('Ana')
  })

  it('uses the group name, or lists the other members', () => {
    expect(conversationTitle(conv({ id: 'g', name: 'Trip' }), users, 'me')).toBe('Trip')
    const three = conv({ id: 'g', memberIds: ['me', 'ana', 'ben', 'cy'] })
    expect(conversationTitle(three, users, 'me')).toBe('Ana, Ben, Cy')
    const many = conv({ id: 'g', memberIds: ['me', 'ana', 'ben', 'cy', 'dee'] })
    expect(conversationTitle(many, users, 'me')).toBe('Ana, Ben and 2 others')
    expect(conversationTitle(conv({ id: 'g', memberIds: ['me'] }), users, 'me')).toBe('Empty group')
  })

  it('never shows raw ids for people who are not loaded', () => {
    const dm = conv({ id: 'd', kind: 'dm', memberIds: ['me', 'ghost'] })
    expect(conversationTitle(dm, users, 'me')).toBe('Unknown user')
  })
})

describe('conversation order', () => {
  it('puts the newest activity first (ids compared numerically, not as text)', () => {
    const list = [
      conv({ id: 'a', lastMessageId: '9' }),
      conv({ id: 'b', lastMessageId: '10' }),
      conv({ id: 'c', lastMessageId: null, createdAt: 5 }),
      conv({ id: 'd', lastMessageId: null, createdAt: 7 })
    ]
    expect(sortConversations(list).map((c) => c.id)).toEqual(['b', 'a', 'd', 'c'])
  })

  it('moves lastMessageId forward only', () => {
    const map = { a: conv({ id: 'a', lastMessageId: '20' }) }
    expect(bumpConversation(map, 'a', '19')).toBe(map)
    expect(bumpConversation(map, 'a', '21').a.lastMessageId).toBe('21')
    expect(bumpConversation(map, 'unknown', '30')).toBe(map)
  })

  it('reports whether you can send', () => {
    expect(canSend(conv({ id: 'a' }))).toBe(true)
    expect(canSend(conv({ id: 'a', permissions: Permissions.viewChannel }))).toBe(false)
    expect(canSend(undefined)).toBe(false)
  })
})

describe('relationships', () => {
  it('applies updates and removals without needless copies', () => {
    let rels: Relationships = {}
    rels = applyRelationship(rels, 'ana', 'incoming', 1)
    expect(pendingRequestCount(rels)).toBe(1)
    const same = applyRelationship(rels, 'ana', 'incoming', 2)
    expect(same).toBe(rels)
    rels = applyRelationship(rels, 'ana', 'friend', 3)
    expect(rels.ana).toEqual({ userId: 'ana', type: 'friend', since: 3 })
    expect(pendingRequestCount(rels)).toBe(0)
    rels = applyRelationship(rels, 'ana', null)
    expect(rels.ana).toBeUndefined()
    expect(applyRelationship(rels, 'nobody', null)).toBe(rels)
  })

  it('lists by type, newest first', () => {
    const rels: Relationships = {
      ana: { userId: 'ana', type: 'friend', since: 1 },
      ben: { userId: 'ben', type: 'friend', since: 5 },
      cy: { userId: 'cy', type: 'blocked', since: 2 }
    }
    expect(relationshipsOfType(rels, 'friend').map((r) => r.userId)).toEqual(['ben', 'ana'])
    expect(relationshipsOfType(rels, 'blocked').map((r) => r.userId)).toEqual(['cy'])
  })

  it('sorts friends online first, then by name', () => {
    expect(sortFriends(['ben', 'dee', 'ana', 'cy'], users)).toEqual(['ana', 'cy', 'dee', 'ben'])
  })

  it('offers only friends who are not already in the group', () => {
    const rels: Relationships = {
      ana: { userId: 'ana', type: 'friend', since: 1 },
      ben: { userId: 'ben', type: 'friend', since: 1 },
      cy: { userId: 'cy', type: 'outgoing', since: 1 },
      dee: { userId: 'dee', type: 'blocked', since: 1 }
    }
    expect(addableFriends(rels, users, ['me', 'ben'])).toEqual(['ana'])
  })

  it('filters by display name or username, case-insensitively', () => {
    expect(matchesUser(users.ana, 'AN')).toBe(true)
    expect(matchesUser(users.ana, 'zz')).toBe(false)
    expect(matchesUser(users.ana, '  ')).toBe(true)
    expect(matchesUser(undefined, 'a')).toBe(false)
  })
})
