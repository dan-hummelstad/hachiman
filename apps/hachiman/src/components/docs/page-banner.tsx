import { useEffect, useId, useRef, useState } from 'react'
import { FileText, ImagePlus, Trash2 } from 'lucide-react'
import { PROFILE_IMAGE_TYPES } from '@hachiman/client'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/ui/icon-button'
import { useAction } from '@/hooks/use-action'
import { useDecryptedBlob } from '@/hooks/use-decrypted-blob'
import { usePageBanner, type PageBannerState } from '@/hooks/use-page-banner'
import { cn } from '@/lib/utils'
import { docsService } from '@/services/docs/DocsService'
import { PROFILE_IMAGE_FORMATS, claimErrorText, ensureLimits } from '@/services/UploadService'
import type { PageVariant } from './page-parts'

/*
 * The banner of a page (contract §12.20 doc_banner): the encrypted image of its top-level page.
 * Sub-pages show the banner of their top-level page, read-only. An editor (SEND_MESSAGES) adds,
 * changes and removes it on the top-level page only. The image shows only as the object URL of
 * the decrypted blob (useDecryptedBlob), never as a file URL. Log only the upload id.
 */

const ACCEPTED: readonly string[] = PROFILE_IMAGE_TYPES

/** What the banner area of a page shows. */
export interface BannerView {
  /**
   * Nothing, the image (or the upload preview), or the editor's "Add banner" control. With an
   * image, `screen` puts the 62 page tile over the lower edge of the banner.
   */
  show: 'nothing' | 'image' | 'add'
  /** Change and Remove: an editor on the top-level page. */
  controls: boolean
}

const NOTHING: BannerView = { show: 'nothing', controls: false }
const ADD: BannerView = { show: 'add', controls: false }
const IMAGE: BannerView = { show: 'image', controls: false }
const IMAGE_EDIT: BannerView = { show: 'image', controls: true }

/**
 * The view of the banner of a page. Nothing for an orphan (no top-level page above it), and
 * nothing while the banner is not known, so "Add banner" does not flicker. `previewing`: a picked
 * image of the top-level page uploads, and shows in place of the banner.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function bannerView(
  state: PageBannerState,
  canEdit: boolean,
  previewing: boolean
): BannerView {
  if (state.rootId === null) return NOTHING
  const editor = canEdit && state.isRoot
  if (previewing) return editor ? IMAGE_EDIT : IMAGE
  if (!state.known) return NOTHING
  if (state.banner !== null) return editor ? IMAGE_EDIT : IMAGE
  return editor ? ADD : NOTHING
}

/** The banner of one page, and the editor's actions on it. One per page view. */
export interface PageBannerControl {
  view: BannerView
  /** The upload preview, else the decrypted banner. null while it loads. */
  src: string | null
  /** The decrypted thumbnail while the banner loads, shown blurred. */
  thumb: string | null
  /** A picked image uploads: its preview shows under a veil. */
  uploading: boolean
  /** 0..1 of the upload. */
  progress: number
  busy: boolean
  error: string | null
  clearError: () => void
  /** Spread on the one hidden `<input type="file">` (PageBanner mounts it). */
  input: React.ComponentProps<'input'> & { ref: React.RefObject<HTMLInputElement | null> }
  /** Opens the file picker. Call it in the tap or click: iOS opens it only inside a gesture. */
  pick: () => void
  remove: () => void
}

