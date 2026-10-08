/**
 * The guild soundboard (contract §4 Soundboard, §12.21). The list of a guild goes into
 * `soundsStore` (the pointers stay envelopes there). Playing a sound decrypts its pointer with
 * `decryptDoc`, then its blob with `decryptAttachment`, and decodes the audio. The decoded
 * AudioBuffer is cached here, in memory only. The file key never leaves this module's call chain.
 */
import {
  Permissions,
  RestError,
  computeBasePermissions,
  has,
  type GatewayDispatch,
  type GuildSound
} from '@hachiman/client'
import {
  decodeSoundPointer,
  encodeSoundPointer,
  soundChannel,
  soundMime,
  clipProblem,
  type SoundPointer
} from '@/lib/soundboard'
import { errMsg } from '@/lib/utils'
import { decryptBlob } from '@/hooks/use-decrypted-blob'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/client'
import type { ClientFeature } from '@/services/features'
import { voiceService } from '@/services/VoiceService'
import { useSoundsStore } from '@/stores/soundsStore'

/** The gain of a sound in the mix and on my speakers. */
export const SOUNDBOARD_VOLUME = 0.8

/** soundId → the decoded clip. A failure stays for 30 s, so the grid does not retry in a loop. */
const buffers = new Map<string, Promise<AudioBuffer>>()
const loads = new Map<string, Promise<void>>()
let session = 0
let decoder: BaseAudioContext | null = null

function decodeContext(): BaseAudioContext {
  // An OfflineAudioContext decodes without an output device and without a user gesture.
  decoder ??= new OfflineAudioContext(1, 1, 48_000)
  return decoder
}

function setGuild(guildId: string, sounds: GuildSound[]): void {
  const byGuild = new Map(useSoundsStore.getState().byGuild)
  byGuild.set(guildId, sounds)
  useSoundsStore.setState({ byGuild })
  const ids = new Set(sounds.map((s) => s.id))
  for (const id of buffers.keys()) if (!ids.has(id) && !inOtherGuild(id, guildId)) buffers.delete(id)
}

function inOtherGuild(soundId: string, guildId: string): boolean {
  for (const [g, list] of useSoundsStore.getState().byGuild)
    if (g !== guildId && list.some((s) => s.id === soundId)) return true
  return false
}

/** True when the sender of a pointer may manage sounds now (the cache's view). */
function senderMayManage(guildId: string, userId: string): boolean {
  const c = hachiman.cache
  const guild = c.guilds.get(guildId)
  const member = c.members.get(guildId)?.get(userId)
  if (!guild || !member) return false
  const perms = computeBasePermissions(guild, member, c.roles.get(guildId) ?? new Map())
  return has(perms, Permissions.MANAGE_EXPRESSIONS)
}

async function openPointer(sound: GuildSound): Promise<SoundPointer> {
  const [res] = await cryptoService.client().decryptDoc([
    {
      id: sound.id,
      channelId: sound.channelId,
      pageId: sound.id,
      kind: 'doc_snapshot',
      senderDevice: sound.senderDevice,
      envelope: sound.envelope
    }
  ])
  if (!res || res.status === 'pending') throw new Error('The key of this sound is not on this device yet.')
  if (res.status === 'failed') throw new Error(`This sound does not decrypt (${res.reason}).`)
  if (!senderMayManage(sound.guildId, res.sender.userId)) throw new Error('This sound has no valid uploader.')
  const pointer = decodeSoundPointer(res.bytes, sound.uploadId)
  if (!pointer) throw new Error('This sound is malformed.')
  return pointer
}

async function loadBuffer(sound: GuildSound): Promise<AudioBuffer> {
  const pointer = await openPointer(sound)
  const blob = await decryptBlob({
    uploadId: pointer.uploadId,
    key: pointer.fileKey,
    sha256: pointer.sha256,
    mime: pointer.mime,
    size: pointer.size
  })
  return decodeContext().decodeAudioData(await blob.arrayBuffer())
}

/** The pending decrypt, the AudioBuffer or the error of a sound, for the grid state. */
export function soundBuffer(sound: GuildSound): Promise<AudioBuffer> {
  let p = buffers.get(sound.id)
  if (!p) {
    p = loadBuffer(sound)
    buffers.set(sound.id, p)
    // A pending key can arrive later: forget the failure after a while.
    p.catch(() => setTimeout(() => buffers.get(sound.id) === p && buffers.delete(sound.id), 30_000))
  }
  return p
}

let previewCtx: AudioContext | null = null

