import type { SoundEvent } from './sound/sounds'
import type {
  ScreenCodec,
  ScreenContentHint,
  ScreenLayering,
  ScreenProfileId
} from './media/screenProfiles'
import type {
  ApiAttachment,
  ApiCustomStatus,
  ApiMessageReference,
  ApiReaction,
  ServerRole
} from './net/protocol'

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'

export type SelectableStatus = 'online' | 'idle' | 'dnd' | 'invisible'

export interface User {
  id: string
  /** Display name. */
  name: string
  /** Permanent login name (empty for unknown users). */
  username: string
  avatarColor: string
  status: PresenceStatus
  bot?: boolean
  avatarId?: string | null
  bannerId?: string | null
  accentColor?: string | null
  bio?: string | null
  pronouns?: string | null
  createdAt?: number
  customStatus?: ApiCustomStatus | null
}

export type ChannelType = 'text' | 'voice'

export interface Channel {
  id: string
  name: string
  type: ChannelType
  topic?: string
  /** User ids of mock participants already sitting in a voice channel. */
  voiceUsers?: string[]
  /** Your effective permissions in this channel (from the server). */
  permissions?: number
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
  /** Your role and server-level permissions. */
  role?: ServerRole
  permissions?: number
  ownerId?: string | null
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
  editedAt?: number | null
  replyTo?: ApiMessageReference | null
  attachments?: ApiAttachment[]
  reactions?: ApiReaction[]
  pinned?: boolean
}

export type InputMode = 'voice-activity' | 'push-to-talk'

/**
 * Settings stored on this device only (localStorage). Account-wide preferences (theme, accent,
 * density, reduced motion, timestamps, idle timeout) live on the server: see ApiPreferences.
 */
export interface UserSettings {
  /** Chat font size in px (depends on this device's screen). */
  fontSize: number
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
  /** Include message text in OS notifications (off by default for privacy). */
  notificationPreview: boolean
  /** Channels whose desktop notifications are muted. */
  mutedChannels: Record<string, boolean>
  recentEmoji: string[]
  /** Global switch for sound effects (this device). */
  soundEffects: boolean
  /** Sound effects volume, 0–100. */
  soundVolume: number
  /** Per-event sound toggles. */
  soundEvents: Record<SoundEvent, boolean>
}
