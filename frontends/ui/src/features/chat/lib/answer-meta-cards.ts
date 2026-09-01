/**
 * The answer's structured anatomy, expressed in the card SHAPE vocabulary.
 *
 * `answerMeta` is not cards — it is native answer fields the frontend renders
 * FLAT, as answer typography (the verdict as the answer's masthead, the
 * callout as an anchored aside, the takeaways as the closing block — see
 * `components/AnswerAnatomy.tsx`). But the SHAPES for a verdict, a callout
 * and a takeaway block already exist, charter-reviewed, in the grid-cards
 * types, and two prop contracts for one thing is the drift this repo keeps
 * hunting down. So the anatomy is mapped onto the retired card shapes here —
 * purely as render props and as input to `CardSetProvider` (cross-card rules
 * must see the anatomy), never entering the `cards` array, the card-marker
 * numbering, the export walker, or persistence.
 */

import type { GridCard } from '@/shared/cards/schemas'
import type { AnswerMeta } from '@/lib/conversations/message-answer-meta'

export interface AnswerAnatomy {
  /** The masthead's standfirst — the whole answer in 1–2 sentences. */
  summary?: string
  /** Rendered ABOVE the prose — the masthead's earned value. */
  verdict?: GridCard
  /** The one aside — spliced at its `[[callout]]` marker, else into `below`. */
  callout?: GridCard
  /** The closing block, always after the prose. */
  takeaways?: GridCard
  /**
   * The fixed after-prose order: the callout (when the prose did not claim it
   * with a marker), then the takeaways. Callers that placed the callout
   * inline render `below` without it.
   */
  below: GridCard[]
  /** Every anatomy shape, for cross-card coordination (`CardSetProvider`). */
  all: GridCard[]
}

/** Map a sanitized `answerMeta` onto the card shapes, or null when absent. */
export function answerMetaToAnatomy(meta: AnswerMeta | undefined): AnswerAnatomy | null {
  if (!meta) return null

  // The generated card shapes spell absence as `null`, so the mapping does too.
  const verdict: GridCard | undefined = meta.verdict
    ? {
        type: 'verdict_header',
        verdict: meta.verdict.value,
        subject: meta.verdict.subject,
        reference: meta.verdict.reference
          ? {
              document: meta.verdict.reference.document,
              section: meta.verdict.reference.section ?? null,
              edition: meta.verdict.reference.edition ?? null,
              excerpt: null,
            }
          : null,
        confidence: null,
        confidence_reason: null,
      }
    : undefined

  const callout: GridCard | undefined = meta.callout
    ? {
        type: 'callout',
        kind: meta.callout.kind,
        text: meta.callout.text,
        title: meta.callout.title ?? null,
        detail: meta.callout.detail ?? null,
      }
    : undefined

  const takeaways: GridCard | undefined =
    meta.takeaways && meta.takeaways.length >= 2
      ? {
          type: 'key_takeaways',
          title: null,
          items: meta.takeaways.map((t) => ({ text: t.text, detail: t.detail ?? null })),
        }
      : undefined

  const summary = meta.summary

  if (!summary && !verdict && !callout && !takeaways) return null

  const below: GridCard[] = []
  if (callout) below.push(callout)
  if (takeaways) below.push(takeaways)
  const all: GridCard[] = verdict ? [verdict, ...below] : [...below]
  return { summary, verdict, callout, takeaways, below, all }
}
