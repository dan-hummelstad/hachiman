// Preview fixture: the cast of the Arc mocks (docs/arc-redesign-plan.md decision 11): three
// guilds, four DMs and their message history, as plain wire data. Six small guilds and three
// more DMs fill the cluster tiles of the sidebar top.
// No stores, no client: ./stubs.ts and ./index.ts wire this into the app. See ../README.md.
import {
  DEFAULT_EVERYONE,
  Permissions,
  type Channel,
  type GuildFull,
  type Member,
  type PresenceStatus,
  type ReadyPayload,
  type Role,
  type User,
  type VoiceState
} from '@hachiman/client'
import type { MembershipEvent } from '@hachiman/crypto'
import type { ChatMessage } from '@/stores/messagesStore'
import { IMG, avatarKey } from './images'
import { ATT } from './attachments'

export const user = (id: string, username: string, avatar: string | null = null): User => ({
  id,
  username,
  avatar
})

export const ME = user('u-me', 'kestrel', avatarKey('kestrel'))
export const U = {
  marlowe: user('u-marlowe', 'marlowe', avatarKey('marlowe')),
  juniper: user('u-juniper', 'juniper', avatarKey('juniper')),
  ozzy: user('u-ozzy', 'ozzy'),
  petra: user('u-petra', 'petra_v', avatarKey('petra_v')),
  quill: user('u-quill', 'quill'),
  renata: user('u-renata', 'renata'),
  sable: user('u-sable', 'sable'),
  tobias: user('u-tobias', 'tobias'),
  vex: user('u-vex', 'vexbot', avatarKey('vexbot')),
  wren: user('u-wren', 'wren'),
  yuki: user('u-yuki', 'yuki.h', avatarKey('yuki.h'))
}

const PRESENCE: Record<string, PresenceStatus> = {
  [ME.id]: 'online',
  [U.marlowe.id]: 'online',
  [U.juniper.id]: 'online',
  [U.ozzy.id]: 'idle',
  [U.petra.id]: 'dnd',
  [U.quill.id]: 'online',
  [U.renata.id]: 'idle',
  [U.sable.id]: 'offline',
  [U.tobias.id]: 'offline',
  [U.vex.id]: 'online',
  [U.wren.id]: 'offline',
  [U.yuki.id]: 'online'
}

export const DAY = 86_400_000
export const now = Date.now()
const startOfToday = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime()
const yesterday = startOfToday - DAY
/** ISO time at `h:m` on the given day start. */
const at = (day: number, h: number, m: number, s = 0): string =>
  new Date(day + ((h * 60 + m) * 60 + s) * 1000).toISOString()
const joined = (daysAgo: number): string => new Date(now - daysAgo * DAY).toISOString()

let seq = 0
export const nextId = (p: string): string => `${p}-${(++seq).toString().padStart(4, '0')}`

export function role(
  guildId: string,
  id: string,
  name: string,
  color: number,
  position: number,
  permissions: number,
  hoist = false
): Role {
  return { id, guildId, name, color, hoist, position, permissions }
}

export function channel(
  guildId: string | null,
  id: string,
  type: Channel['type'],
  name: string | null,
  position: number,
  extra: Partial<Channel> = {}
): Channel {
  return {
    id,
    guildId,
    type,
    name,
    topic: null,
    parentId: null,
    position,
    permissionOverwrites: [],
    mlsGroupId: type === 'voice' || type === 'category' ? null : groupOf(id),
    historyVisibility:
      type === 'voice' || type === 'category' ? null : guildId ? 'shared' : 'joined',
    ...extra
  }
}

/** The fake MLS group id of a fixture channel (the stub crypto client never checks it). */
export const groupOf = (channelId: string): string => `preview-group-${channelId}`

export function member(
  guildId: string,
  u: User,
  roles: string[],
  nick: string | null = null,
  daysAgo = 120
): Member {
  return { guildId, user: u, nick, roles, joinedAt: joined(daysAgo), mute: false, deaf: false }
}

function voice(
  guildId: string,
  channelId: string,
  u: User,
  flags: Partial<VoiceState> = {}
): VoiceState {
  return {
    guildId,
    channelId,
    userId: u.id,
    sessionId: `vs-${u.id}`,
    selfMute: false,
    selfDeaf: false,
    selfStream: false,
    ...flags
  }
}

