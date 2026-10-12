import { beforeEach, describe, expect, it } from 'vitest'
import {
  closeDmStage,
  dmStageOpenIn,
  openDmStage,
  useDmStage
} from '@/components/voice/dm-stage-state'
import { useVoiceStore } from '@/stores/voiceStore'

const inCall = (channelId: string | null, localJoinedAt: number | null): void => {
  useVoiceStore.setState({ channelId, localJoinedAt })
}

const shown = (channelId: string): boolean => {
  const v = useVoiceStore.getState()
  return dmStageOpenIn(
    useDmStage.getState(),
    channelId,
    v.channelId === channelId ? v.localJoinedAt : null
  )
}

beforeEach(() => {
  closeDmStage()
  inCall(null, null)
})

describe('DM stage', () => {
  it('shows after the open, in the call it was opened in', () => {
    inCall('a', 100)
    expect(shown('a')).toBe(false)
    openDmStage('a')
    expect(shown('a')).toBe(true)
    expect(shown('b')).toBe(false)
  })

  it('goes on close', () => {
    inCall('a', 100)
    openDmStage('a')
    closeDmStage()
    expect(shown('a')).toBe(false)
  })

  it('hides when I leave the call', () => {
    inCall('a', 100)
    openDmStage('a')
    inCall(null, null)
    expect(shown('a')).toBe(false)
  })

  it('does not come back in the next call of the same DM', () => {
    inCall('a', 100)
    openDmStage('a')
    inCall(null, null)
    inCall('a', 200)
    expect(shown('a')).toBe(false)
  })

  it('needs a call: an open outside one shows nothing', () => {
    openDmStage('a')
    expect(shown('a')).toBe(false)
  })
})
