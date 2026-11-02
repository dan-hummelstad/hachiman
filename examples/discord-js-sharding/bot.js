// One shard. Discord's rule decides the guilds of each shard: (guild_id >> 22) % shard count.
// Direct messages go to shard 0.
const { Client, Events, GatewayIntentBits } = require('discord.js')

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
})

client.once(Events.ClientReady, c => {
  console.log(`Shard ${c.shard.ids} ready as ${c.user.tag} with ${c.guilds.cache.size} guild(s)`)
})

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return
  if (message.content === '!ping') await message.reply(`Pong from shard ${client.shard.ids}!`)
  if (message.content === '!guilds') {
    // A broadcastEval reaches every shard, as on Discord.
    const counts = await client.shard.fetchClientValues('guilds.cache.size')
    await message.reply(`${counts.reduce((a, n) => a + n, 0)} guild(s) over ${counts.length} shard(s)`)
  }
})

client.login(process.env.DISCORD_TOKEN)
