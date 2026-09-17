/**
 * RunBlockLine — the run block in one line, for the Aufträge index and the
 * previews that list threads.
 *
 *   [glyph] Fertig · Brandschutzkonzept — Fluchtwege · 3 Runden · 9 Dokumente · vor 3 Stunden   → Im Verlauf öffnen
 *
 * The same glyph, the same word and the same tallies as the full block's
 * header, derived by the same vocabulary, so the row in the index and the block
 * in the thread cannot disagree about the run they both describe. Numbers only
 * where they change what the reader does: the tallies say how much work is
 * behind the row, the time says how stale it is, and nothing else counts.
 *
 * It holds no subscription. A row is a snapshot of the ledger the index was
 * given; the block in the thread is where a live run is followed, and the
 * trailing link is the way there.
 */

'use client'

import type { FC } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

import { TimeAgo } from '@/components/ui/time-ago'
import { useLocale, useTranslations } from '@/i18n'
import type { RunLedger, RunStatus } from '@/lib/runs/run-ledger-types'
import { runDisplayStatus, runTallies, type RunTallies } from '@/lib/runs/run-vocabulary'
import { cn } from '@/lib/utils'
import { RunStatusGlyph } from './RunStatusGlyph'

export interface RunBlockLineProps {
  /** The run's ledger, or null for a row that has none yet. */
  ledger: RunLedger | null
  /** Overrides the ledger's status; the word for a row without a ledger. */
  status?: RunStatus
  /**
   * Overrides the ledger's tallies; the numbers for a row without a ledger.
   * The Aufträge index sends four facts per row rather than the ledger
   * (`TaskRunSummary`), and this is how those facts reach the same line.
   */
  tallies?: RunTallies
  /**
   * The run's title. Omitted inside a surface that already names the run —
   * the task card, whose heading IS the title — so it is not read twice.
   */
  title?: string
  /** The thread at the run: `?session=…&run=…#message-…` (`task-view.ts`). */
  href?: string
  /** When the row's state was last true — rendered relative after mount. */
  at?: string | Date
  className?: string
}

// `whitespace-pre`: as a flex item the span is block-level and would collapse
// its own leading and trailing space, gluing the dot to both neighbours.
const Sep: FC = () => (
  <span aria-hidden className="whitespace-pre text-muted-foreground/50">
    {' · '}
  </span>
)

export function RunBlockLine({
  ledger,
  status,
  tallies: givenTallies,
  title,
  href,
  at,
  className,
}: RunBlockLineProps): JSX.Element {
  const t = useTranslations('runs')
  const { locale } = useLocale()
  const shown: RunStatus = status ?? (ledger ? runDisplayStatus(ledger) : 'angelegt')
  const statusWord = t(`status.${shown}`)
  const tallies = givenTallies ?? (ledger ? runTallies(ledger) : { rounds: 0, docs: 0 })
  const atIso = at instanceof Date ? at.toISOString() : at

  return (
    <div
      data-testid="run-block-line"
      data-status={shown}
      className={cn('flex min-h-11 min-w-0 items-center gap-2 text-sm', className)}
    >
      {/* Decorative: the status word is the very next thing in the row. */}
      <RunStatusGlyph status={shown} size="sm" />
      {/* The title is the one clause that gives way; the word, the tallies and
          the time are short facts and stay whole, because a row that reads
          „vor 1…" has lost the thing the time was there for. The tallies step
          aside on a phone, where the title needs the width more. */}
      <span className="flex min-w-0 flex-1 items-baseline overflow-hidden">
        <span className="shrink-0 font-semibold text-foreground" data-testid="run-line-status">
          {statusWord}
        </span>
        {title && (
          <>
            <Sep />
            <span className="min-w-0 truncate text-foreground">{title}</span>
          </>
        )}
        {(tallies.rounds > 0 || tallies.docs > 0) && (
          <span className="hidden shrink-0 text-muted-foreground sm:inline">
            <Sep />
            {[
              tallies.rounds > 0 ? t('tallies.rounds', { count: tallies.rounds }) : null,
              tallies.docs > 0 ? t('tallies.docs', { count: tallies.docs }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        {atIso && (
          <span className="shrink-0 text-muted-foreground">
            <Sep />
            <TimeAgo date={atIso} locale={locale} />
          </span>
        )}
      </span>
      {/* On a phone the word, the time and a text link do not fit beside a
          title, so the link is its arrow alone there and the text is its
          accessible name; the 44px floor keeps the arrow pressable. */}
      {href && (
        <Link
          href={href}
          aria-label={t('action.openInThread')}
          className="ml-auto inline-flex shrink-0 items-center justify-center gap-1 rounded-md text-xs font-medium text-primary hover:underline pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          data-testid="run-line-open"
        >
          <span className="hidden sm:inline">{t('action.openInThread')}</span>
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      )}
    </div>
  )
}
