// discord.js sharding, as on Discord. Each shard is its own process and its own encrypted device
// (.hachiman-bot/shard-<id>/). The first shard makes the bot's keys and .hachiman-bot/deployment.key;
// the next shards link to it with that key, with no owner step.
const { ShardingManager } = require('discord.js')

const manager = new ShardingManager(`${__dirname}/bot.js`, {
  totalShards: 2,
  token: process.env.DISCORD_TOKEN,
  // The shards run the TypeScript source of the package in this repo; an installed package needs no execArgv.
  execArgv: ['--import', 'tsx'],
})

manager.on('shardCreate', shard => console.log(`Launched shard ${shard.id}`))
manager.spawn()