export const soundboardService = {
  /** Loads the sounds of a guild into the store. Never rejects (logs). */
  load(guildId: string): Promise<void> {
    const running = loads.get(guildId)
    if (running) return running
    const started = session
    const p = hachiman.rest
      .getGuildSounds(guildId)
      .then((sounds) => {
        if (started === session) setGuild(guildId, sounds)
      })
      .catch((e: unknown) => console.warn('[soundboard] load failed', e))
      .finally(() => loads.delete(guildId))
    loads.set(guildId, p)
    return p
  },

  ensureLoaded(guildId: string): void {
    if (!useSoundsStore.getState().byGuild.has(guildId)) void soundboardService.load(guildId)
  },

  /** Mixes the sound into my call. Rejects with a user-facing message. */
  async play(sound: GuildSound): Promise<void> {
    const buffer = await soundBuffer(sound)
    if (!voiceService.playSoundboard(buffer, SOUNDBOARD_VOLUME))
      throw new Error('Join voice and unmute to play a sound.')
  },

  /** Plays the sound on this device only (the settings page). */
  async preview(sound: GuildSound): Promise<void> {
    const buffer = await soundBuffer(sound)
    previewCtx ??= new AudioContext()
    void previewCtx.resume().catch(() => undefined)
    const node = previewCtx.createBufferSource()
    const gain = previewCtx.createGain()
    gain.gain.value = SOUNDBOARD_VOLUME
    node.buffer = buffer
    node.connect(gain).connect(previewCtx.destination)
    node.start()
  },

  /**
   * Checks and encrypts the clip, uploads the blob, seals the pointer in the public_set group and
   * creates the sound (MANAGE_EXPRESSIONS). Rejects with a user-facing message.
   */
  async upload(guildId: string, input: { file: File; name: string; emoji: string | null }): Promise<GuildSound> {
    const { file } = input
    const mime = soundMime(file)
    const early = clipProblem(file, null)
    if (early || !mime) throw new Error(early ?? 'Use an MP3, OGG or WAV file.')
    let duration: number
    try {
      duration = (await decodeContext().decodeAudioData(await file.arrayBuffer())).duration
    } catch {
      throw new Error('This file does not play as audio.')
    }
    const late = clipProblem(file, duration)
    if (late) throw new Error(late)
    const channel = soundChannel(hachiman.cache.channels.values(), guildId)
    if (!channel) throw new Error('The soundboard needs a text channel that everyone in the guild can see.')

    const crypto = cryptoService.client()
    await crypto.ensureChannelGroup(channel.id)
    const enc = await crypto.encryptAttachment({
      file,
      name: 'sound',
      mime,
      width: null,
      height: null,
      durationMs: Math.round(duration * 1000),
      blurhash: null,
      thumbnail: null
    })
    const upload = await hachiman.rest.uploadBlob(enc.blob)
    const id = globalThis.crypto.randomUUID()
    const bytes = encodeSoundPointer({
      uploadId: upload.id,
      fileKey: enc.draft.key,
      sha256: enc.draft.sha256,
      size: enc.draft.size,
      mime
    })
    const create = async (): Promise<GuildSound> => {
      const out = await crypto.encryptDoc({ channelId: channel.id, pageId: id, kind: 'doc_snapshot', bytes })
      return hachiman.rest.createGuildSound(guildId, {
        id,
        name: input.name,
        emoji: input.emoji,
        uploadId: upload.id,
        channelId: channel.id,
        envelope: out.envelope
      })
    }
    try {
      try {
        return await create()
      } catch (e) {
        // The group moved on between the encrypt and the post: catch up and seal again once.
        if (!(e instanceof RestError && e.code === 'StaleEpoch')) throw e
        await crypto.ensureChannelGroup(channel.id)
        return await create()
      }
    } catch (e) {
      throw new Error(e instanceof RestError ? (e.message || e.code) : errMsg(e), { cause: e })
    }
  },

  remove: (guildId: string, soundId: string): Promise<void> => hachiman.rest.deleteGuildSound(guildId, soundId),

  reset(): void {
    session++
    buffers.clear()
    loads.clear()
    useSoundsStore.setState({ byGuild: new Map() })
  }
}

export const soundboardFeature: ClientFeature = {
  name: 'soundboard',
  onDispatch(e: GatewayDispatch): void {
    if (e.t === 'GUILD_SOUNDS_UPDATE' && useSoundsStore.getState().byGuild.has(e.d.guildId))
      void soundboardService.load(e.d.guildId)
  },
  // A new session can bring changed sounds; keys that arrive later can open pending ones.
  onReady: () => {
    buffers.clear()
    for (const guildId of useSoundsStore.getState().byGuild.keys()) void soundboardService.load(guildId)
  },
  onGroupKeys: () => buffers.clear(),
  reset: () => soundboardService.reset()
}