const presencesFor = (members: Member[]): { userId: string; status: PresenceStatus }[] =>
  members.map((m) => ({ userId: m.user.id, status: PRESENCE[m.user.id] ?? 'offline' }))

// Guild 1: a game squad. I own it, so every settings surface is available. The mocks show
// marlowe as Captain and me as a Shotcaller.
export const G1 = 'g-nightowls'
export const G1C = {
  text: 'c-no-text',
  voice: 'c-no-voice',
  general: 'c-no-general',
  clips: 'c-no-clips',
  lfg: 'c-no-lfg',
  patch: 'c-no-patch',
  playbook: 'c-no-playbook',
  lounge: 'c-no-lounge',
  ranked: 'c-no-ranked',
  afk: 'c-no-afk'
}
const G1R = {
  captain: 'r-no-captain',
  shotcallers: 'r-no-shotcallers',
  squad: 'r-no-squad',
  bots: 'r-no-bots'
}
const g1Members = [
  member(G1, ME, [G1R.shotcallers], null, 400),
  member(G1, U.marlowe, [G1R.captain], null, 380),
  member(G1, U.juniper, [G1R.shotcallers], 'Juni', 300),
  member(G1, U.ozzy, [G1R.squad], null, 250),
  member(G1, U.petra, [G1R.squad], null, 200),
  member(G1, U.quill, [G1R.squad], null, 150),
  member(G1, U.renata, [G1R.squad], null, 90),
  member(G1, U.sable, [G1R.squad], null, 60),
  member(G1, U.tobias, [G1R.squad], null, 45),
  member(G1, U.vex, [G1R.bots], null, 30),
  member(G1, U.wren, [], null, 12),
  member(G1, U.yuki, [G1R.squad], null, 5)
]
const guild1: GuildFull = {
  id: G1,
  name: 'Night Owls',
  icon: IMG.nightOwlsIcon,
  banner: IMG.nightOwlsBanner,
  ownerId: ME.id,
  region: 'eu-west',
  createdAt: joined(400),
  publicHistoryVisibility: 'shared',
  welcomeChannelId: G1C.general,
  roles: [
    role(G1, G1, '@everyone', 0, 0, DEFAULT_EVERYONE),
    role(G1, G1R.captain, 'Captain', 0xffc36b, 4, Permissions.ADMINISTRATOR, true),
    role(
      G1,
      G1R.shotcallers,
      'Shotcallers',
      0xff8fc4,
      3,
      Permissions.KICK_MEMBERS |
        Permissions.MANAGE_MESSAGES |
        Permissions.MUTE_MEMBERS |
        Permissions.MOVE_MEMBERS,
      true
    ),
    role(G1, G1R.squad, 'Squad', 0x7fd3ff, 2, 0, true),
    role(G1, G1R.bots, 'Bots', 0x5ee6d0, 1, Permissions.MANAGE_MESSAGES, true)
  ],
  channels: [
    channel(G1, G1C.text, 'category', 'Text channels', 0),
    channel(G1, G1C.voice, 'category', 'Voice channels', 1),
    channel(G1, G1C.general, 'text', 'general', 0, {
      parentId: G1C.text,
      topic: 'Squad chat · Scrims Thursdays 21:00 CET · availability in #lfg'
    }),
    channel(G1, G1C.lfg, 'text', 'lfg', 1, {
      parentId: G1C.text,
      topic: 'Looking for group. Rank, role, and when.'
    }),
    channel(G1, G1C.clips, 'text', 'clips', 2, {
      parentId: G1C.text,
      topic: 'Highlights only. No 40-minute VODs.'
    }),
    channel(G1, G1C.patch, 'text', 'patch-notes', 3, {
      parentId: G1C.text,
      topic: 'vexbot posts upstream patch notes here.',
      permissionOverwrites: [{ id: G1, type: 'role', allow: 0, deny: Permissions.SEND_MESSAGES }]
    }),
    channel(G1, G1C.playbook, 'pages', 'scrim-playbook', 4, {
      parentId: G1C.text,
      topic: 'Comps, callouts and the Thursday plan.'
    }),
    channel(G1, G1C.lounge, 'voice', 'Lounge', 0, { parentId: G1C.voice }),
    channel(G1, G1C.ranked, 'voice', 'Ranked queue', 1, { parentId: G1C.voice }),
    channel(G1, G1C.afk, 'voice', 'AFK', 2, { parentId: G1C.voice })
  ],
  members: g1Members,
  voiceStates: [
    voice(G1, G1C.lounge, ME),
    voice(G1, G1C.lounge, U.marlowe),
    voice(G1, G1C.lounge, U.juniper, { selfMute: true }),
    voice(G1, G1C.lounge, U.ozzy, { selfMute: true, selfDeaf: true }),
    voice(G1, G1C.ranked, U.quill, { selfStream: true })
  ],
  presences: presencesFor(g1Members),
  emojis: [
    {
      id: 'emoji-owl',
      guildId: G1,
      name: 'owl',
      key: IMG.emojiOwl,
      createdBy: ME.id,
      createdAt: '2026-01-10T12:00:00.000Z'
    },
    {
      id: 'emoji-gg',
      guildId: G1,
      name: 'gg',
      key: IMG.emojiGg,
      createdBy: ME.id,
      createdAt: '2026-01-11T12:00:00.000Z'
    }
  ]
}

