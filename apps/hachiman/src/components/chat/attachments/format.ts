/** Largest inline embed box; images and video scale down to fit, never up. */
export const EMBED_MAX = { width: 400, height: 300 }

/**
 * CSS size for an embed of `width`×`height`, fitted into EMBED_MAX. `aspectRatio` lets the box
 * shrink with a narrow pane and still reserve its height before the media loads.
 */
export function embedBox(
  width: number | null,
  height: number | null
): { width: number; aspectRatio: string } | undefined {
  if (!width || !height) return undefined
  const scale = Math.min(1, EMBED_MAX.width / width, EMBED_MAX.height / height)
  return { width: Math.round(width * scale), aspectRatio: `${width} / ${height}` }
}
