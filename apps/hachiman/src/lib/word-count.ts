/**
 * The words of a page, from its markdown export: link targets, image sources, HTML tags and
 * markup characters do not count. A word is a run of letters or digits, with inner ' ’ - _.
 */
export function countWords(markdown: string): number {
  const text = markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/<[^>]+>/g, ' ')
  return text.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0
}
