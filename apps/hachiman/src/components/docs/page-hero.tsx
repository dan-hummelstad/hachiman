import { FileText } from 'lucide-react'
import { hashString } from '@/lib/hash'
import type { ThemeColors } from '@/components/shell/use-guild-tint'

/** The two hues of a page's cover: the far end (`a`) and the low glow (`b`), from its id. */
// eslint-disable-next-line react-refresh/only-export-components
export function coverHues(pageId: string): { a: number; b: number } {
  const a = hashString(pageId) % 360
  return { a, b: (a + 300) % 360 }
}

/**
 * The cover of a page (M38) as a CSS background image per theme. A page stores no cover yet
 * (spec §5), so it is computed: the guild tint (`tint`, the window colour of the guild) at the
 * start, a hue from the page id at the far end, a page-violet glow at the top right and a glow of
 * a second hue at the bottom left. The same page looks the same on every device.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function pageCover(pageId: string, tint: ThemeColors): ThemeColors {
  const { a, b } = coverHues(pageId)
  const layers = (glow: number, low: string, end: string, base: string): string =>
    [
      `radial-gradient(45% 80% at 82% 15%, color-mix(in oklab, var(--feature-page) ${glow}%, transparent), transparent)`,
      `radial-gradient(40% 70% at 12% 95%, ${low}, transparent)`,
      `linear-gradient(100deg, ${base} 0%, color-mix(in oklab, ${end} 50%, ${base}) 45%, ${end} 100%)`
    ].join(', ')
  return {
    light: layers(35, `hsl(${b} 70% 60% / 0.3)`, `hsl(${a} 60% 80%)`, tint.light),
    dark: layers(45, `hsl(${b} 65% 50% / 0.4)`, `hsl(${a} 50% 32%)`, tint.dark)
  }
}

/**
 * The head of the page screen (M38): a 116 cover and the 62 page tile that overlaps it by 30.
 * Both are decoration: no stored cover or icon exists yet.
 */
export function PageHero({
  pageId,
  tint
}: {
  pageId: string
  /** The window colour of the guild (`useGuildTint(guildId).window`). */
  tint: ThemeColors
}): React.JSX.Element {
  const cover = pageCover(pageId, tint)
  return (
    <div aria-hidden className="flex shrink-0 flex-col">
      <div
        style={{ '--cover-light': cover.light, '--cover-dark': cover.dark } as React.CSSProperties}
        className="bg-surface-window h-[116px] bg-(image:--cover-light) dark:bg-(image:--cover-dark)"
      />
      <div className="-mt-[30px] px-5">
        <span className="border-surface-content flex size-[62px] items-center justify-center border-3 bg-[color-mix(in_oklab,var(--feature-page)_12%,var(--surface-content))]">
          <FileText className="text-feature-page-text size-[30px]" />
        </span>
      </div>
    </div>
  )
}
