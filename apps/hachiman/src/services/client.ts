/**
 * The one HachimanClient. Services import it from here; services/hachiman.ts wires its events into
 * the stores and the features. Keeping the instance apart breaks the import cycle between the
 * wiring and the services that it calls.
 */
import { HachimanClient, type GatewayDevice } from '@hachiman/client'
import { createTransformWorker } from '@hachiman/crypto'
import { CLIENT_CAPABILITIES, CLIENT_VERSION } from '@/lib/client-version'
import { cryptoService } from '@/services/CryptoService'
import { takusenService } from '@/services/TakusenService'
import { createVoiceE2ee } from '@/services/voice-e2ee'
import { currentDeviceId, useCryptoStore } from '@/stores/cryptoStore'
import { useVoiceStore } from '@/stores/voiceStore'

/** IDENTIFY facts (§12.13). Null until the crypto Worker has a device row: connect() waits. */
function device(): GatewayDevice | null {
  const deviceId = currentDeviceId()
  return deviceId
    ? { deviceId, capabilities: [...CLIENT_CAPABILITIES], clientVersion: CLIENT_VERSION }
    : null
}

/** One delegate and one transform Worker per call, for the channel that VoiceService joins. */
function voiceE2ee(): ReturnType<typeof createVoiceE2ee> {
  const { guildId, channelId } = useVoiceStore.getState()
  if (!guildId || !channelId) throw new Error('voice e2ee: no voice target')
  return createVoiceE2ee({
    crypto: cryptoService.client(),
    target: { guildId, channelId },
    createWorker: createTransformWorker,
    createTransform: (worker, options, transfer) =>
      new RTCRtpScriptTransform(worker, options, transfer),
    createChannel: () => new MessageChannel(),
    onHandle: (handle) =>
      useCryptoStore.setState({ voice: handle ? { handle, epoch: null, roster: [] } : null })
  })
}

/** The one HachimanClient. Tokens come from the Takusen session. */
export const hachiman = new HachimanClient({
  apiUrl: `${takusenService.env.apiBase.replace(/\/$/, '')}/v1`,
  gatewayUrl: takusenService.env.gatewayUrl,
  getToken: takusenService.getAccessToken,
  device,
  proveDevice: (req) => cryptoService.proveDevice(req),
  voiceE2ee
})
