export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'

export type SelectableStatus = 'online' | 'idle' | 'dnd' | 'invisible'

export interface User {
  id: string
  name: string
  avatarColor: string
  status: PresenceStatus
  activity?: string
  bot?: boolean
}

export type ChannelType = 'text' | 'voice'

export interface Channel {
  id: string
  name: string
  type: ChannelType
  topic?: string
  /** User ids of mock participants already sitting in a voice channel. */
  voiceUsers?: string[]
}

export interface ChannelCategory {
  id: string
  name: string
  channels: Channel[]
}

export interface Role {
  id: string
  name: string
  color: string
}

export interface ServerMember {
  userId: string
  roleId?: string
}

export interface Server {
  id: string
  name: string
  color: string
  categories: ChannelCategory[]
  roles: Role[]
  members: ServerMember[]
}

export interface Message {
  id: string
  channelId: string
  authorId: string
  content: string
  timestamp: number
}

export interface UserSettings {
  displayName: string
  status: SelectableStatus
  customStatus: string
  compactMode: boolean
  showTimestamps: boolean
  fontSize: number
  accentColor: string
  inputVolume: number
  outputVolume: number
  desktopNotifications: boolean
  notificationSounds: boolean
}
