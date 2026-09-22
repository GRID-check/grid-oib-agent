'use client'

/**
 * One delegated task, as the product's card.
 *
 * It was a bordered `<li>` whose only click target was the title — a 200-pixel
 * string with a hover underline, floating in a row of chips and links that
 * looked exactly as clickable. Three things follow from making the whole card
 * the target instead, and they are the reason for this file:
 *
 *   - **One target, not four.** Fitts's law says the cost of a click is the
 *     distance to a target divided by its size; a card is the biggest target
 *     the layout can offer, and a reader stops aiming. The result link inside
 *     it is the one deliberate exception, and it stops the click from
 *     propagating so "open the document" never also opens the drawer.
 *   - **The card anatomy the product already has.** `RaisedCard` is a white
 *     sheet laid into a tray, with the quiet temporal metadata showing on the
 *     tray beneath it — the same shape a file, a project and a schedule use.
 *     A task that looked like nothing else in the app read as a log line.
 *   - **Status as a swatch on the title line.** A 10px rounded square, the
 *     same shape the timetable and the schedule cards already use to mean
 *     "this colour stands for this row" — see {@link STATUS_SWATCH} for the two
 *     louder shapes it replaced and why both were wrong.
 *
 * `interactive` is on, which is the promise: the lift says a click opens
 * something, and here it does.
 */

import type { KeyboardEvent, MouseEvent } from 'react'
import Link from 'next/link'
import {
  ArrowRight,
  CheckCircle2,
  CircleDot,
  FileText,
  MessageSquare,
  XCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Chip } from '@/components/ui/chip'
import { RaisedCard, RaisedCardBody, RaisedCardFooter } from '@/components/ui/raised-card'
import { Spinner } from '@/components/ui/spinner'
import { RunBlockLine } from '@/features/runs/components/RunBlockLine'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import type { TaskRunStatus } from '@/lib/tasks/task-vocabulary'
import { cn } from '@/lib/utils'
import { isActiveTask, taskResultTarget, type TaskWireRow } from '../lib/task-view'

/**
 * The chip tone per status — a `Record`, so a status added to the tuple has to
 * be given a colour before this compiles.
 *
 * `interrupted` is a warning and not an error on purpose: the run was stopped,
 * which is a thing a person did or a budget did, and painting it red would put
 * it beside the failures a person has to look into. Colour is the loudest thing
 * on a card, and a surface that shouts at four states has no way left to shout
 * at the one that matters.
 *
 * `skipped` is muted for the same reason at a lower volume: the fire never
 * reached the agent (an org cap, a switched-off feature), so there is nothing
 * broken to look into. `error` IS destructive — the submission broke.
 */
const STATUS_TONE: Record<TaskRunStatus, 'muted' | 'info' | 'success' | 'destructive' | 'warning'> = {
  queued: 'muted',
  running: 'info',
  succeeded: 'success',
  failed: 'destructive',
  interrupted: 'warning',
  skipped: 'muted',
  error: 'destructive',
}

/**
 * THE STATUS SWATCH — the same 10px rounded square the timetable uses.
 *
 * Status needs an anchor the eye can find without reading, because the question
 * a column of these answers is "which one went wrong". Two shapes were tried
 * for it and both were wrong in the same way, by making the STATUS the loudest
 * thing on the card instead of the title:
 *
 *   - a coloured rail down the left edge, which is a third material on a card
 *     whose whole anatomy is two (a white sheet laid into a tray) and reads as
 *     a kanban leftover stuck to it;
 *   - a tint across the whole sheet, which shouts — a red card is a red card
 *     even when the failure it names is four days old and already understood.
 *
 * A swatch is the quiet version of the same signal, and it is the shape this
 * product already uses to mean "this colour stands for this row": the schedule
 * cards and the timetable legend pair a 10px rounded square with a name for
 * exactly that reason. Reusing it costs nothing to learn.
 *
 * Colour is never the only carrier — the chip below the title states the status
 * in words, always.
 *
 * Written out rather than composed as `bg-${tone}` because Tailwind scans
 * source for whole class names; an interpolated one is not in the stylesheet
 * and the swatch silently disappears.
 */
