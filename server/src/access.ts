/**
 * Authorization service: loads membership, role permissions and channel overrides and answers
 * "may this user do X here?". Every route, gateway broadcast, attachment download and LiveKit
 * grant goes through it. Non-members get "not found" (no probing of other servers' ids).
 */
import type {
  ChannelRecord,
  ConversationMemberRecord,
  ConversationRecord,
  Repository,
  ServerRecord,
  UserRecord
} from './db/repository.js'
import { DIRECT_SERVER_ID } from './db/migrations.js'
import { forbidden, notFound } from './lib/errors.js'
import { channelPermissions, has, rolePermissions } from './lib/permissions.js'
import { Permissions, type ServerRole } from './protocol.js'

/** What members of a conversation may do: chat, attach, react and pin. Nobody moderates. */
export const CONVERSATION_PERMISSIONS =
  Permissions.viewChannel |
  Permissions.sendMessages |
  Permissions.attachFiles |
  Permissions.addReactions |
  Permissions.pinMessages

export type DmBlockReason = 'blocked' | 'not_allowed' | 'unavailable'

export interface ServerAccess {
  server: ServerRecord
  role: ServerRole
  /** Server-level permissions. */
  permissions: number
}

export interface ChannelAccess {
  channel: ChannelRecord
  /** Effective permissions in this channel (0 if it can't be viewed). */
  channelPermissions: number
  /**
   * History floor: the user sees only messages with a larger id. '0' for server channels;
   * for conversation members who were added later, the newest message id when they joined.
   */
  historyFrom: string
  /** Set for direct and group conversations (which have no server). */
  conversation: ConversationRecord | null
  member: ConversationMemberRecord | null
}

export interface VisibleServer extends ServerAccess {
  channels: { channel: ChannelRecord; permissions: number }[]
}

export class AccessService {
  constructor(private readonly repo: Repository) {}

  async server(user: UserRecord, serverId: string): Promise<ServerAccess | null> {
    if (user.bot) return null
    const [server, member] = await Promise.all([
      this.repo.getServer(serverId),
      this.repo.getMember(serverId, user.id)
    ])
    if (!server || !member) return null
    const configured = (await this.repo.getRolePermissions([serverId])).get(serverId) ?? {}
    return { server, role: member.role, permissions: rolePermissions(member.role, configured) }
  }

  async channel(user: UserRecord, channelId: string): Promise<ChannelAccess | null> {
    const channel = await this.repo.getChannel(channelId)
    if (!channel) return null
    // Conversations are authorized by conversation membership only — never by a server role.
    if (channel.serverId === DIRECT_SERVER_ID) return this.conversationChannel(user, channel)
    const access = await this.server(user, channel.serverId)
    if (!access) return null
    const overrides = (await this.repo.overridesForChannels([channel.id])).get(channel.id) ?? []
    const configured = (await this.repo.getRolePermissions([channel.serverId])).get(channel.serverId) ?? {}
    return {
      channel,
      channelPermissions: channelPermissions(access.role, configured, overrides),
      historyFrom: '0',
      conversation: null,
      member: null
    }
  }

  private async conversationChannel(user: UserRecord, channel: ChannelRecord): Promise<ChannelAccess | null> {
    if (user.bot) return null
    const [conversation, member] = await Promise.all([
      this.repo.getConversation(channel.id),
      this.repo.getConversationMember(channel.id, user.id)
    ])
    if (!conversation || !member) return null
    let perms = CONVERSATION_PERMISSIONS
    if (conversation.kind === 'dm') {
      const otherId = await this.dmPartner(conversation, user.id)
      // History stays readable, but nothing new can be posted while sending isn't allowed.
      if (!otherId || (await this.dmBlockReason(user.id, otherId)) !== null) perms = Permissions.viewChannel
    }
    return { channel, channelPermissions: perms, historyFrom: member.historyFrom, conversation, member }
  }

  /** The other participant of a one-to-one conversation (from its canonical key). */
  async dmPartner(conversation: ConversationRecord, userId: string): Promise<string | null> {
    if (conversation.kind !== 'dm' || !conversation.dmKey) return null
    const [a, b] = conversation.dmKey.split(':')
    if (a === userId) return b ?? null
    if (b === userId) return a ?? null
    return null
  }

  /**
   * Why senderId may not send a direct message to ecipientId right now, or null if they may:
   * no block in either direction, and either friends or sharing a server with a recipient who
   * accepts DMs from server members.
   */
  async dmBlockReason(senderId: string, recipientId: string): Promise<DmBlockReason | null> {
    const recipient = await this.repo.getUser(recipientId)
    if (!recipient || recipient.bot || recipient.disabledAt) return 'unavailable'
    if (await this.repo.isBlockedEither(senderId, recipientId)) return 'blocked'
    if (await this.repo.areFriends(senderId, recipientId)) return null
    if (recipient.allowServerDms !== false && (await this.repo.shareServer(senderId, recipientId))) return null
    return 'not_allowed'
  }

