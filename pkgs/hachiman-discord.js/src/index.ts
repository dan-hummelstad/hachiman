/**
 * discord.js for Hachiman (docs/bots-plan.md §4). Install it under the name `discord.js`:
 *
 *   "dependencies": { "discord.js": "npm:@hachiman/discord.js@^0.1.0" }
 *
 * and give the bot a Hachiman bot token (`hbot_…`) where it had its Discord token. Nothing else
 * changes: this package is discord.js 14, with one difference in `Client.login`. With a Hachiman
 * token, login first starts the bot runtime and the Discord bridge in this process
 * (`@hachiman/bot`), then points the client's REST at the bridge. discord.js finds the gateway
 * through the bridge's `GET /gateway/bot`. Any other token logs in to Discord as before.
 *
 * Settings come from the environment: HACHIMAN_URL (the Hachiman server), HACHIMAN_GATEWAY_URL,
 * HACHIMAN_BOT_STATE (where the bot keeps its keys; default ./.hachiman-bot) and HACHIMAN_BOT_JOIN
 * (invite codes to join on start).
 */
import * as discord from 'discord.js'
import { startBridge, type RunningBridge } from '@hachiman/bot'

export * from 'discord.js'

const HACHIMAN_TOKEN = /^(?:(?:Bot|Bearer)\s+)?hbot_/i

export class Client<Ready extends boolean = boolean> extends discord.Client<Ready> {
  private hachiman: RunningBridge | null = null

  override async login(token: string | undefined = this.token ?? undefined): Promise<string> {
    if (token && HACHIMAN_TOKEN.test(token) && !this.hachiman) {
      this.hachiman = await startBridge({
        token,
        log: msg => this.emit(discord.Events.Debug, `[Hachiman] ${msg}`),
      })
      this.rest.options.api = this.hachiman.api
    }
    return super.login(token)
  }

  override async destroy(): Promise<void> {
    await super.destroy()
    const running = this.hachiman
    this.hachiman = null
    await running?.stop()
  }
}

export default { ...discord, Client }
