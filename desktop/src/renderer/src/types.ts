import type {
  ScreenCodec,
  ScreenContentHint,
  ScreenLayering,
  ScreenProfileId
} from './media/screenProfiles'

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
  /** Client-generated id used to reconcile optimistic messages with the server copy. */
  nonce?: string
  /** True while the message is being sent. */
  pending?: boolean
  /** Error text when sending failed. */
  failed?: string
}

export type InputMode = 'voice-activity' | 'push-to-talk'

export interface UserSettings {
  status: SelectableStatus
  customStatus: string
  compactMode: boolean
  showTimestamps: boolean
  fontSize: number
  accentColor: string
  /** Microphone gain, percent (0–200). */
  inputVolume: number
  /** Master playback volume, percent (0–200). */
  outputVolume: number
  /** '' = system default. */
  inputDeviceId: string
  outputDeviceId: string
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  inputMode: InputMode
  /** KeyboardEvent.code of the push-to-talk key, e.g. 'Backquote'. */
  pushToTalkKey: string
  /** Experimental: system-wide push-to-talk as a toggle (Electron globalShortcut). */
  pushToTalkGlobal: boolean
  /** Per-user playback volume, percent (0–200), keyed by user id. */
  userVolumes: Record<string, number>
  /** Per-user stream (screen-share audio) volume, percent (0–200), keyed by user id. */
  streamVolumes: Record<string, number>
  /** Automatic input sensitivity; when false, inputSensitivityDb is used as a noise gate. */
  inputSensitivityAuto: boolean
  /** Manual noise gate threshold in dBFS (-100 … 0). */
  inputSensitivityDb: number
  screenShareProfile: ScreenProfileId
  screenShareAudio: boolean
  screenShareHint: ScreenContentHint
  screenShareCodec: ScreenCodec
  /** VP9/AV1 layering: 'simulcast' (GPU-friendly L1T1) or LiveKit's 'svc' (L1T3). */
  screenShareLayering: ScreenLayering
  /** Send an extra 720p30 layer for viewers on weak connections. */
  screenShareBackupLayer: boolean
  /** Show the live stats overlay in the stream viewer by default. */
  showStreamStats: boolean
  desktopNotifications: boolean
  notificationSounds: boolean
}