  /** Throws 404 unless the user is a member who can view the channel, 403 if `bits` are missing. */
  async requireChannel(
    user: UserRecord,
    channelId: string,
    bits = 0,
    message = 'You don’t have permission to do that here.'
  ): Promise<ChannelAccess> {
    const access = await this.channel(user, channelId)
    if (!access || access.channelPermissions === 0) throw notFound('Channel not found')
    if (bits && !has(access.channelPermissions, bits)) throw forbidden(message, 'missing_permission')
    return access
  }

  /** Throws 404 unless the user is a member, 403 if `bits` are missing. */
  async requireServer(
    user: UserRecord,
    serverId: string,
    bits = 0,
    message = 'You don’t have permission to do that in this server.'
  ): Promise<ServerAccess> {
    const access = await this.server(user, serverId)
    if (!access) throw notFound('Server not found')
    if (bits && !has(access.permissions, bits)) throw forbidden(message, 'missing_permission')
    return access
  }

  /** Servers the user belongs to, each with only the channels they can view. */
  async visibleServers(user: UserRecord): Promise<VisibleServer[]> {
    if (user.bot) return []
    const memberships = await this.repo.membershipsForUser(user.id)
    if (memberships.length === 0) return []
    const roleOf = new Map(memberships.map((m) => [m.serverId, m.role]))
    const [servers, channels, configured] = await Promise.all([
      this.repo.listServers(),
      this.repo.listChannels(),
      this.repo.getRolePermissions([...roleOf.keys()])
    ])
    const mine = channels.filter((c) => roleOf.has(c.serverId))
    const overrides = await this.repo.overridesForChannels(mine.map((c) => c.id))
    const out: VisibleServer[] = []
    for (const server of servers) {
      const role = roleOf.get(server.id)
      if (!role) continue
      const conf = configured.get(server.id) ?? {}
      const visible = mine
        .filter((c) => c.serverId === server.id)
        .map((channel) => ({
          channel,
          permissions: channelPermissions(role, conf, overrides.get(channel.id) ?? [])
        }))
        .filter((c) => c.permissions !== 0)
      out.push({ server, role, permissions: rolePermissions(role, conf), channels: visible })
    }
    return out
  }

  /** Ids of every conversation channel the user currently belongs to. */
  async conversationChannelIds(user: UserRecord): Promise<string[]> {
    if (user.bot) return []
    return this.repo.conversationChannelIds(user.id)
  }

  /** Ids of channels (optionally of one server) where the user has View Channel. */
  async viewableChannelIds(user: UserRecord, serverId?: string, type?: 'text' | 'voice'): Promise<string[]> {
    const servers = await this.visibleServers(user)
    return servers
      .filter((s) => !serverId || s.server.id === serverId)
      .flatMap((s) => s.channels)
      .filter((c) => !type || c.channel.type === type)
      .map((c) => c.channel.id)
  }

  /**
   * Everyone who can see a channel right now (recipients of its realtime events). For events
   * about one message, pass its id: conversation members who joined after it are excluded.
   */
  async channelViewers(channel: ChannelRecord, bits = 0, messageId?: string): Promise<Set<string>> {
    if (channel.serverId === DIRECT_SERVER_ID) {
      const members = await this.repo.listConversationMembers(channel.id)
      const id = messageId === undefined ? null : BigInt(messageId)
      return new Set(
        members.filter((m) => id === null || BigInt(m.historyFrom) < id).map((m) => m.userId)
      )
    }
    const [members, configured, overrides] = await Promise.all([
      this.repo.listMembers(channel.serverId),
      this.repo.getRolePermissions([channel.serverId]),
      this.repo.overridesForChannels([channel.id])
    ])
    const conf = configured.get(channel.serverId) ?? {}
    const list = overrides.get(channel.id) ?? []
    const out = new Set<string>()
    for (const m of members) {
      const perms = channelPermissions(m.role, conf, list)
      if (perms !== 0 && (!bits || has(perms, bits))) out.add(m.userId)
    }
    return out
  }

  async serverMembers(serverId: string): Promise<Set<string>> {
    return new Set((await this.repo.listMembers(serverId)).map((m) => m.userId))
  }

  /** People who share at least one server with the user (and the user themself). */
  async presenceAudienceOf(userId: string): Promise<Set<string>> {
    return this.repo.presenceAudience(userId)
  }
}