/**
 * The banner of `pageId` and the editor's actions: pick an image, which is re-encoded,
 * encrypted, uploaded and set in one PATCH (DocsService.setBanner), or remove it. The picked file
 * shows as a local preview until the decrypted banner shows; its object URL is revoked then, on
 * an error and on unmount. Only a new pick aborts an upload: an unmount (Back, another right
 * column tab) lets it finish, and DocsService.setBanner writes the banner to docsStore.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function usePageBannerControl(
  channelId: string,
  pageId: string,
  canEdit: boolean
): PageBannerControl {
  const id = useId()
  const ref = useRef<HTMLInputElement>(null)
  const state = usePageBanner(channelId, pageId)
  const { run, busy, error, setError, clearError } = useAction()
  // `base`: the upload id of the banner that the preview replaces.
  const [preview, setPreview] = useState<{
    rootId: string
    url: string
    base: string | null
  } | null>(null)
  const [progress, setProgress] = useState(0)
  const inflight = useRef<AbortController | null>(null)

  const full = useDecryptedBlob(state.banner)
  const thumb = useDecryptedBlob(full.url === null ? (state.banner?.thumbnail ?? null) : null)

  useEffect(ensureLimits, [])
  useEffect(() => {
    if (!preview) return undefined
    return () => URL.revokeObjectURL(preview.url)
  }, [preview])

  // The saved banner took over (or the save gave none): the preview goes.
  if (
    preview &&
    !busy &&
    preview.rootId === state.rootId &&
    (state.banner?.uploadId ?? null) !== preview.base &&
    (state.banner === null || full.url !== null || full.error !== null)
  )
    setPreview(null)

  const previewing = preview !== null && preview.rootId === state.rootId
  const view = bannerView(state, canEdit, previewing)

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = '' // so picking the same file again still fires change
    const rootId = state.rootId
    if (!file || rootId === null || rootId !== pageId) return
    if (!ACCEPTED.includes(file.type)) {
      setError(`Could not set the banner: use a ${PROFILE_IMAGE_FORMATS} image.`)
      return
    }
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    const { signal } = controller
    setProgress(0)
    setPreview({ rootId, url: URL.createObjectURL(file), base: state.banner?.uploadId ?? null })
    const saved = await run('set the banner', () =>
      docsService
        .setBanner(rootId, file, { signal, onProgress: setProgress })
        .catch((err: unknown) => {
          if (signal.aborted) throw err
          throw new Error(claimErrorText(err), { cause: err })
        })
    )
    if (!saved.ok && inflight.current === controller) setPreview(null)
  }

  const remove = (): void => {
    const rootId = state.rootId
    if (rootId === null || rootId !== pageId) return
    setPreview(null)
    void run('remove the banner', () => docsService.removeBanner(rootId))
  }

  return {
    view,
    src: previewing ? preview.url : full.url,
    thumb: previewing ? null : thumb.url,
    uploading: previewing && busy,
    progress,
    busy,
    error,
    clearError,
    input: {
      ref,
      id,
      type: 'file',
      accept: ACCEPTED.join(','),
      className: 'hidden',
      tabIndex: -1,
      'aria-hidden': true,
      disabled: busy,
      onChange: (e) => void onChange(e)
    },
    pick: () => ref.current?.click(),
    remove
  }
}

/** The image of the banner: the blurred thumbnail while it loads, then the image. Decorative. */
function BannerImage({
  control,
  className
}: {
  control: PageBannerControl
  className: string
}): React.JSX.Element {
  const { src, thumb, uploading, progress } = control
  return (
    <div className={cn('bg-surface-window relative shrink-0 overflow-hidden', className)}>
      {src === null && thumb !== null && (
        <img
          src={thumb}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full scale-110 object-cover blur-md"
        />
      )}
      {src !== null && (
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full object-cover"
        />
      )}
      {uploading && (
        <span className="bg-surface-window/60 absolute inset-0 flex items-end">
          <span
            role="progressbar"
            aria-label="Uploading the banner"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="bg-accent-primary h-0.5 transition-[width]"
            style={{ width: `${Math.max(4, progress * 100)}%` }}
          />
        </span>
      )}
    </div>
  )
}

/** Desktop: "Add banner" at the right end of the path row (Breadcrumb `trailing`). */
export function AddBannerButton({ control }: { control: PageBannerControl }): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={control.busy}
      onClick={control.pick}
      className="text-text-tertiary hover:text-text-primary hover:bg-surface-hover focus-visible:outline-line-focus -my-1 inline-flex h-6 shrink-0 items-center gap-1 px-1.5 text-xs font-semibold outline-none focus-visible:outline-2 disabled:opacity-50"
    >
      <ImagePlus className="size-3.5" aria-hidden />
      Add banner
    </button>
  )
}

