/**
 * CitationPeek — what a citation IS, before you commit to opening it.
 *
 * The question a reader asks of an inline `[3]` is not "take me somewhere", it
 * is "what is this?". Answering that with a scroll — the old behaviour — makes
 * them do the work: land somewhere, look around, guess which chip they arrived
 * at. The peek answers it in place: which document, how authoritative, which
 * page, and the passage itself.
 *
 * ONE component, used by every surface that can preview a citation (the inline
 * marker and the provenance chip). That is deliberate: two popovers describing
 * the same citation are two things that can disagree, which is the exact class
 * of defect the citation model exists to remove.
 */

'use client'

import { type FC } from 'react'
import Link from 'next/link'
import { Download, ExternalLink, FileSearch, FolderOpen, Link2 } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { SectionLabel } from '@/components/ui/section-label'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import { documentPages, refPage, type CitationRef, type CitedDocument } from '../lib/citations'
import type { Shelf } from '../lib/source-kinds'
import { useChatStore } from '../store'
import { CopySourceCitationButton } from './CopyCitation'
import { CopyCitationLinkButton } from './CopyCitationLink'

interface CitationPeekProps {
  citation: CitationRef
  /** Passage text to show, when the reference carries one. */
  snippet?: string
  /** Opens the document at this reference's locus. Absent when unopenable. */
  onOpen?: () => void
  /** Outbound link, for web/RIS sources. */
  url?: string
  /**
   * The source resolved to nothing openable — say so, in place of the control.
   *
   * The alternative is silence, which is what this used to be: the reader is
   * looking at a citation and wants to know whether checking it is possible.
   * "There is no way in from here" is an answer; a control that closes the
   * popover and does nothing is not.
   */
  unavailable?: boolean
  /**
   * The document EXISTS but this app cannot draw its format — hand it over
   * instead, and say which of the two is happening.
   *
   * A cited `.docx` used to arrive here as `unavailable`, which is a claim
   * about the citation and was false: nothing was missing, the file was in the
   * project's Dateiablage and the reader was entitled to it. Absent when the
   * source is genuinely unreachable.
   */
  onDownload?: () => void
  /** The download is being presigned — the control says so rather than repeating. */
  downloadPending?: boolean
}

/**
 * Whether the source BINDS, as a compact pill beside the tier label.
 *
 * Orthogonal to the authority badge (which names OIB/RIS): `bindend` for
 * statute and ordinance, `verbindlich_erklaert` for an OIB-Richtlinie a Land
 * declared binding, `auslegend` for interpretive material. The classification
 * the reader most wants — "does this actually apply to me?" — and the reason
 * the backend went to the trouble of carrying rank onto every source.
 *
 * `unbekannt` never reaches here: it is dropped to undefined at the wire, so an
 * unclassified source shows no pill rather than a hedged one. Colour is never
 * the only carrier — the German word is always spelled out (the a11y rule the
 * rest of this file follows).
 */
const BINDING_TONE: Record<string, string> = {
  bindend: 'border-transparent bg-[var(--source-law,var(--foreground))] text-[var(--background)]',
  verbindlich_erklaert: 'border-[var(--source-law,var(--foreground))] text-foreground',
  auslegend: 'border-border text-muted-foreground',
}

const BindingStatusChip: FC<{ status?: string }> = ({ status }) => {
  const t = useTranslations('chat')
  if (!status || !(status in BINDING_TONE)) return null
  return (
    <span
      className={cn(
        'rounded-full border px-1.5 py-0.5 text-[0.65rem] font-medium leading-none',
        BINDING_TONE[status]
      )}
    >
      {t(`sourcePreview.binding.${status}`)}
    </span>
  )
}

/**
 * The locus line: which page this reference names, or — for a
 * document-level reference — every page the answer drew on.
 *
 * Naming all of them matters: a chip stands for the whole document, so "S. 18"
 * alone would understate a document the answer leaned on at four places.
 */
const LocusLine: FC<{ citation: CitationRef }> = ({ citation }) => {
  const t = useTranslations('chat')
  const page = refPage(citation)
  const pages = documentPages(citation.document)

  // A PUNKT IS A PLACE. It was nested inside "has a page", so a locus that knew
  // its Punkt and not its page read „Gesamtes Dokument" — dropping the one
  // identifier Austrian building law actually cites by, in favour of saying
  // nothing. The chunker measures it against the corpus's contents pages
  // precisely so it can be shown.
  const punkt = citation.locus?.punkt?.trim()
  const text = citation.locus
    ? page != null
      ? punkt
        ? t('answerSources.punktPage', { punkt, page })
        : t('answerSources.page', { page })
      : punkt
        ? t('answerSources.punkt', { punkt })
        : t('citationPeek.wholeDocument')
    : pages.length === 1
      ? t('answerSources.page', { page: pages[0]! })
      : pages.length > 1
        ? t('answerSources.pages', { pages: pages.join(', ') })
        : t('citationPeek.wholeDocument')

  return <p className="text-xs tabular-nums text-muted-foreground">{text}</p>
}

/**
 * The link to where the cited document LIVES in the app.
 *
 * The peek answers "what is this?"; the next question is often "where is it?"
 * — to see the file beside its siblings, to replace it with a newer version,
 * to check who filed it. Answering that used to mean closing the peek and
 * navigating from memory. The project shelf lives in the project's files, the
 * office archive at its own route; the base corpus and the session shelf have
 * no page of their own, and a web source already carries its `url`, so for
 * those there is nothing to offer and nothing is rendered.
 *
 * The project id comes off the chat store, which is how every other consumer
 * of the store on this popover's path already reads it.
 */
