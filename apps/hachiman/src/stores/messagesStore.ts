import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
// import { devtools, persist } from 'zustand/middleware'
import { devtools } from 'zustand/middleware'

export type Message = {
  // Dedup model:
  //   - Historic (server-persisted) messages carry a stringified
  //     server-assigned bigint id and are merged by that id.
  //   - Live messages from the realtime `textMessage` echo use locally-
  //     generated UUIDs (no server id yet) and are appended.
  // The cross-shape collision case (a live UUID entry whose persisted
  // version later arrives via history reload) is resolved on the
  // historic side: prependHistory drops live UUIDs that match the
  // incoming historic by (actorSession, content, |t-t|<5s). That's why
  // every insert carries `actorSession` — it's the cross-path key.
  id: string
  author: string // name
  avatar: string
  content: string
  date: Date
  /**
   * Mumble session id of the sender at send time. Carried on every
   * insert path so live UUID entries can be deduplicated against the
   * canonical historic row when chat history is later (re)loaded for
   * the channel. undefined for placeholder/system rows.
   */
  actorSession?: number
}

/**
 * A persisted message coming back from the server's chat history. We keep the
 * id as a bigint here so callers don't have to round-trip through strings;
 * the store normalizes it to a string for the shared Message shape.
 */
export type HistoricMessage = {
  id: bigint
  author: string
  avatar: string
  content: string
  date: Date
  /** See {@link Message.actorSession}. */
  actorSession?: number
}

interface MessageState {
  history: Map<number, Message[]> // Channel id to message list
  setMessageHistory: (channelId: number, messages: Message[]) => void
  addMessage: (channelId: number, message: Message) => void
  /**
   * Merge a batch of server-persisted historic messages into a channel,
   * deduplicating by `id` and keeping the resulting list sorted by `date`
   * ascending. Used by MessagesService.loadHistory to back-fill older pages.
   */
  prependHistory: (channelId: number, messages: HistoricMessage[]) => void
  deleteMessage: (channelId: number, messageId: string) => void
  clearMessages: (channelId: number) => void
}

export const useMessageStore = create<MessageState>()(
  devtools(
    // persist(
    (set) => ({
      history: new Map<number, Message[]>(),
      setMessageHistory: (channelId, messages) =>
        set((state) => {
          const newHistory = new Map(state.history)
          newHistory.set(channelId, messages)
          return { history: newHistory }
        }),
      addMessage: (channelId, message) =>
        set((state) => {
          const newHistory = new Map(state.history)
          const existing = newHistory.get(channelId) || []
          // Build a NEW array — never mutate the existing reference, or the
          // zustand selector in chat-area.tsx will return the same snapshot
          // and React won't re-render until something else triggers a fetch.
          // Insertion-sort by date so a late-arriving message with an earlier
          // timestamp (clock skew, race with an optimistic local send) slots
          // into chronological order instead of being appended at the bottom.
          const merged = [...existing, message]
          merged.sort((a, b) => a.date.getTime() - b.date.getTime())
          newHistory.set(channelId, merged)
          return { history: newHistory }
        }),
      prependHistory: (channelId, incoming) =>
        set((state) => {
          if (incoming.length === 0) return {}
          const newHistory = new Map(state.history)
          const existing = newHistory.get(channelId) || []

          // Index existing historic messages (those whose id is a numeric
          // string — i.e. came from the server). Live messages keyed by
          // UUID never collide on id by construction.
          const seenHistoricId = new Set<string>()
          for (const m of existing) {
            if (/^\d+$/.test(m.id)) seenHistoricId.add(m.id)
          }

          // Filter incoming historic against existing historic IDs first.
          const toAdd: Message[] = []
          for (const h of incoming) {
            const idStr = h.id.toString()
            if (seenHistoricId.has(idStr)) continue
            seenHistoricId.add(idStr)
            toAdd.push({
              id: idStr,
              author: h.author,
              avatar: h.avatar,
              content: h.content,
              date: h.date,
              actorSession: h.actorSession
            })
          }

          // Drop live (UUID-keyed) rows that the just-arrived historic
          // batch has a canonical persisted copy of. Match on
          // (actorSession, content, |t-t|<5s) — that's the same (sender,
          // payload, send instant) tuple regardless of which path landed
          // it. Without this, sending a message and later switching off
          // the channel and back round-trips into two visible rows: the
          // live UUID echo and the bigint-keyed persisted form.
          const DEDUP_WINDOW_MS = 5_000
          const filteredExisting = existing.filter((m) => {
            if (/^\d+$/.test(m.id)) return true // historic survives
            if (m.actorSession === undefined) return true
            return !toAdd.some(
              (h) =>
                h.actorSession === m.actorSession &&
                h.content === m.content &&
                Math.abs(h.date.getTime() - m.date.getTime()) < DEDUP_WINDOW_MS
            )
          })

          const merged = [...toAdd, ...filteredExisting]
          merged.sort((a, b) => a.date.getTime() - b.date.getTime())
          newHistory.set(channelId, merged)
          return { history: newHistory }
        }),
      deleteMessage: (channelId, messageId) =>
        set((state) => {
          const newHistory = new Map(state.history)
          const channelMessages = newHistory.get(channelId) || []
          const updatedMessages = channelMessages.filter((msg) => msg.id !== messageId)
          newHistory.set(channelId, updatedMessages)
          return { history: newHistory }
        }),
      clearMessages: (channelId) =>
        set((state) => {
          const newHistory = new Map(state.history)
          newHistory.set(channelId, [])
          return { history: newHistory }
        })
    })
    // )
  )
)