/**
 * The banner area of a page. `panel` (desktop, C1): a 120 high image over the full width, with
 * Change and Remove at the top right on hover or focus for the editor; "Add banner" is in the path
 * row (AddBannerButton) and in More. `screen` (the phone, M38): a 116 high image with the 62 page
 * tile over its lower edge and the Change chip at its bottom right, or the "Add banner" row.
 * Nothing shows while the banner is not known. The hidden file input is always mounted here,
 * outside any menu or sheet, since those unmount on close.
 */
export function PageBanner({
  control,
  variant = 'panel'
}: {
  control: PageBannerControl
  variant?: PageVariant
}): React.JSX.Element {
  const { view } = control
  const input = <input {...control.input} />
  if (variant === 'screen') {
    return (
      <>
        {input}
        {view.show === 'image' && (
          <div className="flex shrink-0 flex-col">
            <div className="relative">
              <BannerImage control={control} className="h-[116px]" />
              {view.controls && <ScreenChangeChip control={control} />}
            </div>
            <div aria-hidden className="-mt-[30px] px-5">
              <span className="border-surface-content relative flex size-[62px] items-center justify-center border-3 bg-[color-mix(in_oklab,var(--feature-page)_12%,var(--surface-content))]">
                <FileText className="text-feature-page-text size-[30px]" />
              </span>
            </div>
          </div>
        )}
        {view.show === 'add' && (
          <button
            type="button"
            disabled={control.busy}
            onClick={control.pick}
            className="text-text-tertiary active:text-text-primary focus-visible:outline-line-focus flex h-9 shrink-0 items-center gap-1 px-5 text-xs font-semibold outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:opacity-50"
          >
            <ImagePlus className="size-3.5" aria-hidden />
            Add banner
          </button>
        )}
        {control.error && <BannerError control={control} variant={variant} />}
      </>
    )
  }
  return (
    <>
      {input}
      {view.show === 'image' && (
        <div className="group/banner relative shrink-0">
          <BannerImage control={control} className="h-[120px]" />
          {view.controls && (
            <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-focus-within/banner:opacity-100 group-hover/banner:opacity-100">
              <IconButton
                label="Change banner"
                tooltipSide="bottom"
                disabled={control.busy}
                onClick={control.pick}
                className="bg-black/45 text-white hover:bg-black/65 hover:text-white"
              >
                <ImagePlus />
              </IconButton>
              <IconButton
                label="Remove banner"
                tooltipSide="bottom"
                disabled={control.busy}
                onClick={control.remove}
                className="bg-black/45 text-white hover:bg-black/65 hover:text-white"
              >
                <Trash2 />
              </IconButton>
            </div>
          )}
        </div>
      )}
      {control.error && <BannerError control={control} variant={variant} />}
    </>
  )
}

/** A failed save or remove, until the user closes it or tries again. */
function BannerError({
  control,
  variant
}: {
  control: PageBannerControl
  variant: PageVariant
}): React.JSX.Element {
  return (
    <p
      role="alert"
      className={cn(
        'text-feature-danger-text flex shrink-0 items-start gap-2 text-xs',
        variant === 'screen' ? 'px-5 pt-2' : 'px-16 pt-3'
      )}
    >
      <span className="min-w-0 flex-1">{control.error}</span>
      <button
        type="button"
        onClick={control.clearError}
        className={cn(
          'text-text-tertiary hover:text-text-primary shrink-0 font-semibold',
          variant === 'screen' && 'relative after:absolute after:-inset-3'
        )}
      >
        Dismiss
      </button>
    </p>
  )
}

/**
 * The phone's Change chip (M38): a 28 visual in a 36 hit area at the bottom right of the banner.
 * It opens Choose image and Remove banner (a menu sheet on the phone). Choose image opens the
 * picker in the tap, so iOS shows it.
 */
function ScreenChangeChip({ control }: { control: PageBannerControl }): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Change banner"
          disabled={control.busy}
          className="focus-visible:outline-line-focus absolute right-2 bottom-1 flex size-9 items-center justify-center outline-none focus-visible:outline-2 disabled:opacity-50"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-black/40 text-white">
            <ImagePlus className="size-4" aria-hidden />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Page banner" align="end">
        <DropdownMenuItem onSelect={control.pick}>
          <ImagePlus />
          Choose image
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={control.remove}>
          <Trash2 />
          Remove banner
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