const DocumentHomeLink: FC<{ shelf?: Shelf; tint: CitedDocument['tint'] }> = ({
  shelf,
  tint,
}) => {
  const t = useTranslations('chat')
  const projectId = useChatStore((s) => s.projectId)

  const target =
    shelf === 'project' && projectId
      ? {
          href: `/app/projects/${encodeURIComponent(projectId)}/files`,
          label: t('documentGrid.openInFiles'),
        }
      : shelf === 'archiv'
        ? { href: '/app/archiv', label: t('documentGrid.openInArchive') }
        : null
  if (!target) return null

  return (
    <Link
      href={target.href}
      data-citation-home=""
      className="inline-flex items-center gap-1 text-xs font-medium hover:underline"
      style={{ color: `var(--source-${tint}-text, var(--foreground))` }}
    >
      <FolderOpen aria-hidden="true" className="size-3.5" />
      {target.label}
    </Link>
  )
}

export const CitationPeek: FC<CitationPeekProps> = ({
  citation,
  snippet,
  onOpen,
  url,
  unavailable,
  onDownload,
  downloadPending,
}) => {
  const t = useTranslations('chat')
  const { document: doc } = citation
  const tint = doc.tint

  return (
    <div className="space-y-2">
      {/* What kind of source this is — the answer to "can I rely on it?" */}
      <div className="flex flex-wrap items-center gap-1.5">
        <SourceSignalChip signal={tint}>{t(`sourcePreview.kinds.${doc.kind}`)}</SourceSignalChip>
        {doc.laneLabel && (
          <span className="text-xs font-medium text-muted-foreground">{doc.laneLabel}</span>
        )}
        <BindingStatusChip status={doc.bindingStatus} />
      </div>

      <div>
        <p className="break-words text-sm font-medium text-foreground">{doc.title}</p>
        <LocusLine citation={citation} />
      </div>

      {/* Does this actually bind me? The highest-value fact for a legal source. */}
      {doc.bindingNote && (
        <div
          className="rounded-md border-l-2 py-1.5 pl-2.5 pr-2"
          style={{
            borderColor: `color-mix(in oklch, var(--source-${tint}, var(--foreground)) 45%, transparent)`,
            backgroundColor: `var(--source-${tint}-tint, var(--muted))`,
          }}
        >
          <SectionLabel
            as="p"
            style={{ color: `var(--source-${tint}-text, var(--muted-foreground))` }}
          >
            {t('sourcePreview.bindingLabel')}
          </SectionLabel>
          <p className="mt-0.5 text-xs leading-relaxed text-foreground">{doc.bindingNote}</p>
        </div>
      )}

      {/* The words themselves — the whole point of checking a citation. */}
      {snippet && (
        <div
          className="rounded-lg border px-3 py-2"
          style={{
            backgroundColor: `var(--source-${tint}-tint, var(--muted))`,
            borderColor: `color-mix(in oklch, var(--source-${tint}, var(--foreground)) 25%, transparent)`,
          }}
        >
          <SectionLabel
            as="p"
            style={{ color: `var(--source-${tint}-text, var(--muted-foreground))` }}
          >
            {t('sourcePreview.citedPassage')}
          </SectionLabel>
          <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {snippet}
          </p>
        </div>
      )}

      {/* WHY there is no viewer, before the control that works around it. Said
          in the popover rather than left to the reader's inference: "this
          format opens outside Piloti" is a fact about the file, and without it
          a download button beside a document chip reads as an arbitrary second
          choice. */}
      {onDownload && !onOpen && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('citationPeek.noInlineViewer')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2">
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            // The screenshot harness needs to walk peek → document the way a
            // reader does; naming the step beats guessing at button order.
            data-citation-open=""
            className="inline-flex items-center gap-1 text-xs font-medium hover:underline"
            style={{ color: `var(--source-${tint}-text, var(--foreground))` }}
          >
            <FileSearch aria-hidden="true" className="size-3.5" />
            {t('citationPeek.openAtPage')}
          </button>
        )}
        {onDownload && !onOpen && (
          <button
            type="button"
            onClick={onDownload}
            disabled={downloadPending}
            data-citation-download=""
            className="inline-flex items-center gap-1 text-xs font-medium hover:underline disabled:cursor-progress disabled:opacity-70"
            style={{ color: `var(--source-${tint}-text, var(--foreground))` }}
          >
            <Download aria-hidden="true" className="size-3.5" />
            {t(downloadPending ? 'citationPeek.downloading' : 'citationPeek.download')}
          </button>
        )}
        {unavailable && !onOpen && !onDownload && (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
            <FileSearch aria-hidden="true" className="size-3.5" />
            {t('citationPeek.notOpenable')}
          </span>
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium hover:underline"
            style={{ color: `var(--source-${tint}-text, var(--foreground))` }}
          >
            {t('sourcePreview.openExternal')}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        )}
        <DocumentHomeLink shelf={doc.shelf} tint={tint} />
        <span className="flex-1" />
        <CopyCitationLinkButton citation={citation} icon={<Link2 className="size-3" />} />
        <CopySourceCitationButton citation={citation} />
      </div>
    </div>
  )
}
