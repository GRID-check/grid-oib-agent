/**
 * SourcePreview (WS-9, spec §6 / backlog FB-4) — clicking a citation/source
 * chip opens a preview of the source instead of doing nothing.
 *
 * Behavior by resolved target (see `resolveCitationTarget`):
 *  - `url`      — Web / RIS chips keep linking out to the real source.
 *  - `document` — knowledge-layer citations that resolve to a project upload
 *                 or a base-corpus PDF open the EXISTING PdfViewerDialog
 *                 (presigned preview URL for project docs, the corpus stream
 *                 route for base docs), with a provenance-tinted header chip
 *                 and the cited passage ("Fundstelle") when one exists.
 *  - `info`     — unresolvable citations get a light popover (origin, title,
 *                 snippet) — never a broken viewer. Chips with nothing beyond
 *                 their label stay plain, non-interactive chips.
 *
 * Resolution data (project document list + base-corpus file list) is fetched
 * lazily through existing read APIs (`/api/documents?projectId=…`,
 * `/api/knowledge-base`) and cached module-wide per project for the lifetime
 * of the page — source lists change rarely within one chat visit.
 */

'use client'

import { useEffect, useState, type CSSProperties, type FC } from 'react'
import { ExternalLink, FileSearch } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import {
  SourceSignalChip,
  SourceSignalChipLink,
  iconForTint,
  sourceSignalStyle,
} from '@/features/layout/components/SourceSignalChip'
import type { SourceSignal, SourceTint } from '@/features/layout/lib/source-presets'
import type { AnswerSourceItem } from '../lib/answer-source-list'
import { useChatStore } from '../store'
import { CopySourceCitationButton } from './CopyCitation'
import {
  parseKbLocator,
  resolveCitationTarget,
  type AnswerSourceRef,
  type CitationTarget,
  type ProjectDocumentRef,
} from '../lib/answer-sources'
import { AuthorityTag } from './AuthorityTag'

// ---------------------------------------------------------------------------
// Lazy resolution index (project documents + base-corpus files)
// ---------------------------------------------------------------------------

export interface SourcePreviewIndex {
  projectDocuments: ProjectDocumentRef[]
  baseCorpusFiles: string[]
}

/** Module-wide cache: one fetch pair per project per page lifetime. */
const indexCache = new Map<string, Promise<SourcePreviewIndex>>()

/** Test hook — clears the module cache between specs. */
export const resetSourcePreviewIndexCache = (): void => {
  indexCache.clear()
}

const loadSourcePreviewIndex = (projectId: string | null): Promise<SourcePreviewIndex> => {
  const key = projectId ?? '__no-project__'
  const existing = indexCache.get(key)
  if (existing) return existing

  const promise = (async (): Promise<SourcePreviewIndex> => {
    const [docsResult, corpusResult] = await Promise.allSettled([
      projectId
        ? fetch(`/api/documents?projectId=${encodeURIComponent(projectId)}`).then((r) =>
            r.ok ? r.json() : null
          )
        : Promise.resolve(null),
      fetch('/api/knowledge-base').then((r) => (r.ok ? r.json() : null)),
    ])
    const docs = docsResult.status === 'fulfilled' ? docsResult.value?.documents : null
    const files = corpusResult.status === 'fulfilled' ? corpusResult.value?.files : null

    const projectDocuments: ProjectDocumentRef[] = Array.isArray(docs)
      ? docs
          .filter(
            (doc): doc is { id: string; filename: string; contentType?: string | null } =>
              !!doc && typeof doc.id === 'string' && typeof doc.filename === 'string'
          )
          .map((doc) => ({ id: doc.id, filename: doc.filename, contentType: doc.contentType ?? null }))
      : []

    // Only corpus files whose PDF actually exists on this deployment are
    // openable (index-only entries and removed files would 404 the viewer).
    const baseCorpusFiles: string[] = Array.isArray(files)
      ? files
          .filter(
            (file): file is { fileName: string; state?: string; origin?: string } =>
              !!file && typeof file.fileName === 'string'
          )
          .filter((file) => file.state !== 'removed' && file.origin !== 'index_only')
          .map((file) => file.fileName)
      : []

    return { projectDocuments, baseCorpusFiles }
  })()

  indexCache.set(key, promise)
  return promise
}