// Guild 2: a dev team. I'm a plain member here (no manage perms), to show the restricted UI.
export const G2 = 'g-lattice'
export const G2C = {
  eng: 'c-la-eng',
  standup: 'c-la-standup',
  backend: 'c-la-backend',
  frontend: 'c-la-frontend',
  deploys: 'c-la-deploys',
  pairing: 'c-la-pairing',
  sync: 'c-la-sync',
  designPages: 'c-la-design-pages'
}
const G2R = { lead: 'r-la-lead', eng: 'r-la-eng', design: 'r-la-design', bots: 'r-la-bots' }
const g2Members = [
  member(G2, U.petra, [G2R.lead], 'Petra', 500),
  member(G2, ME, [G2R.eng], null, 210),
  member(G2, U.tobias, [G2R.eng], null, 180),
  member(G2, U.renata, [G2R.design], null, 160),
  member(G2, U.yuki, [G2R.eng], null, 40),
  member(G2, U.vex, [G2R.bots], null, 30)
]
const guild2: GuildFull = {
  id: G2,
  name: 'Lattice Labs',
  icon: IMG.latticeIcon,
  banner: null,
  ownerId: U.petra.id,
  region: 'us-east',
  createdAt: joined(500),
  publicHistoryVisibility: 'shared',
  welcomeChannelId: null,
  roles: [
    role(G2, G2, '@everyone', 0, 0, DEFAULT_EVERYONE),
    role(
      G2,
      G2R.lead,
      'Lead',
      0xffc36b,
      4,
      Permissions.MANAGE_CHANNELS | Permissions.MANAGE_ROLES | Permissions.KICK_MEMBERS
    ),
    role(G2, G2R.design, 'Design', 0xff8fc4, 3, 0),
    role(G2, G2R.eng, 'Engineering', 0x7fd3ff, 2, 0),
    role(G2, G2R.bots, 'Bots', 0x5ee6d0, 1, 0)
  ],
  channels: [
    channel(G2, G2C.eng, 'category', 'Engineering', 1),
    channel(G2, G2C.standup, 'text', 'standup', 0, {
      parentId: G2C.eng,
      topic: 'Async standup. Yesterday / today / blockers.'
    }),
    channel(G2, G2C.backend, 'text', 'backend', 1, {
      parentId: G2C.eng,
      topic: 'Go services, Postgres, the media plane.'
    }),
    channel(G2, G2C.frontend, 'text', 'frontend', 2, { parentId: G2C.eng, topic: null }),
    channel(G2, G2C.designPages, 'pages', 'design-pages', 3, {
      parentId: G2C.eng,
      topic: 'Specs and RFCs. Chat here, edit the page on the right.'
    }),
    // Restricted (B9): only Lead and Engineering can see it.
    channel(G2, G2C.deploys, 'text', 'deploys', 0, {
      topic: 'CI posts every prod deploy here.',
      permissionOverwrites: [
        { id: G2, type: 'role', allow: 0, deny: Permissions.VIEW_CHANNEL },
        { id: G2R.lead, type: 'role', allow: Permissions.VIEW_CHANNEL, deny: 0 },
        { id: G2R.eng, type: 'role', allow: Permissions.VIEW_CHANNEL, deny: 0 }
      ]
    }),
    channel(G2, G2C.pairing, 'voice', 'Pairing', 0, { parentId: G2C.eng }),
    channel(G2, G2C.sync, 'voice', 'Weekly sync', 1)
  ],
  members: g2Members,
  voiceStates: [
    voice(G2, G2C.pairing, U.yuki),
    voice(G2, G2C.pairing, U.renata, { selfMute: true })
  ],
  presences: presencesFor(g2Members),
  emojis: []
}

