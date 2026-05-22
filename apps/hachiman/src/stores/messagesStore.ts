import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
// import { devtools, persist } from 'zustand/middleware'
import { devtools } from 'zustand/middleware'

export type Message = {
  // Dedup model: historic (server-persisted) messages carry a stringified
  // server-assigned bigint id and are merged by that id. Live messages from
  // the realtime pipe use locally-generated UUIDs (no server id yet) and are
  // always appended — they cannot collide with historic ids by construction.
  id: string
  author: string // name
  avatar: string
  content: string
  date: Date
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
          const channelMessages = newHistory.get(channelId) || []
          channelMessages.push(message)
          newHistory.set(channelId, channelMessages)
          return { history: newHistory }
        }),
      prependHistory: (channelId, incoming) =>
        set((state) => {
          if (incoming.length === 0) return {}
          const newHistory = new Map(state.history)
          const existing = newHistory.get(channelId) || []

          // Index existing historic messages (those whose id is a numeric
          // string — i.e. came from the server). Live messages keyed by
          // UUID never collide because UUIDs aren't numeric strings.
          const seen = new Set<string>()
          for (const m of existing) {
            if (/^\d+$/.test(m.id)) seen.add(m.id)
          }

          const toAdd: Message[] = []
          for (const h of incoming) {
            const idStr = h.id.toString()
            if (seen.has(idStr)) continue
            seen.add(idStr)
            toAdd.push({
              id: idStr,
              author: h.author,
              avatar: h.avatar,
              content: h.content,
              date: h.date
            })
          }

          const merged = [...toAdd, ...existing]
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
