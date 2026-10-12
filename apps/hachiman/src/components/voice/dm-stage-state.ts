import { create } from 'zustand'
import { useLayout } from '@/hooks/use-layout'
import { useVoiceStore } from '@/stores/voiceStore'

interface DmStage {
  channelId: string | null
  /** The `voiceStore.localJoinedAt` of the call the stage was opened in. */
  joinedAt: number | null
}

/**
 * The DM whose call stage shows on the mobile layout, in place of its chat. In memory only, and
 * tied to one call: a DM with my call opens on its chat, with the voice bar on the composer, and
 * the bar (or the header's call button) opens the stage. The next call opens on the chat again.
 */
export const useDmStage = create<DmStage>()(() => ({ channelId: null, joinedAt: null }))

/** Shows the stage of my DM call in `channelId` on the mobile layout (the voice bar's tap). */
export const openDmStage = (channelId: string): void =>
  useDmStage.setState({ channelId, joinedAt: useVoiceStore.getState().localJoinedAt })

export const closeDmStage = (): void => useDmStage.setState({ channelId: null, joinedAt: null })

/** The stage was opened for `channelId` in the call that I joined at `joinedAt`. */
export const dmStageOpenIn = (
  stage: DmStage,
  channelId: string | null,
  joinedAt: number | null
): boolean =>
  channelId !== null &&
  joinedAt !== null &&
  stage.channelId === channelId &&
  stage.joinedAt === joinedAt

/**
 * True while the mobile layout shows the full-height stage of the DM `channelId`: I am in its
 * call and opened the stage in this call. The stage then takes the place of the chat
 * (MobileChatPane).
 */
export function useDmStageShown(channelId: string | null): boolean {
  const mobile = useLayout() === 'mobile'
  const joinedAt = useVoiceStore((s) =>
    channelId !== null && s.channelId === channelId ? s.localJoinedAt : null
  )
  const open = useDmStage((s) => dmStageOpenIn(s, channelId, joinedAt))
  return mobile && open
}