// Guild 3: a book club. Small, no categories (flat list) and no roles. juniper owns it.
export const G3 = 'g-dogear'
export const G3C = {
  reading: 'c-de-reading',
  spoilers: 'c-de-spoilers',
  recs: 'c-de-recs',
  room: 'c-de-room'
}
const g3Members = [
  member(G3, ME, [], null, 100),
  member(G3, U.wren, [], null, 100),
  member(G3, U.sable, [], 'Sable', 70),
  member(G3, U.juniper, [], null, 50),
  member(G3, U.renata, [], null, 20)
]
const guild3: GuildFull = {
  id: G3,
  name: 'Dog-ear Club',
  icon: null,
  banner: null,
  ownerId: U.juniper.id,
  region: null,
  createdAt: joined(100),
  publicHistoryVisibility: 'shared',
  welcomeChannelId: null,
  roles: [role(G3, G3, '@everyone', 0, 0, DEFAULT_EVERYONE)],
  channels: [
    channel(G3, G3C.reading, 'text', 'currently-reading', 0, {
      topic: 'October: The Left Hand of Darkness. Chapters 1 to 7 by the 14th.'
    }),
    channel(G3, G3C.spoilers, 'text', 'spoilers', 1, {
      topic: 'Past the current checkpoint only.'
    }),
    channel(G3, G3C.recs, 'text', 'recommendations', 2),
    channel(G3, G3C.room, 'voice', 'Reading room', 0)
  ],
  members: g3Members,
  voiceStates: [],
  presences: presencesFor(g3Members),
  emojis: []
}

// Six small guilds (one text channel, only me), so the guild row has a cluster tile.
const extraGuilds: GuildFull[] = [
  ['g-synth', 'Synth Garage'],
  ['g-trail', 'Trail Runners'],
  ['g-kiln', 'Kiln & Glaze'],
  ['g-chess', 'Chess Cafe'],
  ['g-ferment', 'Fermentation Lab'],
  ['g-orbit', 'Orbit Watchers']
].map(([id, name], i) => {
  const members = [member(id, ME, [], null, 30 + i)]
  return {
    id,
    name,
    icon: null,
    banner: null,
    ownerId: ME.id,
    region: null,
    createdAt: joined(30 + i),
    publicHistoryVisibility: 'shared',
    welcomeChannelId: null,
    roles: [role(id, id, '@everyone', 0, 0, DEFAULT_EVERYONE)],
    channels: [channel(id, `c-${id}-general`, 'text', 'general', 0)],
    members,
    voiceStates: [],
    presences: presencesFor(members),
    emojis: []
  }
})

export const DM1 = 'c-dm-marlowe'
export const DM2 = 'c-dm-yuki'
export const DM3 = 'c-dm-juni'
export const DM4 = 'c-dm-quill'
export const GDM1 = 'c-gdm-squad'
/** Three more DMs (no messages), so the DM row has a cluster tile. */
export const EXTRA_DMS = ['c-dm-renata', 'c-dm-sable', 'c-dm-tobias']
export const dms: Channel[] = [
  channel(null, DM1, 'dm', null, 0, { recipients: [U.marlowe] }),
  channel(null, DM2, 'dm', null, 0, { recipients: [U.yuki] }),
  channel(null, DM3, 'dm', null, 0, { recipients: [U.juniper] }),
  channel(null, DM4, 'dm', null, 0, { recipients: [U.quill] }),
  channel(null, GDM1, 'group_dm', null, 0, {
    recipients: [U.juniper, U.ozzy, U.quill],
    ownerId: U.juniper.id
  }),
  channel(null, EXTRA_DMS[0], 'dm', null, 0, { recipients: [U.renata] }),
  channel(null, EXTRA_DMS[1], 'dm', null, 0, { recipients: [U.sable] }),
  channel(null, EXTRA_DMS[2], 'dm', null, 0, { recipients: [U.tobias] })
]

