/**
 * An ordinary discord.js 14 bot against the Discord bridge, with a fake Hachiman runtime (no
 * server, no crypto): login, READY and GUILD_CREATE, a prefix command that replies, an edit, a
 * reaction, a delete, a mention, and the events that come back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client, Events, GatewayIntentBits, type Message } from 'discord.js'
import {
  DiscordBridge,
  IdMap,
  shardOfGuild,
  type BotMessage,
  type BotRuntimeEvents,
  type BridgeRuntime,
} from '@hachiman/bot'
import { TypedEventEmitter, type Channel, type HachimanCache, type Member, type User } from '@hachiman/client'

const TOKEN = 'hbot_test-token'
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const GUILD = uuid(1)
const CHANNEL = uuid(2)
const BOT: User = { id: uuid(10), username: 'helper', avatar: null, bot: true }
const ALICE: User = {
  id: uuid(11),
  username: 'alice',
  avatar: null,
  bot: false,
}

const member = (user: User): Member => ({
  guildId: GUILD,
  user,
  nick: null,
  roles: [],
  joinedAt: '2026-01-01T00:00:00.000Z',
  mute: false,
  deaf: false,
})

class FakeRuntime extends TypedEventEmitter<BotRuntimeEvents> implements BridgeRuntime {
  user: User | null = BOT
  sent: {
    channelId: string
    text: string
    replyTo: string | null
    mentions: unknown[]
  }[] = []
  edits: { messageId: string; text: string }[] = []
  deleted: string[] = []
  reactions: { messageId: string; emoji: string; remove: boolean }[] = []
  private n = 100
  readonly messages = new Map<string, BotMessage>()
  cache = {
    user: BOT,
    guilds: new Map([
      [
        GUILD,
        {
          id: GUILD,
          name: 'Night Owls',
          icon: null,
          banner: null,
          ownerId: ALICE.id,
          region: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          publicHistoryVisibility: 'shared' as const,
          welcomeChannelId: CHANNEL,
        },
      ],
    ]),
    channels: new Map<string, Channel>([
      [
        CHANNEL,
        {
          id: CHANNEL,
          guildId: GUILD,
          type: 'text',
          name: 'general',
          topic: null,
          parentId: null,
          position: 0,
          permissionOverwrites: [],
          mlsGroupId: 'g',
          historyVisibility: 'shared',
        },
      ],
    ]),
    roles: new Map([
      [
        GUILD,
        new Map([
          [
            GUILD,
            {
              id: GUILD,
              guildId: GUILD,
              name: '@everyone',
              color: 0,
              hoist: false,
              position: 0,
              permissions: (1 << 10) | (1 << 11) | (1 << 16),
            },
          ],
        ]),
      ],
    ]),
    members: new Map([
      [
        GUILD,
        new Map([
          [BOT.id, member(BOT)],
          [ALICE.id, member(ALICE)],
        ]),
      ],
    ]),
    presences: new Map(),
  } as unknown as HachimanCache

  private row(
    author: User,
    text: string,
    replyTo: string | null = null,
    mentions: BotMessage['mentions'] = [],
  ): BotMessage {
    const id = uuid(this.n++)
    const m: BotMessage = {
      id,
      channelId: CHANNEL,
      guildId: GUILD,
      author,
      content: text,
      mentions,
      replyTo,
      createdAt: new Date().toISOString(),
      editedAt: null,
      clientMsgId: `c${id}`,
    }
    this.messages.set(id, m)
    return m
  }

  /** A message from a human arrives (decrypted). */
  incoming(text: string, mentions: BotMessage['mentions'] = []): BotMessage {
    const m = this.row(ALICE, text, null, mentions)
    this.emit('message', m)
    return m
  }

  async send(
    channelId: string,
    c: {
      text: string
      mentions?: BotMessage['mentions']
      replyTo?: string | null
    },
  ): Promise<BotMessage> {
    this.sent.push({
      channelId,
      text: c.text,
      replyTo: c.replyTo ?? null,
      mentions: c.mentions ?? [],
    })
    const m = this.row(BOT, c.text, c.replyTo ?? null, c.mentions ?? [])
    this.emit('message', m)
    return m
  }
  async edit(_channelId: string, messageId: string, c: { text: string }): Promise<BotMessage> {
    this.edits.push({ messageId, text: c.text })
    const m = {
      ...this.messages.get(messageId)!,
      content: c.text,
      editedAt: new Date().toISOString(),
    }
    this.messages.set(messageId, m)
    this.emit('messageUpdate', m)
    return m
  }
  async delete(channelId: string, messageId: string): Promise<void> {
    this.deleted.push(messageId)
    this.emit('messageDelete', { id: messageId, channelId, guildId: GUILD })
  }
  async react(channelId: string, messageId: string, emoji: string, remove = false): Promise<void> {
    this.reactions.push({ messageId, emoji, remove })
    this.emit('reaction', {
      channelId,
      guildId: GUILD,
      messageId,
      userId: BOT.id,
      emoji,
      remove,
    })
  }
  async fetchMessages(): Promise<BotMessage[]> {
    return [...this.messages.values()].reverse()
  }
  async fetchMessage(_c: string, id: string): Promise<BotMessage | null> {
    return this.messages.get(id) ?? null
  }
  async typing(): Promise<void> {}
  async openDm(): Promise<Channel> {
    throw new Error('not in this test')
  }
}

