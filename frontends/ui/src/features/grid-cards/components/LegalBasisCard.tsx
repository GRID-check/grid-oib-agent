/**
 * LegalBasisCard — the product's proof-of-work.
 *
 * Reads like an authoritative legal citation, not a chat bubble: a quiet card
 * with a thin left accent, the law/Richtlinie + article/§ references in the
 * header (identifiers in mono), the cited regulation excerpt as a real
 * blockquote at a readable measure, a plain-language summary, and — when the
 * source can be resolved — a link out to the primary source (OIB / RIS).
 */

'use client'

import { type FC, useState } from 'react'
import { Scale, ExternalLink, FileText } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import { resolveCorpusFileName } from '@/features/knowledge/lib/resolve-corpus-file'
import { useCorpusFiles } from '@/features/knowledge/lib/use-corpus-files'
import { accentForLane, authorityTag } from '@/features/chat/lib/source-kinds'
import type { LegalBasisCardData } from '../types'

/**
 * Resolve a verifiable primary-source URL for a legal basis.
 *
 * OIB Richtlinien are published by the Österreichisches Institut für Bautechnik;
 * everything else (Gesetze, Verordnungen) is searchable in the federal legal
 * information system (RIS). Returns null when nothing sensible can be built.
 */
const resolveSourceUrl = (law: string, section: string | null | undefined, isOib: boolean): string | null => {
  const trimmed = law.trim()
  if (!trimmed) return null

  if (isOib) return 'https://www.oib.or.at/de/oib-richtlinien'

  const query = [trimmed, section ? `§ ${section}` : ''].filter(Boolean).join(' ')
  return `https://www.ris.bka.gv.at/Ergebnis.wxe?Abfrage=Gesamtabfrage&SucheNachText=${encodeURIComponent(
    query
  )}`
}

export const LegalBasisCard: FC<LegalBasisCardData> = ({
  law,
  lane,
  edition,
  article,
  section,
  summary,
  original_text,
}) => {
  const t = useTranslations('chat')
  const tViewer = useTranslations('knowledge')

  // The left accent is the LAW signal, not ink: this card is the trust
  // affordance, and `border-l-primary/30` made it read as any other quiet card
  // (grid-design-language.md §"Domain-specific treatments" names
  // `border-l-2 border-l-source-law/40` verbatim). Which tier of the law family
  // it paints — the OIB indigo accent or the RIS blue — is decided by
  // `accentForLane` off the card's own `lane`, the same helper and the same
  // lane vocabulary the "Belegt durch" chips and the Herleitung fan-out use, so
  // the two surfaces cannot disagree about the same document. A card with no
  // lane keeps the stratum colour; the accent is never derived from the law
  // string, which is the drift that helper exists to prevent.
  const tint = accentForLane(lane, 'law')
  const accentClass = tint === 'oib' ? 'border-l-source-oib/40' : 'border-l-source-law/40'

  // The badge that keeps the accent from travelling alone (grid-design-language
  // §"Provenance signal system"): colour separates OIB from RIS, this says which
  // in words. Only ever rendered off a lane the card actually carries — a tier
  // guessed from the law name would be a provenance claim nothing backs.
  const authority = lane ? authorityTag(lane) : null

  // Where "verify this" goes. The lane decides when the card has one; the law
  // string is consulted only for a card persisted before `lane` existed, which
  // is the behaviour those cards already had.
  const isOib = lane ? tint === 'oib' : /oib|richtlinie/i.test(law)
  const sourceUrl = resolveSourceUrl(law, section, isOib)

  // When the cited Richtlinie's source PDF exists in the knowledge base, the
  // citation opens the actual document in-app instead of just linking out.
  const corpusFiles = useCorpusFiles()
  const corpusFileName = resolveCorpusFileName(law, corpusFiles)
  const [viewerOpen, setViewerOpen] = useState(false)

  return (
    <div
      className={cn(
        'animate-in fade-in-0 slide-in-from-bottom-1 flex flex-col gap-3 border-l-2 pl-4',
        accentClass
      )}
    >
      {/* Eyebrow — marks this as a citation, not a message */}
      <SectionLabel icon={Scale}>{t('cards.legalBasis')}</SectionLabel>

      {/* Header: law/Richtlinie + Ausgabe + § / article references */}
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-foreground">{law}</p>
        {authority && (
          <Badge variant="outline" className="text-xs font-medium" title={t('cards.authority', { tag: authority })}>
            {authority}
          </Badge>
        )}
        {article && (
          <Badge variant="outline" className="font-mono text-xs font-normal">
            Art. {article}
          </Badge>
        )}
        {section && (
          <Badge variant="outline" className="font-mono text-xs font-normal">
            § {section}
          </Badge>
        )}
        {/* The Ausgabe is what makes the citation checkable — „OIB-Richtlinie 2“
            names a document, „Ausgabe Mai 2023“ names the one that was read.
            Set beside the identifiers exactly as `NormRefFooter` sets it. */}
        {edition && <span className="text-xs text-muted-foreground">{edition}</span>}
      </div>

      {/* Cited excerpt — a real blockquote at a readable measure */}
      {original_text && (
        <blockquote className="max-w-prose border-l-2 border-border pl-4 text-sm italic leading-relaxed text-muted-foreground">
          {original_text}
        </blockquote>
      )}

      {/* Plain-language summary */}
      {summary && <p className="max-w-prose text-sm leading-relaxed text-foreground">{summary}</p>}

      {/* Verifiable primary source: in-app PDF when we have it, link otherwise */}
      <div className="flex flex-wrap items-center gap-4">
        {corpusFileName && (
          <button
            type="button"
            onClick={() => setViewerOpen(true)}
            className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-primary transition-opacity duration-200 ease-out hover:opacity-80 touch-target focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <FileText className="size-3.5" aria-hidden="true" />
            {tViewer('viewer.view')}
          </button>
        )}
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-primary transition-opacity duration-200 ease-out hover:opacity-80 touch-target"
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
            {isOib ? t('cards.viewOib') : t('cards.verifyRis')}
          </a>
        )}
      </div>

      {corpusFileName && viewerOpen && (
        <PdfViewerDialog open onOpenChange={setViewerOpen} fileName={corpusFileName} title={law} />
      )}

      {/* AI-transparency label (EU AI Act Art. 50): the excerpt above is
          model-generated, not a verbatim copy of the regulation. */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t('cards.aiGenerated')}
      </p>
    </div>
  )
}