function msg(
  channelId: string,
  guildId: string | null,
  author: User,
  createdAt: string,
  content: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  const id = nextId('m')
  return {
    id,
    channelId,
    guildId,
    author,
    // Yesterday is epoch 2, today epoch 3: the membership line of epoch 3 sits between them.
    groupId: groupOf(channelId),
    epoch: createdAt < new Date(startOfToday).toISOString() ? 2 : 3,
    clientMsgId: `cmid-${id}`,
    content,
    mentions: [],
    attachments: [],
    replyTo: null,
    sender: {
      userId: author.id,
      deviceId: `d-${author.id}`,
      leafIndex: 0,
      trust: 'tofu',
      membershipVerified: true
    },
    decrypt: { status: 'ok' },
    createdAt,
    editedAt: null,
    ...extra
  }
}

/** The sender of a message that came from a history bundle (§12.8.5 step 9). */
const fromBundle = (author: User): Partial<ChatMessage> => ({
  sender: {
    userId: author.id,
    deviceId: `d-${author.id}`,
    leafIndex: 0,
    trust: 'tofu',
    membershipVerified: false
  }
})

/**
 * The membership timeline of #general (§12.16): I added yuki today, then made an invite with
 * history (§12.11.4).
 */
export function fixtureMembership(): Map<string, MembershipEvent[]> {
  return new Map([
    [
      G1C.general,
      [
        {
          groupId: groupOf(G1C.general),
          channelId: G1C.general,
          epoch: 3,
          actorUserId: ME.id,
          kind: 'added',
          subjects: [{ userId: U.yuki.id, deviceId: `d-${U.yuki.id}` }]
        },
        {
          groupId: groupOf(G1C.general),
          channelId: G1C.general,
          epoch: 3,
          actorUserId: ME.id,
          kind: 'invite_with_history',
          subjects: [],
          inviteKeyId: 'JJ_yk1feTO0h_S5J6sqZRLsZV8LvC5sw55Ig_vLHXYY'
        }
      ]
    ]
  ])
}

