'use client'

/**
 * AskAboutChip — the generalised form of the follow-up chip, for a row that
 * says what is missing but leaves the reader to retype it.
 *
 * A check that cannot be decided already names the gap precisely: „Dieser
 * Export enthält kein IfcRailing — Handläufe im CAD als IfcRailing
 * modellieren". Until now the only way to ask about that was to read it off the
 * screen and type it back in, which is most of the work and therefore usually
 * not done. The chip builds the whole question out of the row's OWN words and
 * puts it in the composer.
 *
 * It is exactly the `follow_ups` mechanism and deliberately nothing more:
 * `setComposerPrefill(question)` queues the text on the chat store, `InputArea`
 * consumes it once — filling the draft, focusing the textarea, caret at the end
 * — and the user still presses send. No turn is fired, nothing is fetched,
 * nothing is persisted („nicht zurück zum LLM … ich klick das und sehe mehr").
 * If the composer already holds the user's own in-progress text, `InputArea`
 * drops the prefill rather than clobbering it; that precedence lives there and
 * is not worked around here.
 *
 * The question is BUILT, not templated at the reader: a chip renders only when
 * the row carries enough of its own words to make a sentence somebody would
 * actually send. A subject too short to name anything produces no chip at all,
 * because a question with a hole where the subject should be is worse than no
 * question — it teaches the reader that these chips are decoration.
 */

import { type FC } from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import { useChatStore } from '@/features/chat/store'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

/** Sentence marks a row may end on, dropped before the template's own lands. */
const TRAILING_MARKS = new Set(['.', ',', ';', ':', '!', '?', '…'])

/**
 * Strip the trailing run of sentence marks.
 *
 * A loop rather than `/[.,;:!?…]+$/`: that pattern is anchored at the end but
 * can begin at any position, so on a row of many marks the engine retries from
 * each one and the scan is quadratic — 32k colons took 1,007ms. The text is a
 * card row label written by the model, so its length and shape are not ours to
 * bound. A lookbehind would also fix it, but nothing else in this codebase uses
 * one and a plain loop needs no compatibility argument.
 */
const stripTrailingMarks = (text: string): string => {
  let end = text.length
  while (end > 0 && TRAILING_MARKS.has(text[end - 1])) end -= 1
  return text.slice(0, end)
}

/**
 * Row text as it goes into a sentence: whitespace collapsed, and the trailing
 * sentence mark dropped so the template's own punctuation does not land on top
 * of it („… modellieren.. Wie kann ich" was the first version).
 */
const tidy = (text: string | null | undefined): string =>
  stripTrailingMarks(
    (text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  ).trim()

/** Below this a fragment names nothing — „?", „m", „n/a" — and makes no question. */
const MIN_MEANINGFUL = 3

interface AskAboutChipProps {
  /** What the row is about — the check's or requirement's own label. */
  subject: string | null | undefined
  /** What the row says is missing: the CAD remedy, or the open point. */
  missing?: string | null
  className?: string
}

export const AskAboutChip: FC<AskAboutChipProps> = ({ subject, missing, className }) => {
  const t = useTranslations('chat')
  const setComposerPrefill = useChatStore((s) => s.setComposerPrefill)

  const cleanSubject = tidy(subject)
  const cleanMissing = tidy(missing)

  // No subject, no question. Rendering a chip here would offer „Bei „“ fehlt
  // eine Angabe …" — a template with the placeholder showing through.
  if (cleanSubject.length < MIN_MEANINGFUL) return null

  const question =
    cleanMissing.length >= MIN_MEANINGFUL
      ? t('cards.askAbout.missingWithDetail', { subject: cleanSubject, missing: cleanMissing })
      : t('cards.askAbout.missingOnly', { subject: cleanSubject })

  return (
    <button
      type="button"
      // Repeated once per unanswerable row, so the visible „Dazu fragen" is not
      // a name on its own; the subject makes each one distinguishable in a
      // screen reader's list of buttons.
      aria-label={t('cards.askAbout.chipAria', { subject: cleanSubject })}
      // The whole sentence that is about to land in the composer, so the reader
      // can see what they are taking before they take it.
      title={question}
      onClick={() => setComposerPrefill(question)}
      className={cn(
        'group inline-flex h-6 max-w-full shrink-0 items-center gap-1 rounded-md border px-2',
        'bg-card text-muted-foreground shadow-xs text-[11px] font-medium',
        'transition-colors duration-quick ease-out motion-reduce:transition-none',
        'hover:bg-accent hover:text-foreground',
        'focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-2',
        'pointer-coarse:h-8',
        className
      )}
    >
      <MessageCircleQuestion
        className="size-3 shrink-0 transition-colors duration-quick ease-out motion-reduce:transition-none"
        aria-hidden="true"
      />
      <span className="truncate">{t('cards.askAbout.chip')}</span>
    </button>
  )
}
