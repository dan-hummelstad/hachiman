'use server'

import { revalidatePath } from 'next/cache'

import { ForbiddenError, requireUser } from '@/lib/auth-helpers'
import type { Session } from 'next-auth'

import { auth } from '@/auth'
import { addBotToGuild, botNameSchema, createBot, deleteBot, resetBotKeys, resetBotToken } from '@/lib/bot-accounts'
import { MissingPermissionsError } from '@/lib/errors'
import { ApiError, NotFoundError } from '@/lib/errors'

/** `token` is set only by create and reset: the page shows it once. */
export interface BotActionResult {
  ok: boolean
  error?: string
  token?: string
  name?: string
}

function failure(err: unknown): BotActionResult {
  if (err instanceof ApiError || err instanceof NotFoundError) return { ok: false, error: err.message }
  if (err instanceof ForbiddenError) return { ok: false, error: 'A bot cannot own bots.' }
  if (err instanceof MissingPermissionsError) return { ok: false, error: 'You need the Manage server permission in that guild.' }
  throw err
}

export async function createBotAction(_prev: BotActionResult | undefined, formData: FormData): Promise<BotActionResult> {
  const session = await requireUser()
  const parsed = botNameSchema.safeParse(formData.get('name'))
  if (!parsed.success) return { ok: false, error: 'The name must be 2 to 32 characters.' }
  try {
    const { token } = await createBot(session.user.id, parsed.data)
    revalidatePath('/bots')
    return { ok: true, token, name: parsed.data }
  } catch (err) {
    return failure(err)
  }
}

export async function resetBotTokenAction(botId: string): Promise<BotActionResult> {
  const session = await requireUser()
  try {
    const token = await resetBotToken(session.user.id, botId)
    revalidatePath('/bots')
    return { ok: true, token }
  } catch (err) {
    return failure(err)
  }
}

export async function deleteBotAction(botId: string): Promise<BotActionResult> {
  const session = await requireUser()
  try {
    await deleteBot(session.user.id, botId)
    revalidatePath('/bots')
    return { ok: true }
  } catch (err) {
    return failure(err)
  }
}

/** Cookie only (as requireAdmin): a bearer token alone cannot replace a master key (§12.4). */
export async function resetBotKeysAction(botId: string): Promise<BotActionResult> {
  const session = (await auth()) as Session | null
  if (!session?.user?.id) return { ok: false, error: 'Sign in again.' }
  try {
    const token = await resetBotKeys(session.user.id, botId)
    revalidatePath('/bots')
    return { ok: true, token }
  } catch (err) {
    return failure(err)
  }
}

export async function addBotToGuildAction(botId: string, guildId: string): Promise<BotActionResult> {
  const session = await requireUser()
  try {
    const guild = await addBotToGuild(session.user.id, botId, guildId)
    revalidatePath('/bots')
    return { ok: true, name: guild.name }
  } catch (err) {
    return failure(err)
  }
}
