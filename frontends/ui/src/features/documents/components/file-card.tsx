'use client'

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import Image from 'next/image'
import { isOptimizerEligible } from '@/lib/images/optimizable'
import type { FileItem } from './project-file-workspace'
import { formatAbsoluteTime, formatBytes, formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import { sourceTint } from '@/lib/ui/source-tint'
import { extChipTint, fileExtensionLabel, inferDocumentKind } from '../document-kind'
import { DocumentKindThumbnail } from './document-kind-thumbnail'
import { DocumentStatusBadge, isCitableStatus, isSettlingStatus } from './document-status'
import { SemanticMatch } from './semantic-match'
import { RaisedCard, RaisedCardBody, RaisedCardFooter, RaisedCardMedia } from '@/components/ui/raised-card'
import { Skeleton } from '@/components/ui/skeleton'

/** Provenance tint per corpus, from the shared `--source-*` token family. */
const SOURCE_TINT: Record<'projekt' | 'buero', CSSProperties> = {
  projekt: sourceTint('project'),
  buero: sourceTint('office'),
}

/** Thumbnail request lifecycle for a single card. */
type ThumbState = 'loading' | 'ready' | 'none' | 'error'

/**
 * Module-level de-dup cache — one thumbnail resolution per file id for the page
 * lifetime, mirroring the `indexCache` pattern in `use-surfaced-documents`. It
 * stops the request thrashing when a card's file object is remapped each render.
 * A genuine failure rejects and is evicted so a later mount can retry; a
 * resolved "no thumbnail" (null url) stays cached — unless the document was
 * still being read when we asked (see {@link loadThumbnail}).
 */
const thumbnailCache = new Map<string, Promise<string | null>>()

/** Test hook — clears the module cache between specs. */
export const resetThumbnailCache = (): void => {
  thumbnailCache.clear()
}

/**
 * Resolve a file's thumbnail url. `/api/documents/{id}/thumbnail` returns 200
 * with `{ url: null }` (or 404) when no thumbnail exists — that's NOT a failure,
 * it resolves to `null`. Any other non-ok status (5xx, network) rejects into the
 * genuine-error state so the card can tell "no thumbnail" from "failed to load".
 *
 * `provisional` marks a document that is still being ingested. "No thumbnail"
 * is then an answer about right now, not about the file: the page render lands
 * during ingestion, so a card that asked a second too early would otherwise keep
 * the sketch placeholder for the whole page lifetime and only show the real
 * preview after a reload. Such a miss is evicted so the re-ask that follows the
 * status transition actually reaches the route.
 */
function loadThumbnail(fileId: string, provisional = false): Promise<string | null> {
  const existing = thumbnailCache.get(fileId)
  if (existing) return existing
  const promise = fetch(`/api/documents/${fileId}/thumbnail`)
    .then((r) => {
      if (!r.ok) {
        if (r.status === 404) return null
        throw new Error(`thumbnail ${r.status}`)
      }
      return r.json()
    })
    .then((data) => (data && typeof data.url === 'string' ? data.url : null))
    .then((url) => {
      if (url === null && provisional) thumbnailCache.delete(fileId)
      return url
    })
  // Evict a rejected resolution so a later mount can retry (successes stay cached).
  promise.catch(() => thumbnailCache.delete(fileId))
  thumbnailCache.set(fileId, promise)
  return promise
}

/**
 * Lazy-load the thumbnail image for a file card. While the request is in flight
 * a skeleton shows (never a jump straight to the fallback). When no thumbnail
 * exists it falls back to a WARM, content-aware placeholder — an image gets a
 * soft tile + format chip, never a lone glyph that mimics a broken image. Only a
 * GENUINE failure (5xx / network / broken image url) shows a distinct
 * "couldn't load" treatment. The route is scope-aware, so this serves both
 * project uploads and Büroarchiv documents by id.
 */
export function ThumbnailWithFallback({ file }: { file: FileItem }) {
  const t = useTranslations('files')
  const kind = inferDocumentKind(file)
  const canHaveThumbnail = file.contentType === 'application/pdf' || (file.contentType ?? '').startsWith('image/')
  const [state, setState] = useState<ThumbState>(canHaveThumbnail ? 'loading' : 'none')
  const [imgUrl, setImgUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!canHaveThumbnail) {
      setState('none')
      return
    }
    let cancelled = false
    setState('loading')
    loadThumbnail(file.id, isSettlingStatus(file.status))
      .then((url) => {
        if (cancelled) return
        if (url) {
          setImgUrl(url)
          setState('ready')
        } else {
          setState('none')
        }
      })
      .catch(() => {
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
    }
    // `file.status` is a dependency, not noise: it is the signal that a document
    // which had no preview when the page loaded has finished being read, and so
    // the moment to ask the route again.
  }, [file.id, canHaveThumbnail, file.status])

  if (state === 'ready' && imgUrl) {
    return (
      // `fill` against the card's positioned thumbnail well: the URL announces
      // no intrinsic dimensions, and this is the shape next/image gives you for
      // that — it supplies the inset-0 sizing the plain tag used to spell out by
      // hand. `sizes` describes the card's well so the optimizer picks a width
      // for it rather than assuming the viewport.
      //
      // The thumbnail route hands back a same-origin signed path, which is what
      // makes it optimizable at all; `unoptimized` covers the fallback to a
      // presigned object-store URL when signing is unavailable.
      <Image
        src={imgUrl}
        alt=""
        fill
        sizes="(min-width: 1280px) 240px, (min-width: 768px) 33vw, 50vw"
        unoptimized={!isOptimizerEligible(imgUrl)}
        className="object-cover"
        // A url that resolves but won't render is a genuine failure, not "no thumbnail".
        onError={() => setState('error')}
      />
    )
  }

  if (state === 'loading') {
    return <Skeleton className="absolute inset-0 h-full w-full rounded-none" data-testid="thumbnail-skeleton" />
  }

  const ext = fileExtensionLabel(file.filename)
  return (
    <DocumentKindThumbnail
      kind={kind}
      variant="fill"
      formatLabel={ext || t('thumbnail.image')}
      failed={state === 'error'}
      failedLabel={t('thumbnail.unavailable')}
    />
  )
}

