/**
 * The answer's structured anatomy, expressed in the card VISUAL vocabulary.
 *
 * `answerMeta` is not cards — it is native answer fields with a FIXED layout
 * (verdict above the prose, callout and takeaways after it) that the model
 * cannot influence. But the visual language for a verdict, a callout and a
 * takeaway block already exists, charter-reviewed, in the grid-cards renderers,
 * and two implementations of one look is the drift this repo keeps hunting
 * down. So the anatomy is mapped onto the retired card SHAPES here — purely as
 * render props for `GridCardItem`, never entering the `cards` array, the
 * marker/placement machinery, the export walker, or persistence.
 */

import type { GridCard } from '@/shared/cards/schemas'
import type { AnswerMeta } from '@/lib/conversations/message-answer-meta'

export interface AnswerAnatomy {
  /** Rendered ABOVE the prose — the answer's headline value. */
  verdict?: GridCard
  /** Rendered after the prose, in this order: the callout, then the takeaways. */
  below: GridCard[]
  /** Every anatomy card, for cross-card coordination (`CardSetProvider`). */
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

  const below: GridCard[] = []
  if (meta.callout) {
    below.push({
      type: 'callout',
      kind: meta.callout.kind,
      text: meta.callout.text,
      title: meta.callout.title ?? null,
      detail: meta.callout.detail ?? null,
    })
  }
  if (meta.takeaways && meta.takeaways.length >= 2) {
    below.push({
      type: 'key_takeaways',
      title: null,
      items: meta.takeaways.map((t) => ({ text: t.text, detail: t.detail ?? null })),
    })
  }

  if (!verdict && below.length === 0) return null
  return { verdict, below, all: verdict ? [verdict, ...below] : below }
}
