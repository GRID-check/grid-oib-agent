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

import { useEffect, useState, type CSSProperties, type FC, type ReactNode } from 'react'
import { ExternalLink, FileSearch, Link2 } from 'lucide-react'
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
import type { SourceTint } from '@/features/layout/lib/source-presets'
import { useChatStore } from '../store'
import { CopySourceCitationButton } from './CopyCitation'
import { CopyCitationLinkButton } from './CopyCitationLink'
import {
  buildCitationModel,
  citationNumbers,
  citedLoci,
  resolveCitationTarget,
  type CitationLocus,
  type CitationRef,
  type CitationTarget,
  type CitedDocument,
  type StoredDocumentRef,
} from '../lib/citations'
import type { CollectionScope, SourceKind } from '../lib/source-kinds'
import { AuthorityTag } from './AuthorityTag'

// ---------------------------------------------------------------------------
// Lazy resolution index (project documents + base-corpus files)
// ---------------------------------------------------------------------------

export interface SourcePreviewIndex {
  /**
   * Every DB-backed document the user can open: this project's uploads FIRST,
   * then the organization's Archiv. Each row carries the shelf it came from, so
   * a citation that names its own shelf resolves to the right copy of a filename
   * held on both; order is only the tie-break for one that does not.
   */
  storedDocuments: StoredDocumentRef[]
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
    const [docsResult, archivResult, corpusResult] = await Promise.allSettled([
      projectId
        ? fetch(`/api/documents?projectId=${encodeURIComponent(projectId)}`).then((r) =>
            r.ok ? r.json() : null
          )
        : Promise.resolve(null),
      // The org Archiv (ADR-0024). Feature-gated, so a 403 here is normal and
      // simply yields no Archiv entries — never a failed index. Without this
      // fetch, every `buero`-kind citation resolved to a dead info popover even
      // though its document was sitting in the Archiv and the preview route
      // would have served it.
      fetch('/api/archiv/documents').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/knowledge-base').then((r) => (r.ok ? r.json() : null)),
    ])
    const docs = docsResult.status === 'fulfilled' ? docsResult.value?.documents : null
    const archivDocs = archivResult.status === 'fulfilled' ? archivResult.value?.documents : null
    const files = corpusResult.status === 'fulfilled' ? corpusResult.value?.files : null

    const toRefs = (rows: unknown, scope: CollectionScope): StoredDocumentRef[] =>
      Array.isArray(rows)
        ? rows
            .filter(
              (doc): doc is { id: string; filename: string; contentType?: string | null } =>
                !!doc && typeof doc.id === 'string' && typeof doc.filename === 'string'
            )
            .map((doc) => ({
              id: doc.id,
              filename: doc.filename,
              contentType: doc.contentType ?? null,
              scope,
            }))
        : []

    // Tagged with the shelf each row came from, so a citation that names its own
    // shelf resolves to the right copy of a filename held on both. Project
    // uploads still come first, as the tie-break for a citation that does not.
    const storedDocuments: StoredDocumentRef[] = [
      ...toRefs(docs, 'projekt'),
      ...toRefs(archivDocs, 'buero'),
    ]

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

