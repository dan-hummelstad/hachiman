import type { ThemeRecipe } from './theme-engine'

/** The five designed themes. Pins carry the exact values read from the design; the engine fills
 *  the rest. */
export const THEME_PRESETS: readonly ThemeRecipe[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    ground: 'dark',
    base: '#0B0B0C',
    tint: 0.04,
    separation: 1,
    accent: '#6C91D0',
    pins: {
      window: '#0B0B0C',
      rail: '#121214',
      sheet: '#171719',
      raised: '#202023',
      sunken: '#0E0E10',
      line: '#242427',
      lineStrong: '#34343A',
      text: '#F3F2EF',
      text2: '#A6A5A0',
      text3: '#74736F',
      text4: '#4C4B48'
    }
  },
  {
    id: 'carbon',
    name: 'Carbon',
    ground: 'dark',
    base: '#060606',
    tint: 0,
    separation: 1.6,
    accent: '#CD9B70',
    pins: {
      window: '#060606',
      rail: '#111111',
      sheet: '#191919',
      raised: '#272727',
      line: '#292929',
      lineStrong: '#484848',
      text: '#F5F5F5',
      text2: '#ADADAD',
      text3: '#7A7A7A',
      text4: '#525252'
    }
  },
  {
    id: 'slate',
    name: 'Slate',
    ground: 'dark',
    base: '#131518',
    tint: 0.06,
    separation: 0.82,
    accent: '#75B1C7',
    pins: {
      window: '#131518',
      rail: '#181B1F',
      sheet: '#1D2024',
      raised: '#25282D',
      line: '#252830'
    }
  },
  {
    id: 'paper',
    name: 'Paper',
    ground: 'light',
    base: '#EDECE8',
    tint: 0.07,
    separation: 1,
    accent: '#24519D',
    pins: {
      window: '#EDECE8',
      rail: '#F5F4F0',
      sheet: '#FFFFFF',
      raised: '#FFFFFF',
      sunken: '#E7E5DF',
      line: '#E2DFD7',
      lineStrong: '#CECABF',
      text: '#16150F',
      text2: '#57554D',
      text3: '#85837A',
      text4: '#AAA79C'
    }
  },
  {
    id: 'dune',
    name: 'Dune',
    ground: 'light',
    base: '#ECE8E4',
    tint: 0.1,
    separation: 1.2,
    accent: '#A1472B',
    pins: {
      window: '#ECE8E4',
      rail: '#F2F0ED',
      sheet: '#FFFFFF',
      sunken: '#E5DFDA',
      line: '#DFD9D2',
      lineStrong: '#C7BCB0',
      text: '#191715',
      text2: '#60574E',
      text3: '#8D8072',
      text4: '#B6AEA5'
    }
  }
]

export const DEFAULT_DARK = 'midnight'
export const DEFAULT_LIGHT = 'paper'

export function findTheme(id: string, custom: readonly ThemeRecipe[]): ThemeRecipe | undefined {
  return custom.find((t) => t.id === id) ?? THEME_PRESETS.find((t) => t.id === id)
}

const HEX = /^#[0-9a-fA-F]{6}$/

export function isThemeRecipe(v: unknown): v is ThemeRecipe {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return false
  if (r.ground !== 'dark' && r.ground !== 'light') return false
  if (typeof r.base !== 'string' || !HEX.test(r.base)) return false
  if (typeof r.accent !== 'string' || !HEX.test(r.accent)) return false
  if (typeof r.tint !== 'number' || !Number.isFinite(r.tint)) return false
  if (typeof r.separation !== 'number' || !Number.isFinite(r.separation)) return false
  if (r.pins !== undefined) {
    if (typeof r.pins !== 'object' || r.pins === null) return false
    for (const val of Object.values(r.pins))
      if (typeof val !== 'string' || !HEX.test(val)) return false
  }
  return true
}
