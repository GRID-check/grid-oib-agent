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

import { type FC, type ReactNode } from 'react'
import type { AnatomyShape, AnatomyVerdict } from '../lib/answer-meta-cards'
import { CalloutCard } from '@/features/grid-cards/components/CalloutCard'
import { KeyTakeawaysCard } from '@/features/grid-cards/components/KeyTakeawaysCard'
import { VerdictHeaderCard } from '@/features/grid-cards/components/VerdictHeaderCard'
import type { AnswerKind } from '@/lib/conversations/message-answer-meta'

/**
 * The gavel is the ruling's signature. A walkthrough / direct / handoff that
 * still carries a verdict must not open as a ruling. An absent kind is the
 * legacy envelope: a present verdict still earns the masthead.
 */
function showsVerdictMasthead(
  kind: AnswerKind | undefined,
  verdict: AnatomyVerdict | undefined
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
 * line. The confidence is the VERDICT's own, from the masthead event: the
 * verdict figure is where the reader looks, so the gauge sits beside it as it
 * did on the retired card. The turn's self-assessment is not threaded in: it
 * arrives with the terminal frame, and inserting its gauge and reason above
 * the prose then moved the first paragraph the reader was on (it is in the
 * answer details instead). No eyebrow on the topic path: the one value
 * the contract carries would print the same words twice stacked, and a kicker
 * that repeats its headline is decoration, not orientation.
 *
 * No entrance of its own: mounted with the answer it is part of the answer's
 * entrance, and arriving later its caller fades it (`AgentResponse`).
 *
 * `caret`: the streaming caret, after the summary's last word while the
 * caller is still writing the summary in (`AgentResponse`'s `writingSummary`).
 */
export const AnatomyMasthead: FC<{
  verdict?: AnatomyVerdict
  summary?: string
  topic?: string
  context?: string
  kind?: AnswerKind
  caret?: ReactNode
}> = ({ verdict, summary, topic, context, kind, caret }) => {
  if (!mastheadShows({ verdict, summary, topic, kind })) return null
  const showVerdict = showsVerdictMasthead(kind, verdict)
  // A verdict masthead already headlines the answer; the topic must not
  // headline it twice.
  const showTopic = !showVerdict && Boolean(topic)
  return (
    <header className="border-border/70 flex flex-col gap-3 border-b pb-4">
      {showVerdict && verdict && verdict.type === 'verdict_header' && (
        <VerdictHeaderCard
          flat
          verdict={verdict.verdict}
          subject={verdict.subject}
          reference={verdict.reference}
          confidence={verdict.confidence}
          confidence_reason={verdict.confidence_reason}
        />
      )}
      {showTopic && topic && <p className="card-headline text-foreground text-balance">{topic}</p>}
      {context && (showVerdict || showTopic || summary) && (
        <p className="text-muted-foreground text-sm leading-relaxed">{context}</p>
      )}
      {summary && (
        <p className="text-foreground text-[1.0625rem] leading-[1.65]">
          {summary}
          {caret}
        </p>
      )}
    </header>
  )
}

/**
 * Whether the masthead draws anything: a verdict it may show, a topic, or a
 * summary. The caller reads it to decide whether a masthead is there at all,
 * so it can animate one arriving and leaving without an empty wrapper.
 */
export function mastheadShows({
  verdict,
  summary,
  topic,
  kind,
}: {
  verdict?: AnatomyVerdict
  summary?: string
  topic?: string
  kind?: AnswerKind
}): boolean {
  return showsVerdictMasthead(kind, verdict) || Boolean(topic) || Boolean(summary)
}

/**
 * One after-prose anatomy shape (from `answerMetaToAnatomy`), drawn flat.
 * The verdict never comes through here — it is the masthead's, above. No
 * entrance of its own: the block it sits in arrives as one
 * (`HeightArrival`), and a fade inside that fade played the entrance twice.
 */
export const AnatomyBlock: FC<{ card: AnatomyShape }> = ({ card }) => {
  if (card.type === 'callout') {
    return (
      <CalloutCard flat kind={card.kind} text={card.text} title={card.title} detail={card.detail} />
    )
  }
  if (card.type === 'key_takeaways') {
    return <KeyTakeawaysCard flat title={card.title} items={card.items ?? []} />
  }
  return null
}