/**
 * Resolution index for the current project. Returns null until loaded (or
 * while disabled); on any fetch failure the lists degrade to empty, which
 * downgrades chips to info/plain — never a broken viewer.
 */
export const useSourcePreviewIndex = (
  projectId: string | null,
  enabled: boolean
): SourcePreviewIndex | null => {
  const [index, setIndex] = useState<SourcePreviewIndex | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    loadSourcePreviewIndex(projectId)
      .then((loaded) => {
        if (!cancelled) setIndex(loaded)
      })
      .catch(() => {
        if (!cancelled) setIndex({ projectDocuments: [], baseCorpusFiles: [] })
      })
    return () => {
      cancelled = true
    }
  }, [projectId, enabled])

  return enabled ? index : null
}

// ---------------------------------------------------------------------------
// Shared chip styling (mirrors SourceSignalChip's chip vocabulary)
// ---------------------------------------------------------------------------

// (The per-signal icon map used to be duplicated here "kept in sync with
// SourceSignalChip" by hand; it now comes from `iconForTint`, so the accent
// families cannot drift between the chip and the preview.)

const chipButtonClasses =
  'inline-flex h-6 max-w-full shrink-0 cursor-pointer items-center gap-1 truncate whitespace-nowrap ' +
  'rounded-md border px-2.5 text-xs font-medium transition-[color,background-color,box-shadow] ' +
  '[&>svg]:size-3 [&>svg]:shrink-0 hover:brightness-95 dark:hover:brightness-125 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ' +
  'disabled:cursor-progress disabled:opacity-70'

/**
 * The `[N]` a source carries in the answer prose, rendered inside its chip.
 *
 * This is the one thing the written source list held that a chip could not: it
 * is what an inline `[2]` in the answer points at. It uses the chip's own
 * currentColor vocabulary (same as AuthorityTag) so it reads as part of the
 * chip rather than as a new element bolted on.
 */
const CitationIndex: FC<{ index?: number }> = ({ index }) =>
  index == null ? null : (
    <span className="shrink-0 text-[10px] font-semibold tabular-nums opacity-60">{index}</span>
  )

// ---------------------------------------------------------------------------
// Document preview dialog (reuses the existing PdfViewerDialog machinery)
// ---------------------------------------------------------------------------

type DocumentTarget = Extract<CitationTarget, { kind: 'document' }>

/** Tinted "Fundstelle" / cited-passage box shown above the document frame. */
const CitedPassageBox: FC<{ snippet: string; signal: SourceTint }> = ({ snippet, signal }) => {
  const t = useTranslations('chat')
  const style: CSSProperties = {
    backgroundColor: `var(--source-${signal}-tint, var(--muted))`,
    borderColor: `color-mix(in oklch, var(--source-${signal}, var(--foreground)) 25%, transparent)`,
  }
  return (
    <div className="shrink-0 rounded-lg border px-3 py-2" style={style}>
      <p
        className="text-[10.5px] font-semibold uppercase tracking-[0.05em]"
        style={{ color: `var(--source-${signal}-text, var(--muted-foreground))` }}
      >
        {t('sourcePreview.citedPassage')}
      </p>
      <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-sm text-foreground">
        {snippet}
      </p>
    </div>
  )
}

/**
 * Open/fetch state for a document target. Project uploads need a fresh
 * presigned preview URL per open (they expire); base-corpus PDFs stream from
 * the knowledge-base route PdfViewerDialog already builds from `fileName`.
 * The dialog only ever opens with a renderable source — a failed presign
 * surfaces as a toast, not a broken viewer.
 */
