import type { UserSettings } from '../types'

export const defaultSettings: UserSettings = {
  status: 'online',
  customStatus: '',
  compactMode: false,
  showTimestamps: true,
  fontSize: 15,
  accentColor: '#6d72f6',
  inputVolume: 80,
  outputVolume: 100,
  desktopNotifications: true,
  notificationSounds: true
}

export const accentChoices = ['#6d72f6', '#3ba776', '#e0607e', '#f0a43a', '#4aa3df', '#9b6bd6']
