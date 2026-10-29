import type { UserSettings } from '../types'
import { DEFAULT_SOUND_EVENTS, DEFAULT_SOUND_VOLUME } from '../sound/soundPolicy'
import { DEFAULT_WALLPAPER_INTENSITY } from '../lib/wallpapers'

export const defaultSettings: UserSettings = {
  fontSize: 15,
  sidebarWidth: 240,
  contrast: 'system',
  keybinds: {},
  inputVolume: 100,
  outputVolume: 100,
  inputDeviceId: '',
  outputDeviceId: '',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  inputMode: 'voice-activity',
  pushToTalkKey: 'Backquote',
  pushToTalkGlobal: false,
  userVolumes: {},
  streamVolumes: {},
  inputSensitivityAuto: true,
  inputSensitivityDb: -50,
  screenShareProfile: 'smooth',
  screenShareAudio: true,
  screenShareHint: 'motion',
  screenShareCodec: 'h264',
  screenShareLayering: 'simulcast',
  screenShareBackupLayer: true,
  showStreamStats: false,
  desktopNotifications: true,
  notificationPreview: false,
  mutedChannels: {},
  serverNotifications: {},
  recentEmoji: [],
  soundEffects: true,
  soundVolume: DEFAULT_SOUND_VOLUME,
  soundEvents: { ...DEFAULT_SOUND_EVENTS },
  soundCategoryVolumes: {},
  soundEventVolumes: {},
  soundCustom: {},
  themeEffects: 'full',
  profileEffects: 'full',
  soundPack: 'signature',
  soundboardVolume: 70,
  chatWallpaper: null,
  chatWallpaperIntensity: DEFAULT_WALLPAPER_INTENSITY
}

export const DEFAULT_ACCENT = '#6d72f6'

export const accentChoices = [
  '#6d72f6',
  '#3ba776',
  '#e0607e',
  '#f0a43a',
  '#4aa3df',
  '#9b6bd6',
  '#56b3a5',
  '#d9734e'
]
