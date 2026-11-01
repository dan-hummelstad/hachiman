"""A discord.py 2.x bot on Hachiman, through the Discord bridge.

The bridge (hachiman-discord-bridge) holds the bot's keys and serves the Discord API on
127.0.0.1. The only change to a Discord bot: the API base below points at the bridge.
"""
import os

import discord
from discord.ext import commands

discord.http.Route.BASE = os.environ.get("DISCORD_API_BASE", "http://127.0.0.1:8787/api/v10")

intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents)


@bot.event
async def on_ready():
    print(f"Ready as {bot.user} in {len(bot.guilds)} guild(s)")


@bot.command()
async def ping(ctx: commands.Context):
    await ctx.reply("Pong!")


@bot.command()
async def hello(ctx: commands.Context):
    await ctx.send(f"Hello {ctx.author.mention}!")


@bot.command()
async def echo(ctx: commands.Context, *, text: str = "Say something after !echo."):
    await ctx.send(text)


@bot.command()
async def react(ctx: commands.Context):
    await ctx.message.add_reaction("👍")


bot.run(os.environ["DISCORD_TOKEN"])