function generalHistory(): ChatMessage[] {
  const c = G1C.general
  const y = yesterday
  const t = startOfToday
  const m = (a: User, when: string, text: string, extra?: Partial<ChatMessage>): ChatMessage =>
    msg(c, G1, a, when, text, extra)
  const list: ChatMessage[] = [
    m(U.marlowe, at(y, 18, 2), 'evening all', fromBundle(U.marlowe)),
    m(U.marlowe, at(y, 18, 2, 40), 'scrim moved to thursday, the other team had a no-show'),
    m(U.juniper, at(y, 18, 5), 'works for me'),
    m(U.ozzy, at(y, 18, 11), 'does anyone still have the strat doc? the link in the pins 404s'),
    m(U.petra, at(y, 18, 12), 'I moved it, new one is in #lfg'),
    m(U.petra, at(y, 18, 12, 30), 'and please stop editing the comp sheet without telling anyone'),
    m(U.ozzy, at(y, 18, 13), 'that was not me'),
    m(U.ozzy, at(y, 18, 13, 10), 'probably'),
    m(U.ozzy, at(y, 18, 13, 40), 'found an old export of the strat doc, for the archive', {
      attachments: [ATT.stratDoc]
    }),
    m(U.vex, at(y, 19, 0), 'Patch 7.32b is live. Notes posted in #patch-notes.'),
    m(U.quill, at(y, 19, 4), 'streaming ranked at 20:00 if anyone wants to duo'),
    m(U.yuki, at(y, 19, 6), 'I will hop in after dinner'),
    m(ME, at(y, 19, 20), 'same, give me 30 min'),
    m(U.renata, at(y, 20, 41), 'gg everyone, that last round was absurd'),
    m(U.renata, at(y, 20, 41, 30), 'clip', { attachments: [ATT.clip] }),
    m(U.marlowe, at(y, 20, 42), 'the flank at 1:40 was clean'),
    m(U.marlowe, at(y, 20, 42, 20), 'whoever called the rotate, more of that'),
    m(ME, at(y, 20, 44), 'that was juni'),
    m(U.juniper, at(y, 20, 45), 'I just yelled "left" a lot'),
    m(U.tobias, at(y, 22, 58), 'logging off, night'),
    // today
    m(U.wren, at(t, 8, 3), 'morning. is there a channel for setup help or just here?'),
    m(U.marlowe, at(t, 8, 15), 'here is fine'),
    m(U.wren, at(t, 8, 16), 'my mic keeps cutting out when I alt-tab'),
    m(
      ME,
      at(t, 8, 20),
      'check if your input sensitivity is on auto, it drops when the game grabs focus'
    ),
    m(U.wren, at(t, 8, 31), 'that was it, thank you'),
    m(U.sable, at(t, 9, 47), 'lurker checking in'),
    m(U.vex, at(t, 10, 0), 'Reminder: scrim on Thursday 21:00 CET. React in #lfg to confirm.'),
    m(
      U.petra,
      at(t, 10, 22),
      'Long one, sorry: for Thursday we are running the double-support comp again because it was the only thing that held against their dive last time, which means two people need to be comfortable on supports and I would rather we sort that out now than at 20:55 with everyone in voice arguing about who has to swap off their main.'
    ),
    m(U.juniper, at(t, 10, 25), 'I can flex support'),
    m(U.ozzy, at(t, 10, 26), 'I can too but I am bad at it'),
    m(U.petra, at(t, 10, 27), 'honest, appreciated'),
    m(U.petra, at(t, 10, 28), '', { attachments: [ATT.compA, ATT.compB, ATT.compC] }),
    m(U.quill, at(t, 10, 40), 'config for the crosshair people asked about:'),
    m(
      U.quill,
      at(t, 10, 40, 15),
      'cl_crosshair_size 2; cl_crosshair_gap -1; cl_crosshair_color 0x00ff88'
    ),
    m(U.quill, at(t, 10, 40, 30), 'and in game:', { attachments: [ATT.crosshair] }),
    m(U.yuki, at(t, 11, 3), 'what time is it in JST'),
    m(U.yuki, at(t, 11, 3, 30), 'never mind, 5am. I will watch the VOD'),
    m(U.renata, at(t, 11, 14), 'brutal'),
    m(U.sable, at(t, 11, 20), '', {
      sender: null,
      decrypt: { status: 'failed', reason: 'bad_signature' }
    }),
    m(
      U.vex,
      at(t, 11, 30),
      'Scheduled maintenance: Wed 03:00 – 03:30 UTC. Voice may drop briefly. Text chat stays up.'
    ),
    m(
      U.marlowe,
      at(t, 11, 41),
      `@${ME.username} can you set up the bracket for thursday? you have the admin on the tourney site`
    ),
    m(U.marlowe, at(t, 11, 41, 20), 'ok who is around for a few customs now', {
      attachments: [ATT.callouts]
    }),
    m(U.juniper, at(t, 11, 42), 'in lounge, bring snacks'),
    m(ME, at(t, 11, 44), 'bracket is up, link in #lfg'),
    // The page link of PAGE.playbook (fixture-pages.ts imports this file, so the id is literal).
    m(
      ME,
      at(t, 11, 45),
      'also pinned the strat doc again so it stops 404ing\n[Scrim playbook](hachiman:page/9e3a4d6c-7f5b-4a8c-9d0e-2f3a4b5c6d7e)',
      {
        pending: true,
        nonce: 'n-pending'
      }
    ),
    m(ME, at(t, 11, 46), 'did that send?', {
      pending: true,
      failed: true,
      nonce: 'n-failed',
      sendError: 'The channel keys changed while sending. Try again.'
    })
  ]
  // Juni replies to marlowe's customs call (B1).
  const customs = list.find((x) => x.content.startsWith('ok who is around'))
  const snacks = list.find((x) => x.content === 'in lounge, bring snacks')
  if (customs && snacks) snacks.replyTo = customs.clientMsgId
  return list
}

