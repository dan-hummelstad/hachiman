import { describe, expect, it, vi } from 'vitest'

// Only the pure patch builder is under test: keep the page's service and UI imports out.
vi.mock('@/services/hachiman', () => ({ hachiman: {} }))
vi.mock('@/components/settings/guild-overview-mobile', () => ({ GuildOverviewMobile: () => null }))
vi.mock('@/components/settings/image-field', () => ({ ImageField: () => null }))
vi.mock('@/components/region-select', () => ({ RegionSelect: () => null }))

const { guildOverviewPatch } = await import('./guild-overview')

const draft = {
  name: '  Night Owls  ',
  region: 'eu-west',
  publicHistoryVisibility: 'shared' as const,
  welcomeChannelId: 'c1'
}

describe('guildOverviewPatch', () => {
  it('trims the name and keeps the set values', () => {
    expect(guildOverviewPatch({ publicHistoryVisibility: 'shared' }, draft)).toEqual({
      name: 'Night Owls',
      region: 'eu-west',
      publicHistoryVisibility: undefined,
      welcomeChannelId: 'c1'
    })
  })

  it('sends null for Automatic and for no welcome channel', () => {
    const patch = guildOverviewPatch(
      { publicHistoryVisibility: 'shared' },
      { ...draft, region: '', welcomeChannelId: '' }
    )
    expect(patch.region).toBeNull()
    expect(patch.welcomeChannelId).toBeNull()
  })

  it('sends the history visibility only when it changed', () => {
    expect(
      guildOverviewPatch({ publicHistoryVisibility: 'joined' }, draft).publicHistoryVisibility
    ).toBe('shared')
    expect(
      guildOverviewPatch({ publicHistoryVisibility: 'shared' }, draft).publicHistoryVisibility
    ).toBeUndefined()
  })
})