    return { storedDocuments, baseCorpusFiles }
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
        if (!cancelled) setIndex({ storedDocuments: [], baseCorpusFiles: [] })
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

// ---------------------------------------------------------------------------
// Layout variants — ONE behaviour, two shapes
// ---------------------------------------------------------------------------

/**
 * How a citation is laid out. The variant changes only the SHAPE; the
 * provenance tint, the authority badge, the resolved target and the click
 * behaviour are identical, which is the whole point: the same source must not
 * be a tinted, openable pill under the answer and an inert line of text one tab
 * over.
 */
export type CitationVariant = 'chip' | 'card'

/**
 * How much of a citation's chrome the card layout prints.
 *
 * `full` is the roomy technical list (the research panel): provenance icon,
 * authority badge, the `[N]`, and the raw locator as the Fundstelle.
 *
 * `name-only` is for a surface that ALREADY states all of that around the
 * citation — the Herleitung fan-out puts the icon, the badge and the lane on
 * its folder tab and the markers and pages on its own meta line, so repeating
 * them inside the card left the document's NAME, the one thing only the card
 * can say, squeezed into an ellipsis.
 */
export type CitationDetail = 'full' | 'name-only'

/**
 * The card is the source list's existing row, unchanged in shape: one bordered
 * card holding everything, hover-highlighted, full-width. Only its CONTENT
 * gained provenance (a tinted icon and an authority badge) and its behaviour
 * became real.
 */
const cardButtonClasses =
  'flex w-full cursor-pointer gap-3 rounded-lg border bg-card p-3 text-left ' +
  'transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-ring/60 disabled:cursor-progress disabled:opacity-70'

const faceClasses = (variant: CitationVariant): string =>
  variant === 'card' ? cardButtonClasses : cn(chipButtonClasses, 'max-w-56')

/**
 * The card keeps the calm neutral card surface a long list needs and carries
 * its provenance in the icon + badge instead — tinting whole rows would make
 * the list unreadable.
 */
const faceStyle = (variant: CitationVariant, signal: SourceTint): CSSProperties | undefined =>
  variant === 'card' ? undefined : sourceSignalStyle(signal)

/**
 * The `[N]` a source carries in the answer prose, rendered inside its chip.
 *
 * This is the one thing the written source list held that a chip could not: it
 * is what an inline `[2]` in the answer points at. It uses the chip's own
 * currentColor vocabulary (same as AuthorityTag) so it reads as part of the
 * chip rather than as a new element bolted on.
 */
const CitationIndex: FC<{ index?: string }> = ({ index }) =>
  !index ? null : (
    // `me-1`, not the parent's flex gap: `SourceSignalChip` collapses ALL its
    // children into one truncating span, so a gap between them never applies
    // there and the marker renders flush against the label ("3Attika-Detail").
    // Carrying its own trailing space makes the marker read correctly in every
    // chip shape rather than only in the ones that keep it a flex child.
    <span className="me-1 shrink-0 text-[10px] font-semibold tabular-nums opacity-60">{index}</span>
  )

/** Everything a citation shows before it is clicked, in either layout. */
interface CitationFaceProps {
  variant?: CitationVariant
  signal: SourceTint
  label: string
  authority?: string
  /**
   * The marker(s) this source carries in the answer prose — "3", or "2, 7" for
   * a document the answer cites in more than one place.
   */
  index?: string
  /** Backing reference — supplies the card layout's excerpt and locator. */
  citation?: CitationRef
  /**
   * Card layout only: quiet metadata pinned to the right of the title row
   * (the source list's cited marker + timestamp). Keeps that metadata INSIDE
   * the card, where it reads as part of the row, rather than stranded under it.
   */
  trailing?: ReactNode
  /** Card layout only — see {@link SourcePreviewChipProps.detail}. */
  detail?: CitationDetail
}

/**
 * The visual body of a citation, shared by every branch (document / link /
 * info / plain) and by both variants — so a source cannot look like a
 * first-class citation in one place and a bare label in another.
 */
const CitationFace: FC<CitationFaceProps> = ({
  variant = 'chip',
  signal,
  label,
  authority,
  index,
  citation,
  trailing,
  detail = 'full',
}) => {
  const Icon = iconForTint(signal)

  if (variant !== 'card') {
    return (
      <>
        <CitationIndex index={index} />
        <Icon aria-hidden="true" />
        {authority && <AuthorityTag>{authority}</AuthorityTag>}
        <span className="truncate">{label}</span>
      </>
    )
  }

  // The card has room the chip does not, so it leads with the document's real
  // NAME. The chip's label is a hostname for links — right when space is one
  // pill, wrong as the headline of a row that can spell out "Bauordnung für
  // Wien § 108".
  const headline = citation?.document.title.trim() || label
  // The passage the source contributed. The model already refused to put a bare
  // locator line ("file.pdf, p.3") in a snippet field, so nothing to strip here.
  const excerpt = citation?.locus?.snippet ?? citation?.document.snippet
  const locator =
    citation?.locus?.citationKey || citation?.document.fileName || citation?.document.url

  // Never say the same thing twice. The wire's `content` is built as
  // "<origin token> <citation key | title | url>", so for most sources it
  // restates the headline or the locator rather than carrying a passage — a
  // tool result would otherwise print its own name three times over.
  // Containment (not equality), because "[RIS] Bauordnung für Wien § 108" is
  // still a restatement of the title "Bauordnung für Wien § 108 — Fluchtwege".
  // Only ever suppress the SHORTER restatement, so a genuine long passage that
  // happens to quote the title still shows.
  const norm = (value: string | undefined): string =>
    (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const restates = (candidate: string, of: string | undefined): boolean =>
    !!candidate && norm(of).includes(norm(candidate))
  const full = detail === 'full'
  const showExcerpt = !!excerpt && !restates(excerpt, headline) && !restates(excerpt, locator)
  const showLocator = full && !!locator && !restates(locator, headline)

  return (
    <>
      {full && index && (
        <span
          className="mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md border bg-muted px-1 font-mono text-xs tabular-nums text-muted-foreground"
          aria-hidden="true"
        >
          {index}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2">
          {full && (
            <span className="shrink-0" style={{ color: `var(--source-${signal}, var(--muted-foreground))` }}>
              <Icon className="size-4" aria-hidden="true" />
            </span>
          )}
          {full && authority && <AuthorityTag>{authority}</AuthorityTag>}
          <span
            // Two lines, not one: document names are long ("Erläuterungen zu
            // OIB-Richtlinie 2.1, Ausgabe Mai 2023") and the distinguishing
            // part is usually at the END, so a single truncated line makes two
            // different Richtlinien read identically.
            className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold leading-snug text-foreground"
            // Storage identity belongs on the tooltip, never in the reading
            // line — a user must not have to read `oib-rl_2_….pdf` to know
            // which document a card stands for.
            title={locator && locator !== headline ? `${headline}\n${locator}` : headline}
          >
            {headline}
          </span>
          {trailing}
        </span>
        {showExcerpt && (
          <span className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">
            {excerpt}
          </span>
        )}
        {showLocator && (
          <span className="truncate break-all font-mono text-xs text-muted-foreground/80">
            {locator}
          </span>
        )}
      </span>
    </>
  )
}

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
/**
 * The Fundstellen rail — every place in this document the answer used, as
 * something you can walk.
 *
 * This is the half the click used to throw away. The model knows a document was
 * read at pages 5, 12, 18 and 22; the viewer opened at 5 and offered no way to
 * reach the rest, so verifying the other three citations meant closing the
 * dialog, finding another chip, and hoping. Each locus is now a button that
 * moves the page, and the one you are reading is marked.
 */
const LocusRail: FC<{
  document: CitedDocument
  activeKey: string | undefined
  onSelect: (locus: CitationLocus) => void
}> = ({ document: doc, activeKey, onSelect }) => {
  const t = useTranslations('chat')
  // Only loci that name a page are navigable — a whole-document hit has
  // nowhere else to go, and a rail with one inert button is noise.
  const loci = doc.loci.filter((locus) => typeof locus.page === 'number')
  if (loci.length < 2) return null

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5" role="group" aria-label={t('citationPeek.lociAria')}>
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {t('citationPeek.lociLabel', { count: loci.length })}
      </span>
      {loci.map((locus) => {
        const isActive = locus.key === activeKey
        return (
          <button
            key={locus.key}
            type="button"
            onClick={() => onSelect(locus)}
            aria-current={isActive ? 'true' : undefined}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums',
              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              isActive ? 'border-transparent' : 'border-border text-muted-foreground hover:text-foreground'
            )}
            style={isActive ? sourceSignalStyle(doc.tint) : undefined}
          >
            {t('answerSources.page', { page: locus.page! })}
            {locus.number != null && (
              <span className="opacity-60">[{locus.number}]</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Open/fetch state for a document target. Project uploads need a fresh
 * presigned preview URL per open (they expire); base-corpus PDFs stream from
 * the knowledge-base route PdfViewerDialog already builds from `fileName`.
 * The dialog only ever opens with a renderable source — a failed presign
 * surfaces as a toast, not a broken viewer.
 *
 * The dialog owns an ACTIVE LOCUS, not just a page: which Fundstelle the reader
 * is on is the thing the rail marks, the citation footer copies, and a deep
 * link restores.
 */
const useDocumentPreview = (target: DocumentTarget, citation?: CitationRef) => {
  const t = useTranslations('chat')
  const [isOpen, setIsOpen] = useState(false)
  const [isResolving, setIsResolving] = useState(false)
  const [src, setSrc] = useState<string | null>(null)
  // A chip is a DOCUMENT-level reference, so it arrives with no locus — but the
  // viewer still opens at the first cited passage, and the rail must say so.
  // Leaving it unset marked nothing, so the reader could not tell which of four
  // Fundstellen they were looking at.
  const [activeLocus, setActiveLocus] = useState<CitationLocus | undefined>(
    () => citation?.locus ?? (citation ? citedLoci(citation.document)[0] : undefined)
  )

  // A deep link (or a second click on a different marker) can change which
  // locus this dialog should be showing while it is already mounted.
  useEffect(() => {
    if (citation?.locus) setActiveLocus(citation.locus)
  }, [citation?.locus])

  const openPreview = async (locus?: CitationLocus): Promise<void> => {
    if (locus) setActiveLocus(locus)
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
    target.document.type === 'stored' &&
    (target.document.contentType ?? '').toLowerCase().startsWith('image/')
  // The provenance tint comes from the SOURCE, not from where the file happens
  // to be stored: a chip and the dialog it opens must never disagree about what
  // kind of source this is.
  const headerSignal: SourceTint =
    citation?.document.tint ?? (target.document.type === 'base' ? 'law' : 'project')
  const page = activeLocus?.page ?? target.page
  // The reference the dialog is CURRENTLY showing — what its copy actions must
  // describe, so a citation copied from page 18 does not say page 5.
  const shown: CitationRef | undefined = citation && {
    document: citation.document,
    locus: activeLocus,
  }

  const dialog = (
    <PdfViewerDialog
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open)
        if (!open) setSrc(null)
      }}
      fileName={target.document.type === 'base' ? target.document.fileName : target.document.filename}
      page={page ?? null}
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
          {shown && <CopyCitationLinkButton citation={shown} icon={<Link2 className="size-3" />} />}
          {shown && <CopySourceCitationButton citation={shown} />}
        </span>
      }
    >
      {citation && (
        <LocusRail
          document={citation.document}
          activeKey={activeLocus?.key}
          onSelect={setActiveLocus}
        />
      )}
      {(activeLocus?.snippet ?? target.snippet) && (
        <CitedPassageBox snippet={(activeLocus?.snippet ?? target.snippet)!} signal={headerSignal} />
      )}
    </PdfViewerDialog>
  )

  return { isResolving, openPreview, dialog, isOpen, setIsOpen }
}

const DocumentPreviewChip: FC<{
  target: DocumentTarget
  signal: SourceTint
  label: string
  authority?: string
  className?: string
  /** The marker(s) this source carries in the answer prose. */
  index?: string
  variant?: CitationVariant
  /** The reference this chip stands for — powers the dialog's "copy citation". */
  citation?: CitationRef
  trailing?: ReactNode
  detail?: CitationDetail
}> = ({
  target,
  signal,
  label,
  authority,
  className,
  index,
  variant = 'chip',
  citation,
  trailing,
  detail,
}) => {
  const t = useTranslations('chat')
  const { isResolving, openPreview, dialog } = useDocumentPreview(target, citation)
  return (
    <>
      <button
        type="button"
        className={cn(faceClasses(variant), className)}
        style={faceStyle(variant, signal)}
        onClick={() => void openPreview()}
        disabled={isResolving}
        aria-busy={isResolving}
        aria-haspopup="dialog"
        aria-label={t('sourcePreview.chipAria', { label })}
        title={t('sourcePreview.chipAria', { label })}
      >
        <CitationFace
          variant={variant}
          signal={signal}
          label={label}
          authority={authority}
          index={index}
          citation={citation}
          trailing={trailing}
          detail={detail}
        />
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
  /**
   * Canonical coarse kind (ADR-0026) — the popover's provenance line. It is the
   * document's kind, never the kb/ris/web origin token: a knowledge-base copy
   * of a legal text used to read "Project knowledge" here while the chip beside
   * it showed a RIS badge and a Baurecht lane — the same source, contradicted.
   */
  kind: SourceKind
  /** Outbound link (RIS sources) shown as an "open" button inside the popover. */
  url?: string
  className?: string
  /** The marker(s) this source carries in the answer prose. */
  index?: string
  /** Cited page / hostname — shown in the popover, not on the chip. */
  meta?: string
  variant?: CitationVariant
  /** The reference this chip stands for, for the popover's "copy citation". */
  citation?: CitationRef
  trailing?: ReactNode
  detail?: CitationDetail
}> = ({
  target,
  signal,
  label,
  authority,
  tier,
  bindingNote,
  url,
  className,
  index,
  meta,
  variant = 'chip',
  citation,
  trailing,
  kind,
  detail,
}) => {
  const t = useTranslations('chat')
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(faceClasses(variant), className)}
          style={faceStyle(variant, signal)}
          aria-label={t('sourcePreview.chipAria', { label })}
          title={t('sourcePreview.chipAria', { label })}
        >
          <CitationFace
            variant={variant}
            signal={signal}
            label={label}
            authority={authority}
            index={index}
            citation={citation}
            trailing={trailing}
            detail={detail}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceSignalChip signal={signal}>{t(`sourcePreview.kinds.${kind}`)}</SourceSignalChip>
          {tier && (
            <span className="text-[11px] font-medium text-muted-foreground">{tier}</span>
          )}
        </div>
        {/* The written source list's payload, one click away: the citation
            number, the untruncated title and the locator. */}
        <p className="break-words text-sm font-medium text-foreground">
          {index && <span className="mr-1 text-muted-foreground">[{index}]</span>}
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
          {citation && <CopySourceCitationButton citation={citation} />}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// The chip — one answer source, rendered by its resolved target
// ---------------------------------------------------------------------------

export interface SourcePreviewChipProps {
  /**
   * What this chip stands for: a document, optionally narrowed to one locus.
   *
   * Everything the chip renders — label, tint, authority badge, `[N]`, preview
   * target — comes from here. It is deliberately the ONLY source prop: the
   * component used to take a ref, a signal and a row object that each carried
   * part of the answer, and keeping them in step was left to every call site.
   */
  citation: CitationRef
  /**
   * Cited page / host, localized by the caller — shown in the popover, never on
   * the chip (which stays the compact pill it always was).
   */
  meta?: string
  /** Layout override (width, truncation) for the caller's context. */
  className?: string
  /**
   * Layout shape. `chip` is the compact "Belegt durch" pill; `card` is the
   * full-width list row used by the research panel's source list. Behaviour —
   * tint, authority badge, target resolution, click — is identical in both.
   */
  variant?: CitationVariant
  /**
   * Card layout only: quiet metadata pinned right of the title (the source
   * list's cited marker + timestamp), rendered inside the card.
   */
  trailing?: ReactNode
  /**
   * Card layout only: how much chrome to print around the name. Defaults to
   * `full`; see {@link CitationDetail}.
   */
  detail?: CitationDetail
}

/**
 * One citation with its preview affordance. Web/RIS chips link out; document
 * chips open the viewer at the locus's page when the document resolves to a
 * project upload, an Archiv document or a base-corpus PDF; anything
 * unresolvable degrades to an info popover, never a broken viewer.
 */
export const SourcePreviewChip: FC<SourcePreviewChipProps> = ({
  citation,
  className,
  meta,
  variant = 'chip',
  trailing,
  detail = 'full',
}) => {
  const projectId = useChatStore((s) => s.projectId)
  const { document: doc, locus } = citation
  // Only a document with a filename and no outbound link can resolve to a
  // stored file, so the index fetch is skipped entirely for link sources AND
  // for card-derived documents, which name a law but no document at all.
  const needsIndex = !doc.url && !!doc.fileName
  const previewIndex = useSourcePreviewIndex(projectId, needsIndex)

  const target = resolveCitationTarget(doc, {
    locus,
    storedDocuments: previewIndex?.storedDocuments,
    baseCorpusFiles: previewIndex?.baseCorpusFiles,
  })

  const label = doc.title
  // A chip stands for a DOCUMENT, so it names every marker that document
  // carries — "2, 7", not an arbitrary one of them. A chip narrowed to a locus
  // names only that locus's marker.
  const numbers = locus ? [locus.number].filter((n): n is number => n != null) : citationNumbers(doc)
  const index = numbers.length > 0 ? numbers.join(', ') : undefined
  const shared = {
    signal: doc.tint,
    label,
    authority: doc.authority,
    className,
    index,
    variant,
    citation,
    trailing,
    detail,
    kind: doc.kind,
  }

  if (target.kind === 'url') {
    // A URL source keeps linking out — that is what a web/RIS chip has always
    // done and what makes it feel like a link. It only opens the popover when
    // the click genuinely adds something the link cannot: the "does this bind
    // me?" note or the authority tier of a legal source.
    if (doc.bindingNote || doc.laneLabel) {
      return (
        <InfoPreviewChip
          {...shared}
          target={{ kind: 'info', title: label }}
          tier={doc.laneLabel}
          bindingNote={doc.bindingNote}
          url={target.url}
          meta={meta}
        />
      )
    }
    if (variant === 'card') {
      return (
        <a
          href={target.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(faceClasses(variant), className)}
          style={faceStyle(variant, doc.tint)}
          title={target.url}
        >
          <CitationFace {...shared} />
        </a>
      )
    }
    return (
      <SourceSignalChipLink
        signal={doc.tint}
        href={target.url}
        className={cn('max-w-56', className)}
      >
        <CitationIndex index={index} />
        {doc.authority && <AuthorityTag>{doc.authority}</AuthorityTag>}
        {label}
      </SourceSignalChipLink>
    )
  }

  if (target.kind === 'document') {
    return <DocumentPreviewChip {...shared} target={target} />
  }

  // Resolution is still in flight: this document MAY yet turn out to be
  // openable, so committing to the info popover now would settle the chip into
  // the weaker affordance and never upgrade it. Render the inert chip until the
  // index answers.
  const resolving = needsIndex && !previewIndex

  // Info target: interactive when the popover adds something beyond the chip
  // label. A real source always does — at minimum it offers a citation to copy,
  // which is the whole reason the popover exists. A card-derived document (a law
  // name with no document, no link and no retrieved passage) has nothing more to
  // show and stays a plain chip rather than promising a preview it cannot give.
  const canCite = !!doc.fileName || !!doc.url || doc.loci.length > 0
  const hasPopoverContent =
    !resolving &&
    (canCite || !!target.snippet || !!doc.laneLabel || !!doc.bindingNote || !!meta || !!index)
  if (hasPopoverContent) {
    return (
      <InfoPreviewChip
        {...shared}
        target={target}
        tier={doc.laneLabel}
        bindingNote={doc.bindingNote}
        meta={meta}
      />
    )
  }

  if (variant === 'card') {
    return (
      <div className={cn(faceClasses(variant), 'cursor-default')} style={faceStyle(variant, doc.tint)}>
        <CitationFace {...shared} />
      </div>
    )
  }

  return (
    <SourceSignalChip signal={doc.tint} className={cn('max-w-56', className)}>
      <CitationIndex index={index} />
      {doc.authority && <AuthorityTag>{doc.authority}</AuthorityTag>}
      {label}
    </SourceSignalChip>
  )
}

// ---------------------------------------------------------------------------
// Report sources list affordance (ReportTab) — KB entries become openable
// ---------------------------------------------------------------------------

export interface ReportSourcePreviewChipProps {
  /** The source entry's text (origin token already stripped by the parser). */
  locatorText: string
}

/**
 * Small "Ansehen"/"View" affordance next to a [KB] entry in the report's
 * sources list. Renders only when the entry resolves to an actually openable
 * document — unresolvable entries stay plain text.
 *
 * The entry goes through `buildCitationModel` rather than being parsed here, so
 * this affordance resolves a document by exactly the rules the chips use. It is
 * the same producer the answer's provenance row feeds on (a written source
 * entry), just with one entry in it.
 */
export const ReportSourcePreviewChip: FC<ReportSourcePreviewChipProps> = ({ locatorText }) => {
  const projectId = useChatStore((s) => s.projectId)
  const [doc] = buildCitationModel({
    entries: [{ number: 0, markdown: locatorText }],
  })
  const index = useSourcePreviewIndex(projectId, !!doc?.fileName)

  if (!doc || !index) return null
  const target = resolveCitationTarget(doc, {
    storedDocuments: index.storedDocuments,
    baseCorpusFiles: index.baseCorpusFiles,
  })
  if (target.kind !== 'document') return null
  return <ReportSourceDocumentButton target={target} document={doc} />
}

const ReportSourceDocumentButton: FC<{ target: DocumentTarget; document: CitedDocument }> = ({
  target,
  document: doc,
}) => {
  const t = useTranslations('chat')
  const { isResolving, openPreview, dialog } = useDocumentPreview(target, { document: doc })
  const signal: SourceTint = doc.tint
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

// ---------------------------------------------------------------------------
// Standalone document dialog — the same viewer, opened from outside a chip
// ---------------------------------------------------------------------------

/**
 * Opens a citation's document immediately, with no chip in between.
 *
 * The inline `[3]` marker and a deep link both need to put a reader in front of
 * the document without there being a chip to click. They get the SAME dialog —
 * same Fundstellen rail, same passage box, same copy actions — because a source
 * must not behave differently depending on which affordance reached it.
 *
 * Where it lands is the REFERENCE's business, not the caller's: the citation's
 * own locus, or — when it names the document as a whole — the first passage the
 * document was read at. A caller-supplied page would be a second, weaker way to
 * say the same thing (the dialog marks an active *locus*, and a bare page cannot
 * name one), so there is no page prop to disagree with the citation.
 */
export const SourceDocumentDialog: FC<{
  citation: CitationRef
  onClose: () => void
}> = ({ citation, onClose }) => {
  const projectId = useChatStore((s) => s.projectId)
  const previewIndex = useSourcePreviewIndex(projectId, !citation.document.url)
  const target = resolveCitationTarget(citation.document, {
    locus: citation.locus,
    storedDocuments: previewIndex?.storedDocuments,
    baseCorpusFiles: previewIndex?.baseCorpusFiles,
  })
  const isDocument = target.kind === 'document'
  const { openPreview, dialog, isOpen } = useDocumentPreview(
    isDocument ? target : EMPTY_DOCUMENT_TARGET,
    citation
  )

  // Open as soon as resolution succeeds; close the owner when the reader
  // dismisses the dialog, so the mount is tied to the viewing session.
  useEffect(() => {
    if (isDocument && !isOpen) void openPreview(citation.locus)
    // Opening is a one-shot per resolved target; re-running on every render
    // would reopen a dialog the reader just dismissed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDocument])

  useEffect(() => {
    if (isDocument && previewIndex && !isOpen) return
    // Nothing openable and the index has answered: there is no viewer to show.
    if (previewIndex && !isDocument) onClose()
  }, [previewIndex, isDocument, isOpen, onClose])

  if (!isDocument) return null
  return <>{dialog}</>
}

/** Placeholder while a target has not resolved — never rendered. */
const EMPTY_DOCUMENT_TARGET: DocumentTarget = {
  kind: 'document',
  title: '',
  fileName: '',
  document: { type: 'base', fileName: '' },
}