export interface FileCardProps {
  file: FileItem
  isSelected: boolean
  onSelect: () => void
  locale: string
  /** Present on a semantic/surfaced result: the snippet + page + score to show WHY it matched. */
  match?: { snippet: string; page: number | null; score: number }
  /** Coarse corpus for a provenance chip in the metadata row (project vs Büroarchiv). */
  source?: 'projekt' | 'buero' | null
  /** Localized label for the provenance chip. */
  sourceLabel?: string
  /** Hide the ingestion-status badge when the document is `ready` (noise in a
   * discovery context where every surfaced document is already ingested). */
  hideStatusWhenReady?: boolean
  /** Accessible label for the click action (defaults to the filename content). */
  ariaLabel?: string
  /** Dim + progress cursor while an action (e.g. opening) resolves. */
  isBusy?: boolean
  /** Extra footer content on the left of the size · time strip. */
  footerLead?: ReactNode
  /** Drop the size · time footer (chat surfacing — Files-browser chrome). */
  hideFooter?: boolean
  /** Override the card's test id (e.g. the Archiv surface keeps its own). */
  testId?: string
  /**
   * Rename / delete / download, rendered on the card so the reader does not
   * have to open the preview to act on a file (#435). Must be a control of
   * its own — this card is a `<button>`, so the slot sits beside it.
   */
  actions?: ReactNode
}

/**
 * One document card in the raised "project-selector" anatomy: a white content
 * block (thumbnail, provenance/extension chips, name, one-line description or
 * match evidence) sitting proud of a subtle outer surface, a footer tab with
 * size · time, and a spring hover-lift. Shared by the Files browser and the chat
 * `document_grid` surfacing card. Chat passes {@link FileCardProps.hideFooter}
 * and no {@link FileCardProps.match} — ranking chrome stays in Files search.
 */
