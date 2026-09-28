/**
 * LegalBasisCard — the product's proof-of-work, laid out as a proof.
 *
 * Norm → Sachverhalt → Ergebnis, the Subsumtion an Austrian Gutachten argues
 * in: the norm's wording and what it requires, the project facts it is applied
 * to (each with where it came from), and the result. A card with no facts is a
 * citation and renders as one, without the step labels.
 *
 * The one claim the model cannot make is that the wording is the source's.
 * That is `verification`, stamped by the server (`cards/legal_proof.py`):
 * `verbatim` puts a „Wortlaut belegt“ seal on the card with the passage's
 * [N] and opens the document on that page with the sentence marked;
 * `not_found` takes the quotation marks away and says so; `unchecked` (or no
 * stamp, a card persisted before it existed) keeps the AI-citation notice the
 * card always carried.
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
import { Scale, ExternalLink, FileText, ShieldCheck, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import { resolveCorpusFileName } from '@/features/knowledge/lib/resolve-corpus-file'
import { useCorpusFiles } from '@/features/knowledge/lib/use-corpus-files'
import { accentForLane, authorityTag } from '@/features/chat/lib/source-kinds'
import { StatusBadge } from '../schematics/kit'
import type { LegalBasisCardData } from '../types'

type Verification = NonNullable<LegalBasisCardData['verification']>
type Fact = NonNullable<LegalBasisCardData['facts']>[number]

/**
 * How wide a Fundstelle may be before the margin cannot hold it.
 *
 * The margin column is at least 72px at 11px mono, sized to its content and
 * never wrapped, so it holds one identifier per line of up to 14 characters
 * („3.1.1", „Tabelle 1a", „Abs. 4", „§ 106 Abs. 1") in any column down to a
 * phone's. A sentence does not fit. A production card set `article` to „Punkte 8 bis 10 der
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
const MARGIN_IDENTIFIER_MAX_CHARS = 14

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

/** The viewable corpus file the proof passage lives in, matched on its exact name, or null. */
const proofFileIn = (fileName: string | null | undefined, files: { fileName: string; origin: string }[]): string | null => {
  const wanted = fileName?.trim().toLowerCase()
  if (!wanted) return null
  return files.find((f) => f.origin !== 'index_only' && f.fileName.toLowerCase() === wanted)?.fileName ?? null
}

/** Small-caps step label; only drawn when the card argues (has facts). */
const StepLabel: FC<{ children: string }> = ({ children }) => (
  <span className="card-meta font-medium uppercase tracking-wider text-muted-foreground">{children}</span>
)

/** The seal beside the eyebrow: what the server found, never what the model said. */
const ProofSeal: FC<{ verification: Verification }> = ({ verification }) => {
  const t = useTranslations('chat')
  if (verification.status === 'verbatim') {
    return (
      <span
        className="card-meta inline-flex shrink-0 items-center gap-1 rounded-full bg-success-subtle px-2 py-0.5 text-success"
        title={t('cards.legalProof.verbatimTitle')}
      >
        <ShieldCheck className="size-3.5" aria-hidden="true" />
        {verification.number != null
          ? t('cards.legalProof.verbatimNumbered', { number: String(verification.number) })
          : t('cards.legalProof.verbatim')}
      </span>
    )
  }
  if (verification.status === 'not_found') {
    return (
      <span
        className="card-meta inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-subtle px-2 py-0.5 text-warning"
        title={t('cards.legalProof.notFoundTitle')}
      >
        <ShieldAlert className="size-3.5" aria-hidden="true" />
        {t('cards.legalProof.notFound')}
      </span>
    )
  }
  return null
}

/** „Fundort: OIB-RL_2_2023.pdf · S. 14 · Pkt. 3.1.1“ — where the verified wording stands. */
const locatorOf = (verification: Verification, t: ReturnType<typeof useTranslations>): string | null => {
  const parts = [
    verification.title ?? verification.file_name,
    verification.page != null ? t('cards.legalProof.page', { page: String(verification.page) }) : null,
    verification.punkt ? t('cards.legalProof.punkt', { punkt: verification.punkt }) : null,
  ].filter((part): part is string => Boolean(part))
  return parts.length ? parts.join(' · ') : null
}

/** The Sachverhalt: one row per fact — what, its value, where it came from. */
const FactList: FC<{ facts: Fact[] }> = ({ facts }) => (
  <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
    {facts.map((fact, index) => (
      <div key={index} className="contents">
        <dt className="min-w-0 text-foreground">
          {fact.label}
          {fact.origin && <span className="ml-2 text-xs text-muted-foreground">{fact.origin}</span>}
        </dt>
        <dd className="text-right font-mono tabular-nums text-foreground">{fact.value}</dd>
      </div>
    ))}
  </dl>
)

