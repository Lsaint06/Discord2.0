import type { ChannelType } from '../protocol.js'

export interface UserRecord {
  id: string
  username: string
  displayName: string
  avatarColor: string
  bot: boolean
  createdAt: number
}

export interface ServerRecord {
  id: string
  name: string
  color: string
  ownerId: string | null
  position: number
  createdAt: number
}

export interface ChannelRecord {
  id: string
  serverId: string
  name: string
  type: ChannelType
  topic: string | null
  category: string
  position: number
  createdAt: number
}

export interface MessageRecord {
  id: string
  channelId: string
  authorId: string
  content: string
  createdAt: number
}

export interface MessagePage {
  before?: string
  after?: string
  limit: number
}

/**
 * Storage abstraction. Every method is async so a PostgreSQL implementation
 * (e.g. using `pg` with $1-style parameters) can be dropped in without touching routes.
 */
export interface Repository {
  readonly kind: 'sqlite' | 'postgres'
  migrate(): Promise<void>
  close(): Promise<void>

  getUser(id: string): Promise<UserRecord | undefined>
  findUserByUsername(username: string): Promise<UserRecord | undefined>
  listUsers(): Promise<UserRecord[]>
  createUser(user: UserRecord): Promise<UserRecord>
  updateUser(
    id: string,
    patch: Partial<Pick<UserRecord, 'displayName' | 'avatarColor'>>
  ): Promise<UserRecord | undefined>

  createSession(tokenHash: string, userId: string, now: number): Promise<void>
  findUserBySessionHash(tokenHash: string, now: number): Promise<UserRecord | undefined>

  countServers(): Promise<number>
  listServers(): Promise<ServerRecord[]>
  listChannels(): Promise<ChannelRecord[]>
  getChannel(id: string): Promise<ChannelRecord | undefined>
  createServer(server: ServerRecord, channels: ChannelRecord[]): Promise<void>

  listMessages(channelId: string, page: MessagePage): Promise<MessageRecord[]>
  createMessage(message: Omit<MessageRecord, 'id'>): Promise<MessageRecord>
}