function otherHistory(): Map<string, ChatMessage[]> {
  const t = startOfToday
  const y = yesterday
  const out = new Map<string, ChatMessage[]>()
  out.set(G1C.lfg, [
    msg(G1C.lfg, G1, U.yuki, at(y, 17, 30), 'diamond 2, support/flex, free after 21:00 JST'),
    msg(G1C.lfg, G1, U.renata, at(t, 9, 12), 'thursday: in'),
    msg(G1C.lfg, G1, ME, at(t, 11, 44), 'bracket: tourney.example/nightowls-thu')
  ])
  out.set(G1C.patch, [
    msg(
      G1C.patch,
      G1,
      U.vex,
      at(y, 19, 0),
      'Patch 7.32b\n- Fixed a crash on map load\n- Reduced dash cooldown 8s to 7s'
    )
  ])
  out.set(G1C.clips, []) // empty channel state
  out.set(G2C.standup, [
    msg(
      G2C.standup,
      G2,
      U.tobias,
      at(t, 9, 1),
      'Y: finished the SSRC pool fix. T: renegotiation tests. B: none'
    ),
    msg(
      G2C.standup,
      G2,
      ME,
      at(t, 9, 14),
      'Y: transcript redesign. T: preview fixtures. B: waiting on fonts'
    ),
    msg(G2C.standup, G2, U.renata, at(t, 9, 30), 'Y: new tokens. T: light theme pass. B: none')
  ])
  out.set(G2C.backend, [
    msg(
      G2C.backend,
      G2,
      U.petra,
      at(y, 15, 2),
      'heads up: dropping the dev DB tonight, reseed after'
    ),
    msg(G2C.backend, G2, U.yuki, at(y, 15, 10), 'ack')
  ])
  out.set(G3C.reading, [
    msg(G3C.reading, G3, U.wren, at(y, 20, 0), 'chapter 4 is where it clicked for me'),
    msg(G3C.reading, G3, U.sable, at(y, 20, 9), 'the kemmer chapter? agreed'),
    msg(G3C.reading, G3, ME, at(t, 7, 50), 'I am behind, no spoilers please')
  ])
  out.set(DM1, [
    msg(DM1, null, U.marlowe, at(y, 23, 5), 'you around tomorrow morning?'),
    msg(DM1, null, ME, at(t, 7, 41), 'yeah from 8'),
    msg(
      DM1,
      null,
      U.marlowe,
      at(t, 7, 43),
      'cool, want to look at the comp sheet before petra sees it'
    ),
    msg(DM1, null, ME, at(t, 7, 44), 'ha. ok'),
    msg(DM1, null, U.marlowe, at(t, 10, 53), 'pinged you in general about the bracket btw')
  ])
  out.set(DM2, [
    msg(DM2, null, U.yuki, at(y, 12, 0), 'are you the one running the bracket?'),
    msg(DM2, null, ME, at(y, 12, 30), 'probably, why'),
    msg(DM2, null, U.yuki, at(y, 12, 31), 'can we seed by timezone so I am not playing at 5am'),
    msg(DM2, null, ME, at(y, 12, 40), 'I will try')
  ])
  out.set(DM3, [
    msg(DM3, null, ME, at(t, 11, 40), 'customs in lounge?'),
    msg(DM3, null, U.juniper, at(t, 11, 42), 'bring snacks')
  ])
  out.set(DM4, [msg(DM4, null, U.quill, at(y, 19, 5), 'streaming ranked at 20:00, duo?')])
  out.set(GDM1, [
    msg(GDM1, null, U.juniper, at(y, 20, 46), 'that last round though'),
    msg(GDM1, null, U.ozzy, at(y, 20, 47), 'gg')
  ])
  return out
}

export const READY: ReadyPayload = {
  v: 1,
  sessionId: 'preview-session',
  user: ME,
  deviceId: 'preview-device',
  guilds: [guild1, guild2, guild3, ...extraGuilds],
  privateChannels: dms,
  presences: Object.entries(PRESENCE).map(([userId, status]) => ({ userId, status })),
  readStates: []
}

/** channelId → seeded history (oldest first), including the pending/failed rows in #general. */
export function fixtureHistory(): Map<string, ChatMessage[]> {
  return new Map([[G1C.general, generalHistory()], ...otherHistory()])
}

/** Distinct users across every fixture guild. */
export const MEMBER_COUNT = new Set(READY.guilds.flatMap((g) => g.members.map((m) => m.user.id)))
  .size

/** Fixture voice quality (good, steady). */
export const QUALITY = (): {
  rttMs: number
  jitterMs: number
  packetLoss: number
  sampledAt: number
} => ({
  rttMs: 38,
  jitterMs: 4,
  packetLoss: 0.002,
  sampledAt: Date.now()
})
