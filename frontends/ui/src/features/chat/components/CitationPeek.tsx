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
import { ExternalLink, FileSearch, Link2 } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import {
  citedPages,
  refPage,
  type CitationRef,
} from '../lib/citations'
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
  const pages = citedPages(citation.document)

  const text = citation.locus
    ? page != null
      ? t('answerSources.page', { page })
      : t('citationPeek.wholeDocument')
    : pages.length === 1
      ? t('answerSources.page', { page: pages[0]! })
      : pages.length > 1
        ? t('answerSources.pages', { pages: pages.join(', ') })
        : t('citationPeek.wholeDocument')

  return <p className="text-[11px] tabular-nums text-muted-foreground">{text}</p>
}

export const CitationPeek: FC<CitationPeekProps> = ({ citation, snippet, onOpen, url }) => {
  const t = useTranslations('chat')
  const { document: doc } = citation
  const tint = doc.tint

  return (
    <div className="space-y-2">
      {/* What kind of source this is — the answer to "can I rely on it?" */}
      <div className="flex flex-wrap items-center gap-1.5">
        <SourceSignalChip signal={tint}>{t(`sourcePreview.kinds.${doc.kind}`)}</SourceSignalChip>
        {doc.laneLabel && (
          <span className="text-[11px] font-medium text-muted-foreground">{doc.laneLabel}</span>
        )}
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
          <p
            className="text-[10px] font-semibold uppercase tracking-[0.05em]"
            style={{ color: `var(--source-${tint}-text, var(--muted-foreground))` }}
          >
            {t('sourcePreview.bindingLabel')}
          </p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-foreground">{doc.bindingNote}</p>
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
          <p
            className="text-[10.5px] font-semibold uppercase tracking-[0.05em]"
            style={{ color: `var(--source-${tint}-text, var(--muted-foreground))` }}
          >
            {t('sourcePreview.citedPassage')}
          </p>
          <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
            {snippet}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2">
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1 text-[12.5px] font-medium hover:underline"
            style={{ color: `var(--source-${tint}-text, var(--foreground))` }}
          >
            <FileSearch aria-hidden="true" className="size-3.5" />
            {t('citationPeek.openAtPage')}
          </button>
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[12.5px] font-medium hover:underline"
            style={{ color: `var(--source-${tint}-text, var(--foreground))` }}
          >
            {t('sourcePreview.openExternal')}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        )}
        <span className="flex-1" />
        <CopyCitationLinkButton citation={citation} icon={<Link2 className="size-3" />} />
        <CopySourceCitationButton citation={citation} />
      </div>
    </div>
  )
}
