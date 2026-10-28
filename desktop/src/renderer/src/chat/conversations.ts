import {
  Permissions,
  type ApiConversation,
  type ApiRelationship,
  type ApiUser,
  type RelationshipType
} from '../net/protocol'

/** activeServerId for the Home view (friends and conversations). Never a real server id. */
export const HOME_ID = '@home'

export type Relationships = Record<string, ApiRelationship>

/** The other person in a one-to-one conversation. */
export function dmPartnerId(
  conversation: ApiConversation,
  meId: string | undefined
): string | undefined {
  if (conversation.kind !== 'dm') return undefined
  return conversation.memberIds.find((id) => id !== meId) ?? conversation.memberIds[0]
}

/** Display name of a user, falling back to a neutral label for people you can't see. */
export function nameOf(users: Record<string, ApiUser>, userId: string | undefined): string {
  if (!userId) return 'Unknown user'
  return users[userId]?.displayName ?? 'Unknown user'
}

/**
 * What a conversation is called: the partner's name for a DM; for a group its name, or the other
 * members' names ("Ana, Ben and 2 others").
 */
export function conversationTitle(
  conversation: ApiConversation,
  users: Record<string, ApiUser>,
  meId: string | undefined
): string {
  if (conversation.kind === 'dm') return nameOf(users, dmPartnerId(conversation, meId))
  if (conversation.name) return conversation.name
  const others = conversation.memberIds.filter((id) => id !== meId)
  if (others.length === 0) return 'Empty group'
  const names = others.map((id) => nameOf(users, id))
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`
}

/** Newest activity first (last visible message, else creation time); ties by id for stability. */
export function sortConversations(list: ApiConversation[]): ApiConversation[] {
  const key = (c: ApiConversation): bigint => (c.lastMessageId ? BigInt(c.lastMessageId) : 0n)
  return [...list].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (ka !== kb) return ka > kb ? -1 : 1
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
    return a.id < b.id ? -1 : 1
  })
}

/** Keeps lastMessageId moving forward when a message arrives for a known conversation. */
export function bumpConversation(
  conversations: Record<string, ApiConversation>,
  channelId: string,
  messageId: string
): Record<string, ApiConversation> {
  const c = conversations[channelId]
  if (!c) return conversations
  if (c.lastMessageId && BigInt(c.lastMessageId) >= BigInt(messageId)) return conversations
  return { ...conversations, [channelId]: { ...c, lastMessageId: messageId } }
}

export function canSend(conversation: ApiConversation | undefined): boolean {
  return Boolean(conversation && (conversation.permissions & Permissions.sendMessages) !== 0)
}

/** Applies a relationship change (type null removes it). */
export function applyRelationship(
  relationships: Relationships,
  userId: string,
  type: RelationshipType | null,
  now = Date.now()
): Relationships {
  const current = relationships[userId]
  if (!type) {
    if (!current) return relationships
    const next = { ...relationships }
    delete next[userId]
    return next
  }
  if (current?.type === type) return relationships
  return { ...relationships, [userId]: { userId, type, since: now } }
}

export function relationshipsOfType(
  relationships: Relationships,
  type: RelationshipType
): ApiRelationship[] {
  return Object.values(relationships)
    .filter((r) => r.type === type)
    .sort((a, b) => b.since - a.since)
}

export function pendingRequestCount(relationships: Relationships): number {
  return relationshipsOfType(relationships, 'incoming').length
}

/** Friends sorted for display: online first, then by name. */
export function sortFriends(ids: string[], users: Record<string, ApiUser>): string[] {
  const online = (id: string): number => (users[id] && users[id].status !== 'offline' ? 0 : 1)
  return [...ids].sort(
    (a, b) =>
      online(a) - online(b) ||
      nameOf(users, a).localeCompare(nameOf(users, b), undefined, { sensitivity: 'base' })
  )
}

/** Case-insensitive filter on display name or username. */
export function matchesUser(user: ApiUser | undefined, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (!user) return false
  return user.displayName.toLowerCase().includes(q) || user.username.toLowerCase().includes(q)
}

/** Friends who could be added to a group (not already in it), in display order. */
export function addableFriends(
  relationships: Relationships,
  users: Record<string, ApiUser>,
  exclude: Iterable<string>
): string[] {
  const skip = new Set(exclude)
  const friends = relationshipsOfType(relationships, 'friend')
    .map((r) => r.userId)
    .filter((id) => !skip.has(id))
  return sortFriends(friends, users)
}
