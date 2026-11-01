/**
 * Binds an Excalidraw scene to the Y.Doc of a canvas page (contract §4 Pages, §12.20): each element
 * is one entry of the `excalidraw` Y.Map, keyed by element id. A delete is the element with
 * `isDeleted`, as in Excalidraw. The `files` Y.Map holds the attachment pointer of each image file
 * (canvas-assets.ts). The DocProvider encrypts and sends the Y.Doc as it does for a markdown page.
 */
import * as Y from 'yjs'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'

const LOCAL = 'excalidraw'

export const elementsOf = (doc: Y.Doc): Y.Map<ExcalidrawElement> =>
  doc.getMap<ExcalidrawElement>('excalidraw')

/** fileId → attachment pointer JSON. */
export const filesOf = (doc: Y.Doc): Y.Map<string> => doc.getMap<string>('files')

/**
 * The local scene into the doc: only the elements whose version moved. Excalidraw calls onChange
 * for every pointer move, and a remote change that the scene took has the doc's version already.
 */
// ponytail: an O(n) scan per onChange, and deleted elements stay as tombstones; prune them if canvases grow large.
export function pushElements(doc: Y.Doc, elements: readonly ExcalidrawElement[]): void {
  const map = elementsOf(doc)
  const changed = elements.filter((el) => {
    const prev = map.get(el.id)
    return !prev || prev.version !== el.version || prev.versionNonce !== el.versionNonce
  })
  if (changed.length === 0) return
  doc.transact(() => {
    // A copy: Excalidraw mutates its elements in place, which would change the doc's value too, so
    // the next version would compare equal and never go out.
    for (const el of changed) map.set(el.id, structuredClone(el))
  }, LOCAL)
}

/** Calls `apply` with the elements that other members changed. Returns the unbind. */
export function observeElements(
  doc: Y.Doc,
  apply: (remote: ExcalidrawElement[]) => void
): () => void {
  const map = elementsOf(doc)
  const on = (e: Y.YMapEvent<ExcalidrawElement>, tr: Y.Transaction): void => {
    if (tr.origin === LOCAL) return
    const remote = [...e.keysChanged].flatMap((id) => map.get(id) ?? [])
    if (remote.length > 0) apply(remote)
  }
  map.observe(on)
  return () => map.unobserve(on)
}