export function FileCard({
  file,
  isSelected,
  onSelect,
  locale,
  match,
  source,
  sourceLabel,
  hideStatusWhenReady,
  ariaLabel,
  isBusy,
  footerLead,
  hideFooter,
  testId = 'file-card',
  actions,
}: FileCardProps) {
  const t = useTranslations('files')
  const name = documentDisplayName(file)
  const ext = fileExtensionLabel(file.filename)
  const isFailed = file.status === 'failed'
  const failureReason = isFailed ? file.errorMessage || t('preview.ingestionFailedGeneric') : undefined
  const showStatus = !!file.status && !(hideStatusWhenReady && isCitableStatus(file.status))
  // The AI summary is the last thing ingestion produces, so a document that is
  // still being read has an empty description slot. Left blank it reads as a
  // card that failed to render; skeleton lines say the sentence is on its way —
  // the same promise the thumbnail well makes while its request is in flight.
  const isAwaitingSummary = !match && !isFailed && !file.summary && isSettlingStatus(file.status)

  return (
    <RaisedCard
      interactive
      className={cn('group/card', isSelected && 'ring-2 ring-ring', isBusy && 'cursor-progress opacity-70')}
    >
      {actions && (
        <div
          className="absolute left-1.5 top-1.5 z-[1]"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {actions}
        </div>
      )}
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={isSelected}
        aria-label={ariaLabel}
        aria-busy={isBusy}
        data-testid={testId}
        className="group relative flex h-full w-full min-w-0 flex-col overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {/* Raised inner block — white surface, rounded bottom, soft divider shadow.
            `flex-1` because a grid row is only as tall as its tallest card and
            every cell stretches to match: a document that is still being read has
            no summary yet, so without it the short tile kept its natural height,
            its size · time footer floated in the middle of the cell, and the
            leftover height showed as a band of dead surface underneath. Growing
            the white block instead puts every footer on the bottom edge, so the
            row reads as one strip whatever each card carries above it. */}
        <RaisedCardBody className={cn('flex-1 p-0', hideFooter && 'rounded-none')}>
          <RaisedCardMedia className="h-[124px]">
            <ThumbnailWithFallback file={file} />
            {showStatus && (
              <DocumentStatusBadge
                status={file.status}
                // The 80% alpha is load-bearing: this badge floats over a document
                // thumbnail, and with `backdrop-blur-sm` it frosts the image
                // underneath instead of hiding it.
                className="absolute right-2 top-2 border-transparent bg-background/80 px-1.5 py-0 text-xs font-medium leading-4 shadow-2xs backdrop-blur-sm"
              />
            )}
          </RaisedCardMedia>

          <div className="px-3.5 pb-3 pt-[11px]">
            <div className="flex items-center gap-2">
              {source && sourceLabel && (
                <span
                  className="inline-flex shrink-0 items-center rounded-sm px-2 py-[3px] text-xs font-semibold leading-none tracking-[0.02em]"
                  style={SOURCE_TINT[source]}
                >
                  {sourceLabel}
                </span>
              )}
              <span className="flex-1" />
              {ext !== '' && (
                <span
                  className="inline-flex shrink-0 items-center rounded-sm px-1.5 py-[2.5px] text-[10.5px] font-bold uppercase leading-none tracking-wider"
                  style={extChipTint(ext)}
                >
                  {ext}
                </span>
              )}
            </div>

            {/* The name the document goes by. The format chip beside it still
                comes from the FILE name, because that is what the bytes are —
                a rename changes the label, never the format. */}
            <p className="mt-[10px] truncate text-xs font-medium leading-[1.4] text-foreground" title={name}>
              {name}
            </p>
            {match ? (
              <SemanticMatch snippet={match.snippet} page={match.page} score={match.score} />
            ) : isFailed ? (
              <p className="mt-1 line-clamp-2 text-xs leading-[1.45] text-destructive" title={failureReason}>
                {failureReason}
              </p>
            ) : isAwaitingSummary ? (
              // Two bars on the two lines the summary will occupy. Decorative:
              // the badge beside the thumbnail already says "Processing" in
              // words, and a screen reader should hear that once, not twice.
              <div className="mt-[7px] space-y-[7px]" aria-hidden data-testid="file-card-summary-skeleton">
                <Skeleton className="h-[7px] w-full rounded-sm" />
                <Skeleton className="h-[7px] w-[58%] rounded-sm" />
              </div>
            ) : (
              file.summary && (
                <p className="mt-1 line-clamp-2 text-xs leading-[1.45] text-muted-foreground" title={file.summary}>
                  {file.summary}
                </p>
              )
            )}
          </div>
        </RaisedCardBody>

        {!hideFooter && (
          <RaisedCardFooter className="gap-1.5 px-3.5 pb-2.5 pt-[9px] text-xs text-muted-foreground/80">
            {footerLead ?? <span className="flex-1" />}
            <span className="shrink-0 tabular-nums">{formatBytes(file.fileSize, locale)}</span>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <time
              dateTime={file.createdAt}
              title={formatAbsoluteTime(file.createdAt, locale)}
              suppressHydrationWarning
              className="shrink-0 tabular-nums"
            >
              {formatRelativeTime(file.createdAt, locale)}
            </time>
          </RaisedCardFooter>
        )}
      </button>
    </RaisedCard>
  )
}