const useDocumentPreview = (target: DocumentTarget, item?: AnswerSourceItem) => {
  const t = useTranslations('chat')
  const [isOpen, setIsOpen] = useState(false)
  const [isResolving, setIsResolving] = useState(false)
  const [src, setSrc] = useState<string | null>(null)

  const openPreview = async (): Promise<void> => {
    if (target.document.type === 'base') {
      setIsOpen(true)
      return
    }
    setIsResolving(true)
    try {
      const res = await fetch(`/api/documents/${target.document.id}/preview`)
      const data = res.ok ? await res.json() : null
      if (data?.url) {
        setSrc(data.url)
        setIsOpen(true)
      } else {
        toast.error(t('sourcePreview.loadFailed'))
      }
    } catch {
      toast.error(t('sourcePreview.loadFailed'))
    } finally {
      setIsResolving(false)
    }
  }

  const isImage =
    target.document.type === 'project' &&
    (target.document.contentType ?? '').toLowerCase().startsWith('image/')
  const headerSignal: SourceSignal = target.document.type === 'base' ? 'law' : 'project'

  const dialog = (
    <PdfViewerDialog
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open)
        if (!open) setSrc(null)
      }}
      fileName={target.document.type === 'base' ? target.document.fileName : target.document.filename}
      page={target.page ?? null}
      title={target.title}
      src={src ?? undefined}
      isImage={isImage}
      headerChip={
        <span className="flex items-center gap-2">
          <SourceSignalChip signal={headerSignal}>
            {t(
              target.document.type === 'base'
                ? 'sourcePreview.corpusDocument'
                : 'sourcePreview.projectDocument'
            )}
          </SourceSignalChip>
          {/* Same one-click citation the popover offers, for sources that open
              a document instead. */}
          {item && <CopySourceCitationButton item={item} />}
        </span>
      }
    >
      {target.snippet && <CitedPassageBox snippet={target.snippet} signal={headerSignal} />}
    </PdfViewerDialog>
  )

  return { isResolving, openPreview, dialog }
}

const DocumentPreviewChip: FC<{
  target: DocumentTarget
  signal: SourceTint
  label: string
  authority?: string
  className?: string
  /** The `[N]` this source carries in the answer prose, when known. */
  index?: number
  /** The full source row — powers the dialog's "copy citation" action. */
  item?: AnswerSourceItem
}> = ({ target, signal, label, authority, className, index, item }) => {
  const t = useTranslations('chat')
  const { isResolving, openPreview, dialog } = useDocumentPreview(target, item)
  const Icon = iconForTint(signal)
  return (
    <>
      <button
        type="button"
        className={cn(chipButtonClasses, 'max-w-56', className)}
        style={sourceSignalStyle(signal)}
        onClick={() => void openPreview()}
        disabled={isResolving}
        aria-busy={isResolving}
        aria-haspopup="dialog"
        aria-label={t('sourcePreview.chipAria', { label })}
        title={t('sourcePreview.chipAria', { label })}
      >
        <CitationIndex index={index} />
        <Icon aria-hidden="true" />
        {authority && <AuthorityTag>{authority}</AuthorityTag>}
        <span className="truncate">{label}</span>
      </button>
      {dialog}
    </>
  )
}

// ---------------------------------------------------------------------------
// Info popover (title + origin + snippet — no resolvable document)
// ---------------------------------------------------------------------------

type InfoTarget = Extract<CitationTarget, { kind: 'info' }>

