// Page links in message text. The pages panel copies a page link as the markdown link
// `[Title](hachiman:page/<pageId>)` (components/docs/page-links.ts, PAGE_HREF_PREFIX).
// That module loads the editor, so the chat parses the same format here.

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** A markdown page link, or a bare `hachiman:page/<id>`. Group 1 or 2 is the page id. */
const PAGE_LINK = new RegExp(
  `\\[[^\\]\\n]*\\]\\(hachiman:page/(${ID})\\)|hachiman:page/(${ID})`,
  'gi'
)

/** The ids of the pages that `text` links to, first link first, without repeats. */
export function pageLinksOf(text: string): string[] {
  const ids: string[] = []
  for (const m of text.matchAll(PAGE_LINK)) {
    const id = (m[1] ?? m[2]).toLowerCase()
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/** `text` without its page links: the page cards under the message show them. */
export function stripPageLinks(text: string): string {
  return text
    .replace(PAGE_LINK, '')
    .replace(/[ \t]+$/gm, '')
    .trim()
}
