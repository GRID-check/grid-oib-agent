'use client'

/**
 * The flat renderer for an UNPLACED `legal_basis` card.
 *
 * A `legal_basis` the prose claimed with a `[[card:N]]` marker draws where it
 * was claimed, framed, like any other card (`GridCards`). One no marker
 * claimed is not a fallback-grid item: the answer argued from a Fundstelle and
 * the reader deserves to see which one, so it renders here — flat, in the
 * answer's own flow above the prose, as the RECHTSGRUNDLAGE block: the one
 * Fundstelle line, the short quote, and the muted AI-transparency line. Never
 * both registers: `AgentResponse` takes the card out of the fallback indices
 * when it draws this block.
 *
 * Deliberately spare beside `LegalBasisCard`: no plain-language summary (the
 * prose beside it already argues), no primary-source links (nothing here
 * resolves a corpus file or builds a RIS query — that affordance stays on the
 * framed card). The eyebrow, the quote measure and the accent follow the
 * framed card's language (`SectionLabel`, the blockquote, `accentForLane`) so
 * the two surfaces cannot disagree about the same citation.
 *
 * SEMANTIC COLOR: this block borrows NO hue of its own — the left rule inherits
 * the cited norm's lane tint (OIB indigo / RIS blue via `accentForLane`, as on
 * the framed card), and in particular never red: this block argues from a
 * source, it never warns.
 */

import { type FC } from 'react'
import { Scale } from 'lucide-react'
import { SectionLabel } from '@/components/ui/section-label'
import { FadeIn } from '@/components/motion'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { LegalBasisCardData } from '@/shared/cards/schemas'
import { accentForLane } from '@/features/chat/lib/source-kinds'

export const EvidenceBlock: FC<{ card: LegalBasisCardData }> = ({ card }) => {
  const t = useTranslations('chat')
  // The same tier decision as the framed card: OIB indigo or RIS blue, off
  // the card's own lane — never guessed from the law name.
  const tint = accentForLane(card.lane, 'law')
  // ONE Fundstelle line above the quote: the law, its article/section labels
  // and the edition it was verified against, as a single muted sentence. Only
  // fields the card shape carries — nothing is invented to fill the line.
  const fundstelle = [card.law, card.article, card.section, card.edition]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' · ')

  return (
    <FadeIn distance={4}>
      <section
        aria-label={t('cards.legalBasis')}
        className={cn(
          'flex flex-col gap-2 border-l-2 pl-4',
          tint === 'oib' ? 'border-l-source-oib/40' : 'border-l-source-law/40'
        )}
      >
        <SectionLabel icon={Scale}>{t('cards.legalBasis')}</SectionLabel>
        <p className="text-sm leading-relaxed text-muted-foreground">{fundstelle}</p>
        {card.original_text && (
          <blockquote className="max-w-prose border-l-2 border-border pl-4 text-sm italic leading-relaxed text-muted-foreground">
            {card.original_text}
          </blockquote>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('cards.evidenceQuoteDisclaimer')}
        </p>
      </section>
    </FadeIn>
  )
}
