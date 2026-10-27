import { ALL_PERMISSIONS, Permissions, type PermissionName, type ServerRole } from '../net/protocol'

/**
 * Client-side permission helpers. They only decide which controls to show; the server checks
 * every action again (hiding a button is never the security boundary).
 */
export const hasPermission = (perms: number | undefined, bit: number): boolean =>
  ((perms ?? ALL_PERMISSIONS) & bit) === bit

export const ROLE_LABELS: Record<ServerRole, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  moderator: 'Moderator',
  member: 'Member'
}

export const ROLE_COLORS: Record<ServerRole, string | undefined> = {
  owner: '#f0b232',
  admin: '#e5545c',
  moderator: '#3ba776',
  member: undefined
}

export const PERMISSION_INFO: {
  name: PermissionName
  label: string
  description: string
  channel: boolean
}[] = [
  {
    name: 'viewChannel',
    label: 'View channels',
    description: 'See the channel and read its history.',
    channel: true
  },
  {
    name: 'sendMessages',
    label: 'Send messages',
    description: 'Post and reply in text channels.',
    channel: true
  },
  {
    name: 'attachFiles',
    label: 'Attach files',
    description: 'Upload images and files.',
    channel: true
  },
  {
    name: 'addReactions',
    label: 'Add reactions',
    description: 'React to messages.',
    channel: true
  },
  {
    name: 'pinMessages',
    label: 'Pin messages',
    description: 'Pin and unpin messages.',
    channel: true
  },
  {
    name: 'manageMessages',
    label: 'Manage messages',
    description: 'Delete other people’s messages.',
    channel: true
  },
  {
    name: 'connect',
    label: 'Connect to voice',
    description: 'Join voice channels.',
    channel: true
  },
  { name: 'speak', label: 'Speak', description: 'Use the microphone in voice.', channel: true },
  { name: 'stream', label: 'Stream', description: 'Share a screen (Go Live).', channel: true },
  {
    name: 'createInvites',
    label: 'Create invites',
    description: 'Invite people to the server.',
    channel: false
  },
  {
    name: 'manageInvites',
    label: 'Manage invites',
    description: 'See and revoke everyone’s invites.',
    channel: false
  },
  {
    name: 'kickMembers',
    label: 'Kick members',
    description: 'Remove members below their role.',
    channel: false
  },
  {
    name: 'banMembers',
    label: 'Ban members',
    description: 'Ban members below their role.',
    channel: false
  },
  {
    name: 'manageChannels',
    label: 'Manage channels',
    description: 'Create, rename and delete channels; channel permissions.',
    channel: false
  },
  {
    name: 'manageRoles',
    label: 'Manage roles',
    description: 'Change roles and permissions below their own.',
    channel: false
  },
  {
    name: 'manageServer',
    label: 'Manage server',
    description: 'Rename the server and view its audit log.',
    channel: false
  }
]

export const bit = (name: PermissionName): number => Permissions[name]
