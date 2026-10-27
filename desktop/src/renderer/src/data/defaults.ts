import type { UserSettings } from '../types'

export const defaultSettings: UserSettings = {
  fontSize: 15,
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
  recentEmoji: [],
  notificationSounds: true
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
