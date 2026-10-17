'use client'

import type { JSX, SyntheticEvent } from 'react'
import { useRouter } from 'next/navigation'
import { MessageSquareText, UserRound } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n/translate'
import type { MarkTally } from '@/lib/annotations/types'
import { cn } from '@/lib/utils'
import { reviewHrefAt } from '../lib/open-review'

/** What a listing needs of a row to say what is open on it. */
export interface OpenMarksSubject {
  id: string
  marks?: MarkTally | null
}

/** The sentence the chip stands for: „3 offene Anmerkungen, 1 für Sie". */
export function openMarksLabel(t: Translator, marks: MarkTally): string {
  return marks.forYou > 0
    ? t('annotations.listedOpenForYou', { count: marks.live, mine: marks.forYou })
    : t('annotations.listedOpen', { count: marks.live })
}

/** A click or a key on the chip is the chip's: the row or card around it opens the file, not the review. */
const keep = (event: SyntheticEvent) => event.stopPropagation()

/**
 * What a document in a listing still has open: its live Anmerkungen on every
 * Fassung, and how many of them are the reader's („3 offene Anmerkungen,
 * 1 für Sie"), counted by the server with the listing (`tallyLiveMarks`).
 * Nothing when nothing is open, so a folder scanned at a glance shows only the
 * documents with work on them.
 *
 * A press opens the document's Prüfansicht: the page's own URL with `doc` and
 * `review=1` (`reviewHrefAt`), which the shelf's `?doc=` sync and the preview
 * pane already answer, so this adds no second way in.
 */
export function OpenMarksChip({
  file,
  name,
  className,
}: {
  file: OpenMarksSubject
  /** The document's name as the row shows it: a screen reader moving by buttons hears which document each one opens. */
  name: string
  className?: string
}): JSX.Element | null {
  if (!file.marks || file.marks.live <= 0) return null
  return <OpenMarksButton documentId={file.id} name={name} marks={file.marks} className={className} />
}

/** Its own component so `useRouter` runs only for a row that has something open. */
function OpenMarksButton({
  documentId,
  name,
  marks,
  className,
}: {
  documentId: string
  name: string
  marks: MarkTally
  className?: string
}): JSX.Element {
  const t = useTranslations('files')
  const router = useRouter()
  const label = openMarksLabel(t, marks)
  return (
    <Chip asChild interactive size="sm" variant="muted" className={cn('gap-1 tabular-nums', className)}>
      <button
        type="button"
        data-slot="open-marks"
        data-testid="open-marks"
        aria-label={t('annotations.listedOpenIn', { marks: label, name })}
        title={label}
        onPointerDown={keep}
        onKeyDown={keep}
        onClick={(event) => {
          keep(event)
          router.push(reviewHrefAt(window.location, { documentId }, { withDocument: true }), { scroll: false })
        }}
      >
        <MessageSquareText aria-hidden />
        <span>{marks.live}</span>
        {marks.forYou > 0 && (
          <>
            <UserRound aria-hidden className="ml-0.5" />
            <span>{marks.forYou}</span>
          </>
        )}
      </button>
    </Chip>
  )
}