export const LegalBasisCard: FC<LegalBasisCardData> = ({
  law,
  lane,
  edition,
  article,
  section,
  summary,
  original_text,
  facts,
  conclusion,
  outcome,
  verification,
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

  // The proof. A verified wording opens the very passage that holds it — its
  // file, its page, the sentence marked — rather than the Richtlinie's cover.
  const verified = verification?.status === 'verbatim' ? verification : null
  const paraphrased = verification?.status === 'not_found'
  const proofFile = verified ? proofFileIn(verified.file_name, corpusFiles) : null
  const viewerFile = proofFile ?? corpusFileName
  const locator = verified ? locatorOf(verified, t) : null
  // A card with facts argues; one without cites. Only the first gets step labels.
  const factRows = facts?.filter((fact) => fact.label.trim() && fact.value.trim()) ?? []
  const argues = factRows.length > 0 || Boolean(conclusion?.trim()) || Boolean(outcome)

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
      {/* Eyebrow — marks this as a citation, not a message — and the seal */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel icon={Scale}>{t('cards.legalBasis')}</SectionLabel>
        {verification && <ProofSeal verification={verification} />}
      </div>

      {/* Header: law/Richtlinie + Ausgabe on the left, article/§ as marginalia
          in a right column sized to its content at 11px mono (at least 72px,
          never wrapped) — the way a statute prints its §
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
          // Sized to its content and never wrapped: a fixed 72px margin broke
          // „§ Tabelle 1a" over two lines and pressed „Art. 3.1.1" into the
          // card edge. 14 characters plus the prefix is the most it may hold.
          <div className="card-meta flex min-w-[72px] shrink-0 flex-col items-end gap-0.5 whitespace-nowrap font-mono text-muted-foreground">
            {articleRef && <span>Art. {articleRef}</span>}
            {sectionRef && <span>§ {sectionRef}</span>}
          </div>
        )}
      </div>

      {/* 1 · Norm: the wording, and what it requires */}
      {(original_text || summary) && (
        <div className="flex flex-col gap-2">
          {argues && <StepLabel>{t('cards.legalProof.norm')}</StepLabel>}
          {original_text &&
            (paraphrased ? (
              // Wording no retrieved passage holds is NOT a quotation: no
              // italics, no quote rule, and the card says why.
              <div className="flex max-w-prose flex-col gap-1">
                <p className="text-sm leading-relaxed text-muted-foreground">{original_text}</p>
                <p className="text-xs leading-relaxed text-warning">{t('cards.legalProof.paraphrase')}</p>
              </div>
            ) : (
              <figure className="flex max-w-prose flex-col gap-1">
                <blockquote className="border-l-2 border-border pl-4 text-sm italic leading-relaxed text-muted-foreground">
                  {original_text}
                </blockquote>
                {locator && (
                  <figcaption className="card-meta pl-4 text-muted-foreground">
                    {t('cards.legalProof.foundAt')}: {locator}
                  </figcaption>
                )}
              </figure>
            ))}
          {summary && <p className="max-w-prose text-sm leading-relaxed text-foreground">{summary}</p>}
        </div>
      )}

      {/* 2 · Sachverhalt: the project facts the norm is applied to */}
      {factRows.length > 0 && (
        <div className="flex max-w-prose flex-col gap-2">
          <StepLabel>{t('cards.legalProof.facts')}</StepLabel>
          <FactList facts={factRows} />
        </div>
      )}

      {/* 3 · Ergebnis: the verdict in words and colour, never colour alone */}
      {(conclusion || outcome) && (
        <div className="flex max-w-prose flex-col gap-2">
          <StepLabel>{t('cards.legalProof.result')}</StepLabel>
          <div className="flex flex-wrap items-start gap-2">
            {outcome && <StatusBadge status={outcome} />}
            {conclusion && <p className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">{conclusion}</p>}
          </div>
        </div>
      )}

      {/* Verifiable primary source: the proof passage in-app when we have its
          file, the Richtlinie in-app otherwise, the external link always */}
      <div className="flex flex-wrap items-center gap-4">
        {viewerFile && (
          <button
            type="button"
            onClick={() => setViewerOpen(true)}
            className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-primary transition-opacity duration-quick ease-out hover:opacity-80 touch-target focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <FileText className="size-3.5" aria-hidden="true" />
            {proofFile ? t('cards.legalProof.openPassage') : tViewer('viewer.view')}
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

      {viewerFile && viewerOpen && (
        <PdfViewerDialog
          open
          onOpenChange={setViewerOpen}
          fileName={viewerFile}
          title={law}
          page={proofFile ? verified?.page : null}
          highlight={proofFile ? original_text : null}
        />
      )}

      {/* AI-transparency label (EU AI Act Art. 50). Only a server-verified
          wording earns the narrower notice; everything else is labelled as
          model-generated, as the card always was. */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {verified ? t('cards.legalProof.verifiedDisclaimer') : t('cards.aiGenerated')}
      </p>
    </div>
  )
}
