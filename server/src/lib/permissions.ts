import type { ChannelRecord, MessageRecord, UserRecord } from '../db/repository.js'

/**
 * Who may do what. Today there are no server memberships or roles: every signed-in user can see
 * every server (and with DEV_AUTH, anyone on the LAN can sign in as anyone). Every route asks
 * this one module, so real roles can be introduced later without touching the routes.
 *
 * Development policy:
 * - read/post: any signed-in user, text channels only
 * - edit/delete: the message author only
 * - pin/unpin: any signed-in non-bot user
 */
export const permissions = {
  canReadChannel(_user: UserRecord, channel: ChannelRecord): boolean {
    return channel.type === 'text'
  },
  canPost(user: UserRecord, channel: ChannelRecord): boolean {
    return channel.type === 'text' && !user.bot
  },
  canEditMessage(user: UserRecord, message: MessageRecord): boolean {
    return message.authorId === user.id
  },
  canDeleteMessage(user: UserRecord, message: MessageRecord): boolean {
    return message.authorId === user.id
  },
  canPin(user: UserRecord, channel: ChannelRecord): boolean {
    return channel.type === 'text' && !user.bot
  },
  canReact(user: UserRecord, channel: ChannelRecord): boolean {
    return channel.type === 'text' && !user.bot
  }
}
