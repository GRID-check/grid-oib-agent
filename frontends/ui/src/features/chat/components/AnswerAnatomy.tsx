'use client'

/**
 * The flat renderer for the answer's native anatomy.
 *
 * The envelope's verdict, callout and takeaways are fields OF the answer, so
 * they render in the FLAT register — answer typography on the answer surface —
 * never in card chrome: the verdict as the answer's masthead, the callout as
 * an accent-ruled aside (beside the paragraph its `[[callout]]` marker anchors
 * it to), the takeaways as the closing block. The visual craft lives in the
 * card components' `flat` variants so a stored thread's framed card and a live
 * answer's anatomy can never drift apart; this file only dispatches.
 */

import { type FC } from 'react'
import type { GridCard } from '@/shared/cards/schemas'
import { CalloutCard } from '@/features/grid-cards/components/CalloutCard'
import { KeyTakeawaysCard } from '@/features/grid-cards/components/KeyTakeawaysCard'
import { VerdictHeaderCard } from '@/features/grid-cards/components/VerdictHeaderCard'
import { FadeIn } from '@/components/motion'

/**
 * The answer's masthead: the verdict (when one was earned) and the summary —
 * the whole answer in one to two sentences, set at the lede's own type so the
 * standfirst IS the lede (AgentResponse suppresses the first-paragraph lede
 * styling when a summary is present, so the emphasis exists exactly once).
 * One hairline closes the whole header over the prose, whatever it holds.
 */
export const AnatomyMasthead: FC<{ verdict?: GridCard; summary?: string }> = ({ verdict, summary }) => {
  if (!verdict && !summary) return null
  return (
    <FadeIn distance={4}>
      <header className="flex flex-col gap-3 border-b border-border/70 pb-4">
        {verdict && verdict.type === 'verdict_header' && (
          <VerdictHeaderCard
            flat
            verdict={verdict.verdict}
            subject={verdict.subject}
            reference={verdict.reference}
            confidence={verdict.confidence}
            confidence_reason={verdict.confidence_reason}
          />
        )}
        {summary && <p className="text-[1.0625rem] leading-[1.65] text-foreground">{summary}</p>}
      </header>
    </FadeIn>
  )
}

/**
 * One after-prose anatomy shape (from `answerMetaToAnatomy`), drawn flat.
 * The verdict never comes through here — it is the masthead's, above.
 */
export const AnatomyBlock: FC<{ card: GridCard }> = ({ card }) => {
  if (card.type === 'callout') {
    return (
      <FadeIn distance={4}>
        <CalloutCard flat kind={card.kind} text={card.text} title={card.title} detail={card.detail} />
      </FadeIn>
    )
  }
  if (card.type === 'key_takeaways') {
    return (
      <FadeIn distance={4}>
        <KeyTakeawaysCard flat title={card.title} items={card.items ?? []} />
      </FadeIn>
    )
  }
  return null
}