const InfoPreviewChip: FC<{
  target: InfoTarget
  signal: SourceTint
  label: string
  authority?: string
  /** Fine authority tier ("OIB-Richtlinie", "Rechtsquelle (RIS)") for the popover. */
  tier?: string
  /** Bindingness note ("does this bind me?") from the norm registry. */
  bindingNote?: string
  /** Outbound link (RIS sources) shown as an "open" button inside the popover. */
  url?: string
  className?: string
  /** The `[N]` this source carries in the answer prose, when known. */
  index?: number
  /** Cited page / hostname — shown in the popover, not on the chip. */
  meta?: string
  /** The whole source row, for the popover's "copy citation" action. */
  item?: AnswerSourceItem
}> = ({ target, signal, label, authority, tier, bindingNote, url, className, index, meta, item }) => {
  const t = useTranslations('chat')
  const Icon = iconForTint(signal)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(chipButtonClasses, 'max-w-56', className)}
          style={sourceSignalStyle(signal)}
          aria-label={t('sourcePreview.chipAria', { label })}
          title={t('sourcePreview.chipAria', { label })}
        >
          <CitationIndex index={index} />
          <Icon aria-hidden="true" />
          {authority && <AuthorityTag>{authority}</AuthorityTag>}
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceSignalChip signal={signal}>
            {t(`sourcePreview.origins.${target.origin}`)}
          </SourceSignalChip>
          {tier && (
            <span className="text-[11px] font-medium text-muted-foreground">{tier}</span>
          )}
        </div>
        {/* The written source list's payload, one click away: the citation
            number, the untruncated title and the locator. */}
        <p className="break-words text-sm font-medium text-foreground">
          {index != null && (
            <span className="mr-1 text-muted-foreground">[{index}]</span>
          )}
          {target.title}
        </p>
        {meta && <p className="text-[11px] text-muted-foreground">{meta}</p>}
        {bindingNote && (
          <div
            className="rounded-md border-l-2 py-1.5 pl-2.5 pr-2"
            style={{
              borderColor: `color-mix(in oklch, var(--source-${signal}, var(--foreground)) 45%, transparent)`,
              backgroundColor: `var(--source-${signal}-tint, var(--muted))`,
            }}
          >
            <p
              className="text-[10px] font-semibold uppercase tracking-[0.05em]"
              style={{ color: `var(--source-${signal}-text, var(--muted-foreground))` }}
            >
              {t('sourcePreview.bindingLabel')}
            </p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-foreground">{bindingNote}</p>
          </div>
        )}
        {target.snippet && <CitedPassageBox snippet={target.snippet} signal={signal} />}
        <div className="flex items-center justify-between gap-2">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[12.5px] font-medium hover:underline"
              style={{ color: `var(--source-${signal}-text, var(--foreground))` }}
            >
              {t('sourcePreview.openExternal')}
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          ) : (
            <span />
          )}
          {item && <CopySourceCitationButton item={item} />}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// The chip — one answer source, rendered by its resolved target
// ---------------------------------------------------------------------------

export interface SourcePreviewChipProps {
  source: AnswerSourceRef
  /** Provenance tint for chip/icon (mapped by the caller from source.kind + lane). */
  signal: SourceTint
  /**
   * The full source row this chip stands for. Everything the answer's written
   * source list used to spell out — the citation number, the untruncated title,
   * the cited page or host, and a copyable citation — travels in here and is
   * shown BEHIND THE CLICK (popover / document dialog) instead of as a second
   * list under the answer. Optional: without it the chip behaves exactly as before.
   */
  item?: AnswerSourceItem
  /**
   * Cited page / host, localized by the caller — shown in the popover, never on
   * the chip (which stays the compact pill it always was).
   */
  meta?: string
  /** Layout override (width, truncation) for the caller's context. */
  className?: string
}

/**
 * One "Belegt durch" chip with its preview affordance. Web/RIS chips link out
 * (unchanged); KB chips open a document dialog when the citation resolves to a
 * project upload or base-corpus PDF, an info popover when it only carries
 * text, and stay plain when there is nothing beyond the label.
 */