const until = <T>(fn: () => T | undefined, ms = 5000): Promise<T> =>
  new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      const v = fn()
      if (v !== undefined && v !== false) return resolve(v)
      if (Date.now() - start > ms) return reject(new Error('timed out'))
      setTimeout(tick, 10)
    }
    tick()
  })

describe('a discord.js bot on the Hachiman bridge', () => {
  let runtime: FakeRuntime
  let bridge: DiscordBridge
  let client: Client
  let ids: IdMap

  beforeEach(async () => {
    runtime = new FakeRuntime()
    ids = new IdMap()
    bridge = new DiscordBridge({ runtime, ids, token: TOKEN, log: () => {} })
    const { api } = await bridge.listen()

    // The bot as it is written for Discord. Only `rest.api` points at the bridge; the drop-in
    // package sets it in Client.login.
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      rest: { api },
    })
    client.on(Events.MessageCreate, async (message: Message) => {
      if (message.author.bot) return
      if (message.content === '!ping') {
        const reply = await message.reply('pong')
        await reply.edit('pong!')
        await reply.react('🏓')
      }
      if (message.content === '!who')
        if (message.channel.isSendable()) await message.channel.send(`hi <@${message.author.id}>`)
      if (message.content === '!bye') await message.delete()
    })
    await client.login(TOKEN)
    await until(() => client.isReady() && client.guilds.cache.size > 0)
  })

  afterEach(async () => {
    await client.destroy()
    await bridge.close()
  })

  it('sees the guild, its channel, members and the bot user', () => {
    expect(client.user?.username).toBe('helper')
    expect(client.user?.id).toBe(ids.snowflake(BOT.id))
    const guild = client.guilds.cache.first()!
    expect(guild.name).toBe('Night Owls')
    expect(guild.channels.cache.find(c => c.name === 'general')?.isTextBased()).toBe(true)
    expect(guild.ownerId).toBe(ids.snowflake(ALICE.id))
    // A snowflake carries the creation time: discord.js reads it.
    expect(guild.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('answers a command: reply, edit, react', async () => {
    const ping = runtime.incoming('!ping')
    await until(() => runtime.reactions.length > 0)
    expect(runtime.sent).toEqual([{ channelId: CHANNEL, text: 'pong', replyTo: ping.id, mentions: [] }])
    expect(runtime.edits.map(e => e.text)).toEqual(['pong!'])
    expect(runtime.reactions).toEqual([
      { messageId: runtime.edits[0]!.messageId, emoji: '🏓', remove: false },
    ])
  })

  it('turns Discord mentions into Hachiman mentions and back', async () => {
    runtime.incoming('!who')
    await until(() => runtime.sent.length > 0)
    expect(runtime.sent[0]).toMatchObject({
      text: `hi <@${ALICE.id}>`,
      mentions: [{ type: 'user', id: ALICE.id }],
    })

    const seen = new Promise<Message>(resolve => client.once(Events.MessageCreate, resolve))
    runtime.incoming(`hey <@${BOT.id}>`, [{ type: 'user', id: BOT.id }])
    const m = await seen
    expect(m.content).toBe(`hey <@${ids.snowflake(BOT.id)}>`)
    expect(m.mentions.users.has(ids.snowflake(BOT.id))).toBe(true)
  })

  it('deletes a message', async () => {
    const bye = runtime.incoming('!bye')
    await until(() => runtime.deleted.length > 0)
    expect(runtime.deleted).toEqual([bye.id])
  })
})

describe('sharding', () => {
  it('gives each shard its guilds, as Discord does, and DMs to shard 0', async () => {
    const runtime = new FakeRuntime()
    // A second guild on the other shard of two (Discord's (guild_id >> 22) % 2).
    const first = runtime.cache.guilds.get(GUILD)!
    const shardOfFirst = shardOfGuild(first.createdAt, 2)
    const OTHER = uuid(3)
    const otherAt = new Date(Date.parse(first.createdAt) + 1).toISOString()
    expect(shardOfGuild(otherAt, 2)).not.toBe(shardOfFirst)
    runtime.cache.guilds.set(OTHER, { ...first, id: OTHER, name: 'Other', createdAt: otherAt })
    const ids = new IdMap()
    const bridge = new DiscordBridge({ runtime, ids, token: TOKEN, log: () => {} })
    const { api } = await bridge.listen()
    const shards = [0, 1].map(
      id =>
        new Client({
          intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
          shards: id,
          shardCount: 2,
          rest: { api },
        }),
    )
    const dms: number[] = []
    shards.forEach((c, i) => c.on(Events.Raw, (p: { t?: string }) => p.t === 'MESSAGE_CREATE' && dms.push(i)))
    try {
      await Promise.all(shards.map(c => c.login(TOKEN)))
      await until(() => shards.every(c => c.isReady() && c.guilds.cache.size > 0))
      const names = shards.map(c => [...c.guilds.cache.values()].map(g => g.name))
      expect(names[shardOfFirst]).toEqual(['Night Owls'])
      expect(names[1 - shardOfFirst]).toEqual(['Other'])

      runtime.emit('message', {
        id: uuid(500),
        channelId: uuid(501),
        guildId: null,
        author: ALICE,
        content: 'hi',
        mentions: [],
        replyTo: null,
        createdAt: new Date().toISOString(),
        editedAt: null,
        clientMsgId: 'c',
      })
      await until(() => dms.length > 0)
      await new Promise(r => setTimeout(r, 100))
      expect(dms).toEqual([0])
    } finally {
      await Promise.all(shards.map(c => c.destroy()))
      await bridge.close()
    }
  })
})
