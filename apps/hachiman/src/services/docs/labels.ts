import type * as Y from 'yjs'

/** Page labels ("RFC", "Draft", N21.4): content of the page, so they live in the encrypted Y.Doc. */
export const MAX_PAGE_LABELS = 5
export const MAX_PAGE_LABEL_LENGTH = 24
const META_MAP = 'meta'
const LABELS_KEY = 'labels'

/** Trimmed, non-empty, at most MAX_PAGE_LABEL_LENGTH characters, no duplicates (case-insensitive), at most MAX_PAGE_LABELS. */
export function normalizeLabels(labels: readonly unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const l of labels) {
    if (typeof l !== 'string') continue
    const label = l.trim().slice(0, MAX_PAGE_LABEL_LENGTH)
    const key = label.toLowerCase()
    if (label === '' || seen.has(key)) continue
    seen.add(key)
    out.push(label)
    if (out.length === MAX_PAGE_LABELS) break
  }
  return out
}

/** The labels of a page: Y.Map 'meta', key 'labels' (a string array). A remote value is checked. */
export function pageLabels(doc: Y.Doc): string[] {
  const value: unknown = doc.getMap(META_MAP).get(LABELS_KEY)
  return Array.isArray(value) ? normalizeLabels(value) : []
}

/** Sets the labels as one local edit: it goes out encrypted like any other edit of the page. */
export function setPageLabels(doc: Y.Doc, labels: readonly string[]): void {
  doc.getMap(META_MAP).set(LABELS_KEY, normalizeLabels(labels))
}

/** Calls `cb` with the labels after each change of them (local or remote). Returns the unsubscribe. */
export function observeLabels(doc: Y.Doc, cb: (labels: string[]) => void): () => void {
  const meta = doc.getMap(META_MAP)
  const onChange = (e: Y.YMapEvent<unknown>): void => {
    if (e.keysChanged.has(LABELS_KEY)) cb(pageLabels(doc))
  }
  meta.observe(onChange)
  return () => meta.unobserve(onChange)
}
