import type { Message, Server, User, UserSettings } from '../types'

export const CURRENT_USER_ID = 'me'

export const users: Record<string, User> = {
  me: { id: 'me', name: 'You', avatarColor: '#6d72f6', status: 'online' },
  nova: {
    id: 'nova',
    name: 'Nova',
    avatarColor: '#e0607e',
    status: 'online',
    activity: 'Playing Stardew Valley'
  },
  kai: { id: 'kai', name: 'Kai', avatarColor: '#3ba776', status: 'online', activity: 'Coding' },
  maya: { id: 'maya', name: 'Maya', avatarColor: '#f0a43a', status: 'idle' },
  jules: {
    id: 'jules',
    name: 'Jules',
    avatarColor: '#4aa3df',
    status: 'dnd',
    activity: 'Focus mode'
  },
  remy: { id: 'remy', name: 'Remy', avatarColor: '#9b6bd6', status: 'online' },
  sage: { id: 'sage', name: 'Sage', avatarColor: '#56b3a5', status: 'offline' },
  theo: { id: 'theo', name: 'Theo', avatarColor: '#d9734e', status: 'offline' },
  piper: {
    id: 'piper',
    name: 'Piper',
    avatarColor: '#c4579b',
    status: 'online',
    activity: 'Listening to lo-fi'
  },
  orbit: {
    id: 'orbit',
    name: 'Orbit',
    avatarColor: '#7a869a',
    status: 'online',
    bot: true,
    activity: 'Watching the server'
  }
}

export const initialServers: Server[] = [
  {
    id: 'hangout',
    name: 'The Hangout',
    color: '#6d72f6',
    roles: [
      { id: 'admin', name: 'Admin', color: '#ef6b73' },
      { id: 'mod', name: 'Moderator', color: '#4fc38a' },
      { id: 'friend', name: 'Friends', color: '#8fb4ff' }
    ],
    members: [
      { userId: 'me', roleId: 'admin' },
      { userId: 'nova', roleId: 'mod' },
      { userId: 'kai', roleId: 'friend' },
      { userId: 'maya', roleId: 'friend' },
      { userId: 'jules', roleId: 'friend' },
      { userId: 'remy' },
      { userId: 'sage' },
      { userId: 'theo' },
      { userId: 'orbit' }
    ],
    categories: [
      {
        id: 'hangout-info',
        name: 'Information',
        channels: [
          {
            id: 'hangout-welcome',
            name: 'welcome',
            type: 'text',
            topic: 'Say hi and read the house rules.'
          },
          {
            id: 'hangout-announcements',
            name: 'announcements',
            type: 'text',
            topic: 'Server news and updates.'
          }
        ]
      },
      {
        id: 'hangout-text',
        name: 'Text Channels',
        channels: [
          {
            id: 'hangout-general',
            name: 'general',
            type: 'text',
            topic: 'Anything and everything.'
          },
          {
            id: 'hangout-memes',
            name: 'memes',
            type: 'text',
            topic: 'Low effort, high reward.'
          },
          {
            id: 'hangout-music',
            name: 'music',
            type: 'text',
            topic: 'Share what you are listening to.'
          }
        ]
      },
      {
        id: 'hangout-voice',
        name: 'Voice Channels',
        channels: [
          { id: 'hangout-lounge', name: 'Lounge', type: 'voice', voiceUsers: ['nova', 'kai'] },
          { id: 'hangout-chill', name: 'Chill Zone', type: 'voice', voiceUsers: [] },
          { id: 'hangout-afk', name: 'AFK', type: 'voice', voiceUsers: ['maya'] }
        ]
      }
    ]
  },
  {
    id: 'gamenight',
    name: 'Game Night',
    color: '#3ba776',
    roles: [
      { id: 'host', name: 'Host', color: '#f0a43a' },
      { id: 'player', name: 'Players', color: '#56b3a5' }
    ],
    members: [
      { userId: 'me', roleId: 'player' },
      { userId: 'kai', roleId: 'host' },
      { userId: 'piper', roleId: 'player' },
      { userId: 'remy', roleId: 'player' },
      { userId: 'theo' }
    ],
    categories: [
      {
        id: 'gamenight-text',
        name: 'Text Channels',
        channels: [
          {
            id: 'gamenight-lobby',
            name: 'lobby',
            type: 'text',
            topic: 'Plan the next session here.'
          },
          {
            id: 'gamenight-lfg',
            name: 'looking-for-group',
            type: 'text',
            topic: 'Need a squad? Ask here.'
          },
          {
            id: 'gamenight-clips',
            name: 'clips',
            type: 'text',
            topic: 'Post your best (and worst) moments.'
          }
        ]
      },
      {
        id: 'gamenight-voice',
        name: 'Voice Channels',
        channels: [
          {
            id: 'gamenight-squad',
            name: 'Squad Up',
            type: 'voice',
            voiceUsers: ['piper', 'remy']
          },
          { id: 'gamenight-duo', name: 'Duo Queue', type: 'voice', voiceUsers: [] }
        ]
      }
    ]
  },
  {
    id: 'studyhall',
    name: 'Study Hall',
    color: '#f0a43a',
    roles: [{ id: 'tutor', name: 'Tutors', color: '#9b6bd6' }],
    members: [
      { userId: 'me' },
      { userId: 'jules', roleId: 'tutor' },
      { userId: 'maya' },
      { userId: 'sage' }
    ],
    categories: [
      {
        id: 'studyhall-text',
        name: 'Text Channels',
        channels: [
          {
            id: 'studyhall-homework',
            name: 'homework-help',
            type: 'text',
            topic: 'Ask questions, share resources.'
          },
          {
            id: 'studyhall-resources',
            name: 'resources',
            type: 'text',
            topic: 'Useful links and notes.'
          }
        ]
      },
      {
        id: 'studyhall-voice',
        name: 'Voice Channels',
        channels: [
          {
            id: 'studyhall-focus',
            name: 'Focus Room',
            type: 'voice',
            voiceUsers: ['jules']
          }
        ]
      }
    ]
  },
  {
    id: 'pixel',
    name: 'Pixel Art Club',
    color: '#e0607e',
    roles: [{ id: 'artist', name: 'Artists', color: '#e0607e' }],
    members: [
      { userId: 'me', roleId: 'artist' },
      { userId: 'nova', roleId: 'artist' },
      { userId: 'piper' }
    ],
    categories: [
      {
        id: 'pixel-text',
        name: 'Text Channels',
        channels: [
          { id: 'pixel-showcase', name: 'showcase', type: 'text', topic: 'Show off your work.' },
          { id: 'pixel-feedback', name: 'feedback', type: 'text', topic: 'Kind, honest critique.' }
        ]
      },
      {
        id: 'pixel-voice',
        name: 'Voice Channels',
        channels: [{ id: 'pixel-studio', name: 'Studio', type: 'voice', voiceUsers: [] }]
      }
    ]
  }
]

