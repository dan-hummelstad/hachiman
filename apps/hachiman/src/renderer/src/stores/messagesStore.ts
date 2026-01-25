import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
// import { devtools, persist } from 'zustand/middleware'
import { devtools } from 'zustand/middleware'

export type Message = {
  id: string
  author: string // name
  avatar: string
  content: string
  date: Date
}

interface MessageState {
  history: Map<number, Message[]> // Channel id to message list
  setMessageHistory: (channelId: number, messages: Message[]) => void
  addMessage: (channelId: number, message: Message) => void
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
