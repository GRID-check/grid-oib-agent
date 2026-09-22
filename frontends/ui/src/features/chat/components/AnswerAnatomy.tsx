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
import type { AnswerKind } from '@/lib/conversations/message-answer-meta'

/**
 * The gavel is the ruling's signature. A walkthrough / direct / handoff that
 * still carries a verdict must not open as a ruling. An absent kind is the
 * legacy envelope: a present verdict still earns the masthead.
 */
function showsVerdictMasthead(
  kind: AnswerKind | undefined,
  verdict: GridCard | undefined
): boolean {
  return (
    Boolean(verdict) &&
    verdict?.type === 'verdict_header' &&
    (kind === 'ruling' || kind === undefined)
  )
}

/**
 * The answer's masthead: the verdict (when one was earned), else the topic —
 * and the summary, the whole answer in one to two sentences, set at the lede's
 * own type so the standfirst IS the lede (AgentResponse suppresses the
 * first-paragraph lede styling when a summary is present, so the emphasis
 * exists exactly once). One hairline closes the whole header over the prose,
 * whatever it holds.
 *
 * The title is the verdict's value (the large figure, rendered by
 * `VerdictHeaderCard`) or the topic (the answer-level `card-headline` step —
 * the same size the summary standfirst sets, told apart by weight). The
 * context rides in muted ink under the title, or over the summary when no
 * title survived (a ruling whose verdict the gate refused still names its
 * Richtlinie and Ausgabe); with nothing else in the masthead it renders no
 * line. The confidence is the answer's own, threaded in from the turn: the
 * verdict figure is where the reader looks, so the gauge sits beside it as it
 * did on the retired card. No eyebrow on the topic path: the one value
 * the contract carries would print the same words twice stacked, and a kicker
 * that repeats its headline is decoration, not orientation.
 */
export const AnatomyMasthead: FC<{
  verdict?: GridCard
  summary?: string
  topic?: string
  context?: string
  kind?: AnswerKind
  confidence?: 'low' | 'medium' | 'high'
  confidenceReason?: string
}> = ({ verdict, summary, topic, context, kind, confidence, confidenceReason }) => {
  const showVerdict = showsVerdictMasthead(kind, verdict)
  // A verdict masthead already headlines the answer; the topic must not
  // headline it twice.
  const showTopic = !showVerdict && Boolean(topic)
  if (!showVerdict && !showTopic && !summary) return null
  return (
    <FadeIn distance={4}>
      <header className="border-border/70 flex flex-col gap-3 border-b pb-4">
        {showVerdict && verdict && verdict.type === 'verdict_header' && (
          <VerdictHeaderCard
            flat
            verdict={verdict.verdict}
            subject={verdict.subject}
            reference={verdict.reference}
            confidence={confidence ?? verdict.confidence}
            confidence_reason={confidenceReason ?? verdict.confidence_reason}
          />
        )}
        {showTopic && topic && (
          <p className="card-headline text-foreground text-balance">{topic}</p>
        )}
        {context && (showVerdict || showTopic || summary) && (
          <p className="text-muted-foreground text-sm leading-relaxed">{context}</p>
        )}
        {summary && <p className="text-foreground text-[1.0625rem] leading-[1.65]">{summary}</p>}
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
        <CalloutCard
          flat
          kind={card.kind}
          text={card.text}
          title={card.title}
          detail={card.detail}
        />
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
