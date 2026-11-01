import { useEffect, useRef, useState } from 'react'
import {
  CaptureUpdateAction,
  Excalidraw,
  reconcileElements,
  restoreElements
} from '@excalidraw/excalidraw'
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile'
import type {
  AppState,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId
} from '@excalidraw/excalidraw/types'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import '@excalidraw/excalidraw/index.css'
import { useResolvedTheme } from '@/hooks/use-native-appearance'
import type { DocHandle } from '@/services/docs/types'
import { useDocsStore } from '@/stores/docsStore'
import { bindFiles, type CanvasFiles } from './canvas-assets'
import { elementsOf, observeElements, pushElements } from './canvas-sync'

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

// The fonts are files of the app (vite-excalidraw-fonts.ts): the CSP allows no CDN.
window.EXCALIDRAW_ASSET_PATH = new URL(
  `${import.meta.env.BASE_URL}excalidraw/`,
  `${window.location.origin}/`
).href

const UI_OPTIONS = {
  // Open and save replace the scene from a file: the canvas is the channel's, not a file's.
  canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false }
} as const

/**
 * One canvas: Excalidraw over the page's Y.Doc (canvas-sync.ts), with its images as encrypted page
 * media (canvas-assets.ts). The cursors of the other viewers come from the page awareness, and
 * only from the peers that DocAwareness verified (docsStore presence). Links that Excalidraw can
 * embed (YouTube, Vimeo, Figma, ...) become embeds; other links stay text, so nothing fetches them.
 */
export default function CanvasView({
  handle,
  canEdit
}: {
  handle: DocHandle
  canEdit: boolean
}): React.JSX.Element {
  const [initial] = useState(() => ({
    elements: restoreElements([...elementsOf(handle.doc).values()], null)
  }))
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const files = useRef<CanvasFiles | null>(null)
  const theme = useResolvedTheme()

  useEffect(() => {
    if (!api) return
    const f = bindFiles(handle.doc, handle.pageId, api)
    files.current = f
    const offElements = observeElements(handle.doc, (remote) => {
      const elements = reconcileElements(
        api.getSceneElementsIncludingDeleted(),
        restoreElements(remote, null) as RemoteExcalidrawElement[],
        api.getAppState()
      )
      api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER })
      f.load()
    })
    const offPresence = bindPresence(api, handle)
    return () => {
      files.current = null
      f.unbind()
      offElements()
      offPresence()
    }
  }, [api, handle])

  const onChange = (
    elements: readonly OrderedExcalidrawElement[],
    _state: AppState,
    binary: BinaryFiles
  ): void => {
    if (!canEdit) return
    pushElements(handle.doc, elements)
    files.current?.push(binary)
  }

  return (
    // The drawer swipes of the mobile shell stay off the canvas.
    <div data-swipe-ignore className="relative min-h-0 flex-1 touch-none">
      <div className="absolute inset-0">
        <Excalidraw
          initialData={initial}
          excalidrawAPI={setApi}
          onChange={onChange}
          onPointerUpdate={({ pointer }) =>
            handle.awareness.setLocalStateField('cursor', { x: pointer.x, y: pointer.y })
          }
          viewModeEnabled={!canEdit}
          isCollaborating
          theme={theme}
          UIOptions={UI_OPTIONS}
        />
      </div>
    </div>
  )
}

interface Cursor {
  x: number
  y: number
}

const isCursor = (c: unknown): c is Cursor => {
  const v = c as Partial<Cursor> | null
  return (
    typeof v?.x === 'number' &&
    Number.isFinite(v.x) &&
    typeof v.y === 'number' &&
    Number.isFinite(v.y)
  )
}

/** The cursors of the verified peers into the scene's collaborators. */
function bindPresence(api: ExcalidrawImperativeAPI, handle: DocHandle): () => void {
  const { awareness, pageId } = handle
  const sync = (): void => {
    const peers = useDocsStore.getState().presence.get(pageId) ?? []
    const states = awareness.getStates()
    const collaborators = new Map<SocketId, Collaborator>()
    for (const peer of peers) {
      const cursor = states.get(peer.clientId)?.cursor as unknown
      if (!isCursor(cursor)) continue
      collaborators.set(String(peer.clientId) as SocketId, {
        id: peer.userId,
        username: peer.name,
        color: { background: peer.color, stroke: peer.color },
        pointer: { x: cursor.x, y: cursor.y, tool: 'pointer' }
      })
    }
    api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER })
  }
  // DocAwareness listens first, so the presence in the store is current here.
  awareness.on('change', sync)
  sync()
  return () => {
    awareness.off('change', sync)
    awareness.setLocalStateField('cursor', null)
  }
}