const STATUS_SWATCH: Record<TaskRunStatus, string> = {
  queued: 'bg-border',
  running: 'bg-info',
  succeeded: 'bg-success',
  failed: 'bg-danger',
  interrupted: 'bg-warning',
  // A fire that never reached the agent is not "nothing happened" — it is an
  // attempt that broke, and it wears the failure colour because it is one.
  skipped: 'bg-border',
  error: 'bg-danger',
}

const REVIEW_ICON: Record<'accepted' | 'rejected', LucideIcon> = {
  accepted: CheckCircle2,
  rejected: XCircle,
}

/**
 * One icon per place a result can live, so the affordance is recognisable.
 *
 * Two, since a run's report and its thinking stopped being places of their own:
 * both were the side panel behind `?job=`, and both are now the run's message
 * in its thread (ADR-0062), which is the conversation.
 */
const RESULT_ICON: Record<'document' | 'conversation', LucideIcon> = {
  document: FileText,
  conversation: MessageSquare,
}

export interface TaskCardProps {
  projectId: string
  task: TaskWireRow
  onSelect: (task: TaskWireRow) => void
}

export function TaskCard({ projectId, task, onSelect }: TaskCardProps): JSX.Element {
  const t = useTranslations('tasks')
  const { locale } = useLocale()
  const ReviewIcon = task.review ? REVIEW_ICON[task.review] : null
  const result = taskResultTarget(projectId, task)
  const ResultIcon = result ? RESULT_ICON[result.kind] : null
  const active = isActiveTask(task)
  /**
   * Finished, and nobody has judged it. The one open loop this surface owns,
   * so it is marked on the CARD and not only behind the filter: a dot a reader
   * can see from across the list is what makes the loop closable.
   */
  const unreviewed = task.status === 'succeeded' && task.review === null

  const open = (): void => onSelect(task)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    open()
  }
  // The result link is a destination of its own inside a card that is also a
  // target. Without this, following it would open the drawer behind it too.
  const stop = (event: MouseEvent): void => event.stopPropagation()

  return (
    <RaisedCard interactive>
      <div
        role="button"
        data-testid="task-card"
        tabIndex={0}
        onClick={open}
        onKeyDown={onKeyDown}
        aria-label={t('card.openAria', { title: task.title })}
        className="focus-visible:ring-ring/60 flex h-full min-w-0 flex-col rounded-lg outline-none focus-visible:ring-2"
      >
        <RaisedCardBody className="flex flex-1 flex-col gap-2">
          <div className="flex min-w-0 flex-1 gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex min-w-0 items-start gap-2">
                <span
                  aria-hidden
                  data-testid="task-card-swatch"
                  className={cn(
                    // `mt-1` drops it onto the title's cap height rather than
                    // its line box, so the swatch sits ON the word instead of
                    // floating above it.
                    'mt-1 size-2.5 shrink-0 rounded-[3px]',
                    STATUS_SWATCH[task.status],
                  )}
                />
                <h3 className="text-foreground min-w-0 flex-1 text-sm font-semibold leading-snug">
                  {task.title}
                </h3>
                {unreviewed && (
                  <span
                    className="bg-primary mt-1.5 size-2 shrink-0 rounded-full"
                    title={t('card.unreviewed')}
                    data-testid="task-card-unreviewed"
                  >
                    <span className="sr-only">{t('card.unreviewed')}</span>
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {/* The status chip yields to the run line when there is one.
                    Both say the state, in two different sets of words —
                    `succeeded` beside „Fertig" — and two adjacent labels for
                    one fact stop reading as one fact. The line wins because it
                    is the shared organism the thread also composes; the chip is
                    this card's private vocabulary. It stays for a row with no
                    run, where the swatch would otherwise be the ONLY carrier
                    of the status and colour never travels alone. */}
                {!task.runSummary && (
                  <Chip size="sm" variant={STATUS_TONE[task.status]} data-testid="task-status">
                    {active ? <Spinner size="sm" aria-hidden /> : <CircleDot aria-hidden />}
                    {t(`status.${task.status}`)}
                  </Chip>
                )}
                <Chip size="sm" variant="outline" data-testid="task-kind">
                  {t(`kind.${task.kind}`)}
                </Chip>
                {ReviewIcon && task.review && (
                  <Chip
                    size="sm"
                    variant={task.review === 'accepted' ? 'success' : 'destructive'}
                    data-testid="task-review"
                  >
                    <ReviewIcon aria-hidden />
                    {t(`review.${task.review}`)}
                  </Chip>
                )}
              </div>

              {/* The run, as the block's header reduced to one line: the same
                  glyph, the same status word and the same tallies the thread
                  shows, off the run's ledger (ADR-0062), so the index row and
                  the block cannot disagree about the run they both describe.
                  Without the title (the heading above IS the title) and
                  without the trailing link (the card IS the link: it opens the
                  drawer, which renders the whole block); a finished row dates
                  the line by when it finished. Compact — the card is about the
                  task, and the block is where the run is read. */}
              {task.runSummary && (
                <RunBlockLine
                  ledger={null}
                  status={task.runSummary.status}
                  tallies={task.runSummary}
                  at={active ? undefined : (task.finishedAt ?? undefined)}
                  className="min-h-0 text-xs"
                />
              )}

              {/* The requester's own sentence, clamped: in a column of cards an
                  unclamped goal sets the height of the whole list. A scheduled
                  run has none — its title IS the schedule's name — and an empty
                  line is better than the compiled prompt. */}
              {task.goal && (
                <p className="text-muted-foreground line-clamp-2 text-sm leading-relaxed">
                  {task.goal}
                </p>
              )}

              {/* What a reviewer said when they sent it back. The words are
                  theirs and are never paraphrased: the next run reads exactly
                  this string. */}
              {task.review === 'rejected' && task.reviewReason && (
                <p
                  className="text-muted-foreground line-clamp-2 text-sm leading-relaxed"
                  data-testid="task-review-reason"
                >
                  {task.reviewReason}
                </p>
              )}

              {/* The sanitized reason on a failure. `error` is a submission that
                  never reached the agent, `failed` one that did and came back
                  broken; both owe the reader the why. */}
              {(task.status === 'failed' || task.status === 'error') && task.error && (
                <p className="text-error line-clamp-2 text-sm leading-relaxed" data-testid="task-error">
                  {task.error}
                </p>
              )}
            </div>
          </div>
        </RaisedCardBody>

        {/* The tray beneath the sheet: who asked, when, and the one way to the
            result. Quiet, temporal, secondary — the same role `size · time`
            plays on a file card. No divider: the surface change IS the
            separation. */}
        <RaisedCardFooter>
          <span
            className="min-w-0 truncate"
            title={formatAbsoluteTime(task.createdAt, locale)}
          >
            {task.requesterName
              ? t('meta.byOn', {
                  name: task.requesterName,
                  when: formatRelativeTime(task.createdAt, locale),
                })
              : t('meta.on', { when: formatRelativeTime(task.createdAt, locale) })}
          </span>
          {result && ResultIcon && (
            <Link
              href={result.href}
              onClick={stop}
              className="text-primary ml-auto inline-flex shrink-0 items-center gap-1 font-medium hover:underline"
              data-testid="task-card-result"
            >
              <ResultIcon aria-hidden className="size-3.5" />
              {t(`result.${result.kind}`)}
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          )}
        </RaisedCardFooter>
      </div>
    </RaisedCard>
  )
}
