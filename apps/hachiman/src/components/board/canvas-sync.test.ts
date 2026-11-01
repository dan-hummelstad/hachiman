import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { elementsOf, observeElements, pushElements } from './canvas-sync'

/** Two docs that pass every update to each other, as the DocProvider does over the DS. */
function linkedDocs(): [Y.Doc, Y.Doc] {
  const a = new Y.Doc()
  const b = new Y.Doc()
  a.on(
    'update',
    (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b, u, 'remote')
  )
  b.on(
    'update',
    (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(a, u, 'remote')
  )
  return [a, b]
}

const el = (id: string, version: number, extra: object = {}): ExcalidrawElement =>
  ({ id, type: 'rectangle', version, versionNonce: version, isDeleted: false, ...extra }) as never

describe('canvas sync', () => {
  it('sends changed elements once and passes only remote ones to the scene', () => {
    const [docA, docB] = linkedDocs()
    const seenA: ExcalidrawElement[][] = []
    const seenB: ExcalidrawElement[][] = []
    observeElements(docA, (r) => seenA.push(r))
    observeElements(docB, (r) => seenB.push(r))

    pushElements(docA, [el('x', 1), el('y', 1)])
    expect(seenA).toEqual([])
    expect(
      seenB
        .flat()
        .map((e) => e.id)
        .sort()
    ).toEqual(['x', 'y'])

    // The same versions again (onChange after a pointer move, or the echo of a remote change).
    pushElements(docB, [el('x', 1), el('y', 1)])
    expect(seenA).toEqual([])

    pushElements(docB, [el('x', 2, { isDeleted: true }), el('y', 1)])
    expect(seenA).toEqual([[el('x', 2, { isDeleted: true })]])
    expect(elementsOf(docA).get('x')?.isDeleted).toBe(true)
  })

  it('sends an element again after Excalidraw mutates it in place', () => {
    const [docA, docB] = linkedDocs()
    const stroke = el('s', 1, { points: [[0, 0]] }) as ExcalidrawElement & {
      version: number
      versionNonce: number
      points: number[][]
    }
    pushElements(docA, [stroke])
    stroke.points = [...stroke.points, [5, 5]]
    stroke.version = 2
    stroke.versionNonce = 2
    pushElements(docA, [stroke])
    expect(elementsOf(docB).get('s')).toMatchObject({
      version: 2,
      points: [
        [0, 0],
        [5, 5]
      ]
    })
  })
})
