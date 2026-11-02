// An ordinary discord.js v14 bot. Nothing here knows about Hachiman: the package "discord.js" is
// @hachiman/discord.js (see package.json), and DISCORD_TOKEN is a Hachiman bot token.
const { Client, EmbedBuilder, Events, GatewayIntentBits, Partials } = require('discord.js')

const PREFIX = '!'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
})

client.once(Events.ClientReady, c => {
  console.log(`Ready! Logged in as ${c.user.tag} in ${c.guilds.cache.size} guild(s)`)
})

client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return
  const [command, ...args] = message.content.slice(PREFIX.length).trim().split(/ +/)

  switch (command.toLowerCase()) {
    case 'ping':
      return message.reply('Pong!')

    case 'hello':
      return message.channel.send(`Hello ${message.author}!`)

    case 'echo':
      return message.channel.send(args.join(' ') || 'Say something after !echo.')

    case 'react':
      return message.react('👍')

    // Hachiman has no embeds: the package sends them as text under the message.
    case 'embed':
      return message.channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('Hachiman')
            .setDescription('Every channel is end-to-end encrypted.')
            .addFields(
              { name: 'Bot', value: client.user.username },
              { name: 'Guilds', value: String(client.guilds.cache.size) },
            )
            .setFooter({ text: 'Embeds arrive as text' }),
        ],
      })

    case 'countdown': {
      const sent = await message.channel.send('3')
      for (const n of ['2', '1', 'Go!']) {
        await new Promise(r => setTimeout(r, 1000))
        await sent.edit(n)
      }
      return
    }

    case 'history': {
      const recent = await message.channel.messages.fetch({ limit: 5 })
      const lines = recent.map(m => `- ${m.author.username}: ${m.content.slice(0, 60)}`)
      return message.channel.send(`The last ${recent.size} messages:\n${lines.join('\n')}`)
    }

    case 'dm':
      return message.author.send('Hi! This direct message is end-to-end encrypted too.')

    case 'whoami': {
      const roles = message.member?.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name) ?? []
      return message.reply(
        `You are ${message.author.username}${roles.length ? `, with the roles ${roles.join(', ')}` : ''}.`,
      )
    }
  }
})

client.on(Events.MessageReactionAdd, (reaction, user) => {
  console.log(`${user.username} reacted ${reaction.emoji.name}`)
})

client.login(process.env.DISCORD_TOKEN)
