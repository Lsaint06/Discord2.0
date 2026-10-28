/**
 * Conversation (DM / group) views and realtime fan-out. Each member gets their own view: the
 * newest message they can see and their own permissions (a DM they can't send to is read-only).
 */
import { CONVERSATION_PERMISSIONS } from './access.js'
import type { AppContext } from './context.js'
import type { ConversationRecord, ConversationSummary } from './db/repository.js'
import { Permissions, type ApiConversation, type RelationshipType } from './protocol.js'

async function permissionsFor(ctx: AppContext, conversation: ConversationRecord, userId: string): Promise<number> {
  if (conversation.kind !== 'dm') return CONVERSATION_PERMISSIONS
  const other = await ctx.access.dmPartner(conversation, userId)
  if (!other) return Permissions.viewChannel
  return (await ctx.access.dmBlockReason(userId, other)) === null ? CONVERSATION_PERMISSIONS : Permissions.viewChannel
}

export async function toApiConversation(
  ctx: AppContext,
  summary: ConversationSummary,
  userId: string
): Promise<ApiConversation> {
  const c = summary.conversation
  return {
    id: c.channelId,
    kind: c.kind,
    name: c.name,
    ownerId: c.kind === 'group' ? c.ownerId : null,
    memberIds: summary.memberIds,
    lastMessageId: summary.lastMessageId,
    createdAt: c.createdAt,
    permissions: await permissionsFor(ctx, c, userId)
  }
}

/** The conversation as `userId` sees it, or null if they aren't a member. */
export async function conversationFor(
  ctx: AppContext,
  channelId: string,
  userId: string
): Promise<ApiConversation | null> {
  const all = await ctx.repo.listConversationsForUser(userId, true)
  const summary = all.find((s) => s.conversation.channelId === channelId)
  return summary ? toApiConversation(ctx, summary, userId) : null
}

/** Sends every current member (or just `only`) their own up-to-date view of the conversation. */
export async function publishConversation(ctx: AppContext, channelId: string, only?: Iterable<string>): Promise<void> {
  const targets = only ? [...only] : (await ctx.repo.listConversationMembers(channelId)).map((m) => m.userId)
  for (const userId of targets) {
    const view = await conversationFor(ctx, channelId, userId)
    if (view) ctx.hub.sendToUser(userId, { op: 'conversation_update', d: view })
  }
}

/**
 * Called before a new conversation message is broadcast: members who had closed it get it back
 * in their list (a new message always reopens a conversation).
 */
export async function afterConversationMessage(ctx: AppContext, conversation: ConversationRecord): Promise<void> {
  const reopened = await ctx.repo.reopenConversation(conversation.channelId)
  if (reopened.length > 0) await publishConversation(ctx, conversation.channelId, reopened)
}

/** Every DM a pair shares is re-sent to both (e.g. after a block, unblock or friendship change). */
export async function publishDmBetween(ctx: AppContext, a: string, b: string): Promise<void> {
  const dm = await ctx.repo.findDm(a, b)
  if (dm) await publishConversation(ctx, dm.channelId, [a, b])
}

/** How `viewerId` sees their relationship with `otherId` (blocked only for the one who blocked). */
export async function relationshipView(
  ctx: AppContext,
  viewerId: string,
  otherId: string
): Promise<RelationshipType | null> {
  const list = await ctx.repo.listRelationships(viewerId)
  return list.find((r) => r.userId === otherId)?.type ?? null
}

/** Tells both people's devices how their relationship now looks to each of them. */
export async function publishRelationship(ctx: AppContext, a: string, b: string): Promise<void> {
  ctx.hub.sendToUser(a, { op: 'relationship_update', d: { userId: b, type: await relationshipView(ctx, a, b) } })
  ctx.hub.sendToUser(b, { op: 'relationship_update', d: { userId: a, type: await relationshipView(ctx, b, a) } })
}
