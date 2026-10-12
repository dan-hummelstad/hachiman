import { describe, expect, it } from 'vitest'
import type { VoiceActivity } from '@/lib/member-activity'
import {
  KEYBOARD_DISMISS_DRAG,
  POPOVER_GAP,
  POPOVER_MIN,
  dragClosesKeyboard,
  memberDetail,
  mentionScope,
  popoverMaxHeight
} from './mobile-mention-model'

const lounge: VoiceActivity = {
  guildId: 'g1',
  channelId: 'c1',
  channelName: 'Lounge',
  otherGuildName: null,
  speaking: false,
  streaming: false,
  withMe: true,
  joinedAt: null
}

describe('mentionScope', () => {
  it('names the members of the guild for @', () => {
    expect(mentionScope('@', 'Night Owls')).toBe('Members · Night Owls')
  })

  it('names the people of a DM without a guild', () => {
    expect(mentionScope('@', null)).toBe('People here')
  })

  it('names the channels for # and the emoji for :', () => {
    expect(mentionScope('#', 'Night Owls')).toBe('Channels · Night Owls')
    expect(mentionScope(':', 'Night Owls')).toBe('Emoji')
  })
})

describe('memberDetail', () => {
  it('says who speaks in a call, in the voice ink', () => {
    expect(memberDetail({ ...lounge, speaking: true }, 'online', null)).toEqual({
      text: 'Speaking in Lounge',
      tone: 'voice',
      icon: 'speaking'
    })
  })

  it('says who is in a call', () => {
    expect(memberDetail(lounge, 'online', 'brb')).toEqual({
      text: 'In Lounge',
      tone: 'voice',
      icon: 'voice'
    })
  })

  it('names the other guild of the call', () => {
    expect(memberDetail({ ...lounge, otherGuildName: 'Lattice Labs' }, 'online', null)?.text).toBe(
      'In Lounge · Lattice Labs'
    )
  })

  it('puts an idle member in a call in the quiet ink, with no icon', () => {
    expect(memberDetail(lounge, 'idle', null)).toEqual({
      text: 'Idle · in Lounge',
      tone: 'quiet',
      icon: null
    })
  })

  it('shows the custom status when there is no call', () => {
    expect(memberDetail(null, 'dnd', 'heads down')).toEqual({
      text: 'heads down',
      tone: 'quiet',
      icon: null
    })
  })

  it('spells out idle and do not disturb, and says nothing for online or offline', () => {
    expect(memberDetail(null, 'idle', null)).toEqual({ text: 'Idle', tone: 'quiet', icon: null })
    expect(memberDetail(null, 'dnd', '')).toEqual({
      text: 'Do not disturb',
      tone: 'danger',
      icon: null
    })
    expect(memberDetail(null, 'online', null)).toBeNull()
    expect(memberDetail(null, 'offline', undefined)).toBeNull()
  })
})

describe('popoverMaxHeight', () => {
  it('fills the room between the transcript top and the composer, less the gap and a margin', () => {
    // M6: transcript from y 158, composer at y 458.
    expect(popoverMaxHeight(458, 158)).toBe(458 - 158 - POPOVER_GAP - 8)
  })

  it('keeps the head and two rows when the room is small', () => {
    expect(popoverMaxHeight(200, 158)).toBe(POPOVER_MIN)
  })
})

describe('dragClosesKeyboard', () => {
  it('closes after a drag down past the threshold only', () => {
    expect(dragClosesKeyboard(100, 100 + KEYBOARD_DISMISS_DRAG)).toBe(false)
    expect(dragClosesKeyboard(100, 101 + KEYBOARD_DISMISS_DRAG)).toBe(true)
    expect(dragClosesKeyboard(100, 40)).toBe(false)
  })
})
