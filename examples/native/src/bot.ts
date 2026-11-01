/**
 * A Hachiman bot on the native SDK. `startBot` connects with the token alone, makes or links the
 * bot's encrypted device, and gives decrypted events. Each call encrypts for the channel.
 *
 *   HACHIMAN_TOKEN=hbot_… pnpm -F @hachiman/example-native start
 */
import { startBot, type BotMessage } from '@hachiman/bot'

const token = process.env['HACHIMAN_TOKEN']
if (!token) throw new Error('Set HACHIMAN_TOKEN to the bot token (hbot_…) from the Bots page.')

const bot = await startBot({ token })
console.log(`Ready as ${bot.user?.username} in ${bot.cache.guilds.size} guild(s)`)

type Command = (m: BotMessage, args: string[]) => Promise<unknown>

const commands: Record<string, Command> = {
  // A reply: `replyTo` names the message that this one answers.
  ping: m => bot.send(m.channelId, { text: 'Pong!', replyTo: m.id }),

  // A mention is `<@userId>` in the text and an entry in `mentions`, so the user gets notified.
  hello: m =>
    bot.send(m.channelId, {
      text: `Hello <@${m.author.id}>!`,
      mentions: [{ type: 'user', id: m.author.id }],
    }),

  echo: (m, args) => bot.send(m.channelId, { text: args.join(' ') || 'Say something after !echo.' }),

  react: m => bot.react(m.channelId, m.id, '👍'),

  // An edit is a new encrypted version of the same message.
  countdown: async m => {
    const sent = await bot.send(m.channelId, { text: '3' })
    for (const n of ['2', '1', 'Go!']) {
      await new Promise(r => setTimeout(r, 1000))
      await bot.edit(m.channelId, sent.id, { text: n })
    }
  },

  // History comes decrypted, newest first.
  history: async m => {
    const recent = await bot.fetchMessages(m.channelId, { limit: 5 })
    const lines = recent.map(r => `- ${r.author.username}: ${r.content.slice(0, 60)}`)
    return bot.send(m.channelId, { text: `The last ${recent.length} messages:\n${lines.join('\n')}` })
  },

  dm: async m => {
    const dm = await bot.openDm(m.author.id)
    await bot.send(dm.id, { text: 'Hi! This direct message is end-to-end encrypted too.' })
  },

  // The guild cache has the members, roles and channels.
  whoami: m => {
    const member = m.guildId ? bot.cache.members.get(m.guildId)?.get(m.author.id) : undefined
    const roles = member?.roles.map(id => bot.cache.roles.get(m.guildId ?? '')?.get(id)?.name).filter(Boolean)
    return bot.send(m.channelId, {
      text: `You are ${m.author.username}${roles?.length ? `, with the roles ${roles.join(', ')}` : ''}.`,
    })
  },
}

bot.on('message', m => {
  if (m.author.bot || !m.content.startsWith('!')) return
  const [name = '', ...args] = m.content.slice(1).trim().split(/\s+/)
  const command = commands[name.toLowerCase()]
  if (!command) return
  void bot.typing(m.channelId).catch(() => undefined)
  command(m, args).catch((e: unknown) => console.error(`!${name} failed:`, e))
})

bot.on('reaction', r =>
  console.log(`${r.userId} ${r.remove ? 'removed' : 'added'} ${r.emoji} on ${r.messageId}`),
)
bot.on('messageDelete', d => console.log(`message ${d.id} was deleted`))
bot.on('event', e => {
  if (e.t === 'GUILD_MEMBER_ADD') console.log('a member joined a guild of this bot')
})

const stop = (): void => {
  void bot.stop().then(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