export const SourcePreviewChip: FC<SourcePreviewChipProps> = ({
  source,
  signal,
  className,
  item,
  meta,
}) => {
  const projectId = useChatStore((s) => s.projectId)
  // Only citation-backed refs without an outbound link can resolve to a
  // document — the index fetch is skipped entirely for link/card-only rows.
  const needsIndex = !!source.citation && !source.url
  const previewIndex = useSourcePreviewIndex(projectId, needsIndex)

  const target: CitationTarget = source.citation
    ? resolveCitationTarget(source.citation, previewIndex?.projectDocuments, previewIndex?.baseCorpusFiles)
    : { kind: 'info', origin: source.kind, title: source.label, snippet: source.snippet }

  const tier = source.citation?.laneLabel
  const bindingNote = source.citation?.bindingNote
  const shared = {
    signal,
    label: source.label,
    authority: source.authority,
    className,
    index: source.number,
    item,
  }

  if (target.kind === 'url') {
    // A URL source keeps linking out — that is what a web/RIS chip has always
    // done and what makes it feel like a link. It only opens the popover when
    // the click genuinely adds something the link cannot: the "does this bind
    // me?" note or the authority tier of a legal source.
    if (bindingNote || tier) {
      return (
        <InfoPreviewChip
          {...shared}
          target={{ kind: 'info', origin: source.kind, title: item?.ref.label ?? source.label }}
          tier={tier}
          bindingNote={bindingNote}
          url={target.url}
          meta={meta}
        />
      )
    }
    return (
      <SourceSignalChipLink signal={signal} href={target.url} className={cn('max-w-56', className)}>
        <CitationIndex index={source.number} />
        {source.authority && <AuthorityTag>{source.authority}</AuthorityTag>}
        {source.label}
      </SourceSignalChipLink>
    )
  }

  if (target.kind === 'document') {
    return <DocumentPreviewChip {...shared} target={target} />
  }

  // Info target: interactive when the popover adds something beyond the chip
  // label (snippet, an untruncated title, the authority tier, or a citation to
  // copy). Gap/unknown sources with nothing to show stay plain — no fake preview.
  const hasPopoverContent =
    !!target.snippet || target.title !== source.label || !!tier || !!bindingNote || !!item
  if (hasPopoverContent) {
    return <InfoPreviewChip {...shared} target={target} tier={tier} bindingNote={bindingNote} meta={meta} />
  }

  return (
    <SourceSignalChip signal={signal} className={cn('max-w-56', className)}>
      <CitationIndex index={source.number} />
      {source.authority && <AuthorityTag>{source.authority}</AuthorityTag>}
      {source.label}
    </SourceSignalChip>
  )
}

// ---------------------------------------------------------------------------
// Report sources list affordance (ReportTab) — KB entries become openable
// ---------------------------------------------------------------------------

/**
 * Markdown emphasis/code markers a source line may carry. Underscores are NOT
 * stripped — they are ordinary filename characters (oib-rl_2_….pdf), and
 * mid-word underscores don't render as emphasis anyway.
 */
const MD_MARKERS_RE = /[*`]/g

export interface ReportSourcePreviewChipProps {
  /** The source entry's text (origin token already stripped by the parser). */
  locatorText: string
}

/**
 * Small "Ansehen"/"View" affordance next to a [KB] entry in the report's
 * sources list. Renders only when the entry's locator resolves to an actually
 * openable document (project upload or base-corpus PDF) — unresolvable
 * entries stay plain text.
 */
export const ReportSourcePreviewChip: FC<ReportSourcePreviewChipProps> = ({ locatorText }) => {
  const projectId = useChatStore((s) => s.projectId)
  const plainText = locatorText.replace(MD_MARKERS_RE, '')
  const locator = parseKbLocator(plainText)
  const index = useSourcePreviewIndex(projectId, locator != null)

  if (!locator || !index) return null
  const target = resolveCitationTarget(
    { url: '', content: plainText },
    index.projectDocuments,
    index.baseCorpusFiles
  )
  if (target.kind !== 'document') return null
  return <ReportSourceDocumentButton target={target} />
}

const ReportSourceDocumentButton: FC<{ target: DocumentTarget }> = ({ target }) => {
  const t = useTranslations('chat')
  const { isResolving, openPreview, dialog } = useDocumentPreview(target)
  const signal: SourceSignal = target.document.type === 'base' ? 'law' : 'project'
  return (
    <>
      <button
        type="button"
        className={cn(chipButtonClasses, 'self-center')}
        style={sourceSignalStyle(signal)}
        onClick={() => void openPreview()}
        disabled={isResolving}
        aria-busy={isResolving}
        aria-haspopup="dialog"
        aria-label={t('sourcePreview.chipAria', { label: target.title })}
      >
        <FileSearch aria-hidden="true" />
        {t('sourcePreview.view')}
      </button>
      {dialog}
    </>
  )
}
