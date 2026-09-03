/**
 * LegalBasisCard — the product's proof-of-work.
 *
 * Reads like an authoritative legal citation, not a chat bubble: a quiet card
 * with a thin left accent, the law/Richtlinie + article/§ references in the
 * header (identifiers in mono), the cited regulation excerpt as a real
 * blockquote at a readable measure, a plain-language summary, and — when the
 * source can be resolved — a link out to the primary source (OIB / RIS).
 *
 * Every wire field here is PLAIN TEXT and is set as a text node, never parsed.
 * A shipped card once printed „[OIB-Richtlinie ansehen](https://www.oib.or.at/
 * de/oib-richtlinien)“ as literal brackets, beside the very link that markup was
 * imitating; the delimiters are now stripped on the way in, by `CardModel` in
 * `src/aiq_agent/cards/models.py`. Do NOT resolve that class of bug here by
 * teaching this component to read markdown: the anchors below are the ones the
 * card BUILDS from `law` and `lane`, so which links a legal citation carries is
 * decided by the schema. A renderer that parsed a text field would let the model
 * put an arbitrary one in — on the artifact that gets screenshotted into an
 * Einreichung. `LegalBasisCard.spec.tsx` pins both halves of that.
 */

'use client'

import { type FC, useState } from 'react'
import { Scale, ExternalLink, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import { resolveCorpusFileName } from '@/features/knowledge/lib/resolve-corpus-file'
import { useCorpusFiles } from '@/features/knowledge/lib/use-corpus-files'
import { accentForLane, authorityTag } from '@/features/chat/lib/source-kinds'
import type { LegalBasisCardData } from '../types'

/**
 * How wide a Fundstelle may be before the margin cannot hold it.
 *
 * The margin column is 72px at 11px mono — about ten characters to a line. An
 * identifier fits („3.1.1", „Tabelle 1a", „Abs. 4", „§ 106 Abs. 1"); a sentence
 * does not. A production card set `article` to „Punkte 8 bis 10 der
 * OIB-Richtlinie 2" and `section` to „Anwendungsbereiche der ergänzenden
 * Richtlinien", and the margin rendered them as a nine-line ragged pillar of
 * mono taller than the card beside it — with „§ " glued to the front of a
 * heading, a prefix that only reads on a number.
 *
 * The schema now says identifiers (`LegalBasisCard.article` / `.section` in
 * `src/aiq_agent/cards/models.py`); this is the layer that holds when the model
 * writes prose anyway. It degrades the way the charter already degrades the
 * column below 360px — the Fundstelle keeps its content and loses the margin,
 * running inline with the law name where German prose can wrap. Nothing is
 * dropped: this card is the citation an architect verifies.
 */
const MARGIN_IDENTIFIER_MAX_CHARS = 20

/** Trimmed, or null — an all-whitespace field is not a Fundstelle. */
const cleaned = (value: string | null | undefined): string | null => value?.trim() || null

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

  // The words that keep the accent from travelling alone (grid-design-language
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

  // The Fundstelle, and whether the margin can hold it. Judged over the PAIR:
  // article and section are one reference, so a short „3.1.1" does not stay in
  // the margin while the section it belongs to runs inline underneath.
  const articleRef = cleaned(article)
  const sectionRef = cleaned(section)
  const hasReference = Boolean(articleRef || sectionRef)
  const fitsMargin =
    (articleRef?.length ?? 0) <= MARGIN_IDENTIFIER_MAX_CHARS &&
    (sectionRef?.length ?? 0) <= MARGIN_IDENTIFIER_MAX_CHARS

  return (
    <div
      className={cn(
        'animate-in fade-in-0 slide-in-from-bottom-1 duration-base ease-entrance motion-reduce:animate-none flex flex-col gap-3 border-l-2 pl-4',
        accentClass
      )}
    >
      {/* Eyebrow — marks this as a citation, not a message */}
      <SectionLabel icon={Scale}>{t('cards.legalBasis')}</SectionLabel>

      {/* Header: law/Richtlinie + Ausgabe on the left, article/§ as marginalia
          in a fixed right column at 11px mono — the way a statute prints its §
          in the margin (charter §B1). Every other card puts metadata inline;
          this one puts it in a margin, and that is the difference seen before
          a word is read. The authority tier stays beside the law as plain
          text — the `title` keeps the "Rechtsquelle: …" wording for AT.
          A Fundstelle too long for the margin runs inline instead; see
          `MARGIN_IDENTIFIER_MAX_CHARS`. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="text-sm font-semibold text-foreground">{law}</p>
          {authority && (
            <span className="text-sm font-semibold text-muted-foreground" title={t('cards.authority', { tag: authority })}>
              {authority}
            </span>
          )}
          {/* The Ausgabe is what makes the citation checkable — „OIB-Richtlinie 2“
              names a document, „Ausgabe Mai 2023“ names the one that was read.
              Set beside the identifiers exactly as `NormRefFooter` sets it. */}
          {edition && <span className="text-xs text-muted-foreground">{edition}</span>}
          {/* The Fundstelle that outgrew the margin. Set inline with the law
              name at Body ink, and UNPREFIXED: „Art." and „§" are read as „this
              is a number", and in front of „Anwendungsbereiche der ergänzenden
              Richtlinien" they claim a shape the value does not have. */}
          {hasReference && !fitsMargin && (
            <span className="text-xs text-muted-foreground">
              {[articleRef, sectionRef].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        {hasReference && fitsMargin && (
          <div className="card-meta flex w-[72px] shrink-0 flex-col items-end gap-0.5 font-mono text-muted-foreground">
            {articleRef && <span>Art. {articleRef}</span>}
            {sectionRef && <span>§ {sectionRef}</span>}
          </div>
        )}
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
            className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-primary transition-opacity duration-quick ease-out hover:opacity-80 touch-target focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
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
            className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-primary transition-opacity duration-quick ease-out hover:opacity-80 touch-target"
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