const MINUTE = 60_000
const now = Date.now()

type SeedMessage = [authorId: string, content: string, minutesAgo: number]

const seed: Record<string, SeedMessage[]> = {
  'hangout-welcome': [
    ['orbit', 'Welcome to The Hangout! Be kind, have fun, and keep it friendly.', 60 * 72],
    ['nova', 'Glad you all made it over here 🎉', 60 * 71],
    ['kai', 'This feels so much cozier than the old group chat.', 60 * 70]
  ],
  'hangout-announcements': [
    ['me', 'Movie night is this Friday at 8pm. Bring snacks!', 60 * 26],
    ['orbit', 'Reminder: voice channels are open 24/7.', 60 * 5]
  ],
  'hangout-general': [
    ['nova', 'Morning everyone ☀️', 60 * 3],
    ['kai', 'morning! anyone up for some co-op later?', 60 * 3 - 2],
    ['kai', 'I was thinking maybe around 7?', 60 * 3 - 1],
    ['maya', 'I am in, but I might be a bit late', 60 * 2],
    ['jules', 'Same, finishing up a project first.', 95],
    ['remy', 'Did anyone try that new ramen place downtown?', 40],
    ['nova', 'Yes!! The spicy miso is incredible.', 38],
    ['remy', 'Okay I know where I am getting dinner tonight 🍜', 37],
    ['kai', 'Count me in for 7 then. I will set up the lobby.', 12]
  ],
  'hangout-memes': [
    ['remy', 'me: I will sleep early tonight\nalso me at 3am: one more episode', 60 * 20],
    ['nova', 'too real', 60 * 20 - 3],
    ['kai', 'This channel is a cry for help and I love it', 60 * 5]
  ],
  'hangout-music': [
    ['maya', 'Current loop: dreamy synthwave all day.', 60 * 9],
    ['jules', 'Drop a playlist link when you get a chance!', 60 * 8]
  ],
  'gamenight-lobby': [
    ['kai', 'Next game night: Saturday. Vote on the game below 👇', 60 * 30],
    ['piper', 'Party game please, I want chaos', 60 * 29],
    ['remy', 'Seconding chaos', 60 * 29 - 5],
    ['me', 'Chaos it is.', 60 * 28]
  ],
  'gamenight-lfg': [['piper', 'Need one more for a ranked match tonight!', 50]],
  'gamenight-clips': [
    ['remy', 'I will never live down that jump. Never.', 60 * 4],
    ['kai', 'It is pinned forever now.', 60 * 4 - 1]
  ],
  'studyhall-homework': [
    ['maya', 'Can someone explain recursion one more time?', 60 * 6],
    [
      'jules',
      'Sure! A function that solves a problem by calling itself on a smaller piece of it, until it hits a base case.',
      60 * 6 - 4
    ],
    ['maya', 'Oh that actually clicks now, thank you!', 60 * 6 - 6]
  ],
  'studyhall-resources': [['jules', 'Pinned a list of free textbooks in here.', 60 * 50]],
  'pixel-showcase': [
    ['nova', 'Finished my 32x32 cat sprite! Feedback welcome.', 60 * 10],
    ['piper', 'The shading on the ears is so good', 60 * 9]
  ]
}

export const initialMessages: Record<string, Message[]> = Object.fromEntries(
  Object.entries(seed).map(([channelId, list]) => [
    channelId,
    list.map(([authorId, content, minutesAgo], index) => ({
      id: `${channelId}-seed-${index}`,
      channelId,
      authorId,
      content,
      timestamp: now - minutesAgo * MINUTE
    }))
  ])
)

export const initialUnread = ['hangout-memes', 'gamenight-lfg', 'pixel-showcase']

/** Channel each server opens to on first visit. */
export const defaultChannelByServer: Record<string, string> = {
  hangout: 'hangout-general',
  gamenight: 'gamenight-lobby',
  studyhall: 'studyhall-homework',
  pixel: 'pixel-showcase'
}

export const defaultSettings: UserSettings = {
  displayName: 'You',
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
