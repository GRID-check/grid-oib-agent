'use client'

/**
 * One task in detail, as a drawer over the list.
 *
 * It holds no copy of the ROW — the panel resolves the selection against the
 * live list on every render, so a poll landing while the drawer is open moves
 * the drawer, and a row deleted elsewhere reads as gone rather than as a stale
 * snapshot.
 *
 * ## The body is the run block, not a second description of the run
 *
 * The question a person asks by clicking a row in Aufträge is „what did this
 * actually do, and is it worth opening" — which is the run block's whole job
 * and nothing else's. So the drawer FETCHES the run (`useTaskRun`) and renders
 * `RunBlock`: the same phases, rounds, documents and status line the thread
 * shows, off the same ledger.
 *
 * It used to restate the card instead — a kind chip, a status chip, the goal,
 * the review reason and the error, all of which the card the reader had just
 * clicked already showed, in a second grammar assembled from `SheetTitle` and
 * `SectionLabel`. That is the lookalike `frontends/ui/AGENTS.md` forbids
 * („show something a surface already shows → reuse the organism"), and it made
 * the bigger, more deliberate surface say strictly LESS about the run than the
 * row that opened it: the card at least carried the run line.
 *
 * What survives around the block, in this order:
 *
 *   1. **The result.** One primary button to the one place the result lives
 *      (`taskResultTarget` decides which). This is what the reader opened the
 *      drawer for, so it is the first thing under the block.
 *   2. **„Im Verlauf öffnen".** The drawer reads a run; the thread is where a
 *      live one is followed and where a `wartet` question is answered. The
 *      drawer must never become the only door to it.
 *   3. **„Als Zeitplan speichern".** The moment a person has just read a result
 *      they liked is the moment they are most willing to commit to getting it
 *      every week — and it used to cost them a walk to another tab and a
 *      retyped prompt. Offered only on work that is not already on a schedule:
 *      on a scheduled run it would propose duplicating the thing that produced
 *      it.
 *
 * The goal, the review reason and the error are NOT repeated here: the block's
 * title carries the ask, its status line carries the failure, and its review
 * quote carries the reviewer's words. A task with no ledger at all — a run from
 * before run messages existed — falls back to exactly those paragraphs, because
 * then they are the only account there is.
 *
 * The template half of this drawer moved to `features/jobs/schedule-detail`
 * with the schedules themselves.
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { ArrowRight, CalendarPlus, FileText, MessageSquare, MessagesSquare } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { SectionLabel } from '@/components/ui/section-label'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import type { ScheduleDraft } from '@/features/jobs/lib/schedule-draft'
import { RunBlock } from '@/features/runs/components/RunBlock'
import { useTaskRun } from '../hooks/use-task-run'
import { isActiveTask, taskResultTarget, taskThreadHref, type TaskWireRow } from '../lib/task-view'

/**
 * One icon per place a result can live. Two of them, because a run's report and
 * its thinking are no longer destinations of their own: both lived behind
 * `?job=` in the side panel, and both are the run's own message in its thread
 * now (ADR-0062) — which the block above this button already renders.
 */
const RESULT_ICON: Record<'document' | 'conversation', LucideIcon> = {
  document: FileText,
  conversation: MessageSquare,
}

interface TaskDetailProps {
  projectId: string
  /** The task the drawer is showing, or null when it is shut. */
  task: TaskWireRow | null
  /** True while the drawer is open — a selection may be open and unresolved. */
  open: boolean
  /**
   * Why the selection resolves to nothing. `deleted` is a row the drawer saw
   * and that left. `unresolved` is a deep link that never matched a row in this
   * project: the drawer cannot say it left, only that it is not here.
   */
  goneReason?: 'deleted' | 'unresolved'
  /**
   * The deep link has not been checked against a loaded list yet. Neither gone
   * claim is earned while the first load is pending, so the drawer waits
   * instead of flashing "not found" at a row that is still arriving.
   */
  resolving?: boolean
  /** Whether this member may create standing tasks (`project:skills:manage`). */
  canManageJobs: boolean
  /** Hands a pre-filled draft to the task wizard. Omit to hide the action. */
  onPromoteToTask?: (draft: ScheduleDraft) => void
  onClose: () => void
}

export function TaskDetail({
  projectId,
  task,
  open,
  goneReason = 'deleted',
  resolving = false,
  canManageJobs,
  onPromoteToTask,
  onClose,
}: TaskDetailProps): JSX.Element {
  const t = useTranslations('tasks')
  const tCommon = useTranslations('common')

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        closeLabel={t('detail.close')}
        data-testid="task-detail"
        className="flex flex-col"
      >
        {task ? (
          <TaskDetailBody
            projectId={projectId}
            task={task}
            canManageJobs={canManageJobs}
            onPromoteToTask={onPromoteToTask}
          />
        ) : (
          <div className="py-8">
            <SheetHeader>
              {/* While the deep link is still being checked, the heading says
                  so: „Nicht gefunden" over a pending read is a finding before
                  there is anything to find. */}
              <SheetTitle>{resolving ? t('detail.loadingTitle') : t('detail.goneTitle')}</SheetTitle>
            </SheetHeader>
            {resolving ? (
              <p className="text-muted-foreground mt-2 flex items-center gap-2 text-sm">
                <Spinner size="sm" aria-hidden />
                {tCommon('states.loading')}
              </p>
            ) : (
              <p className="text-muted-foreground mt-2 text-sm">
                {goneReason === 'unresolved' ? t('detail.goneUnresolved') : t('detail.gone')}
              </p>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function TaskDetailBody({
  projectId,
  task,
  canManageJobs,
  onPromoteToTask,
}: {
  projectId: string
  task: TaskWireRow
  canManageJobs: boolean
  onPromoteToTask: ((draft: ScheduleDraft) => void) | undefined
}): JSX.Element {
  const t = useTranslations('tasks')
  const { locale } = useLocale()
  const result = taskResultTarget(projectId, task)
  const ResultIcon = result ? RESULT_ICON[result.kind] : null
  const threadHref = taskThreadHref(projectId, task)
  // Only work a person WROTE, and only work that is not already recurring.
  // A scheduled run's prompt is the schedule's, and promoting it would offer
  // to duplicate the schedule that fired it.
  const promotable =
    canManageJobs && onPromoteToTask && task.trigger !== 'schedule' && Boolean(task.goal)
  // Re-read when the panel's poll has moved this row, and never otherwise. A
  // finished run cannot move, so its revision is constant and the drawer reads
  // it once however long it stays open.
  const revision = isActiveTask(task)
    ? `${task.status}:${task.runSummary?.status ?? ''}:${task.runSummary?.rounds ?? 0}`
    : 'settled'
  const { ledger, loading, failed } = useTaskRun({
    projectId,
    runId: task.runMessageId ? task.id : null,
    revision,
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto py-2 pr-1">
      <SheetHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm" variant="outline">
            {t(`kind.${task.kind}`)}
          </Chip>
          <Chip size="sm" variant="secondary">
            {t('cadence.once')}
          </Chip>
        </div>
        {/* The title is here AND inside the block, which is not a repetition
            worth removing: the sheet needs an accessible name, and the block's
            own header is the block's header. Visually hidden for that reason —
            the block states it where the reader is looking. */}
        <SheetTitle className="sr-only">{task.title}</SheetTitle>
      </SheetHeader>

      {/* The account of the work. `defaultOpen` because the drawer IS the act
          of asking for it: a reader who clicked the row has already said they
          want more than the line the card gave them. */}
      {ledger ? (
        <RunBlock
          ledger={ledger}
          title={task.title}
          // No `projectId`, which is what enables the block's own „Im Projekt
          // anzeigen". The drawer's primary button is already that door, and
          // two controls opening one document is the duplication this rewrite
          // came to remove. In a thread the block has no result button beside
          // it and keeps the link; here it yields.
          projectId={null}
          // The drawer body is the scroller, so the block keeps its own
          // height: as a shrinkable flex child it gets squeezed by whatever
          // sits below it and clips its last round against `overflow-hidden`.
          className="shrink-0"
          defaultOpen
          review={
            task.review
              ? { decision: task.review, reason: task.reviewReason }
              : null
          }
        />
      ) : loading ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" data-testid="task-detail-run-loading">
          <Spinner size="sm" aria-hidden />
          {t('detail.runLoading')}
        </p>
      ) : (
        <TaskDetailFallback task={task} failed={failed} />
      )}

      {(result || threadHref || promotable) && (
        <section aria-label={t('detail.result')}>
          <SectionLabel as="h2">{t('detail.result')}</SectionLabel>
          <div className="mt-2 flex flex-col items-stretch gap-2">
            {result && ResultIcon && (
              <Button asChild data-testid="task-detail-result">
                <Link href={result.href}>
                  <ResultIcon aria-hidden />
                  {t(`result.${result.kind}`)}
                  <ArrowRight aria-hidden className="ml-auto size-4" />
                </Link>
              </Button>
            )}
            {/* Never folded into the result button. The thread is where a live
                run is watched and where a run that asked a question is
                answered — the drawer reads, it does not follow. Offered even
                when the result IS the conversation: then the two links point
                at the same place and the second one is dropped. */}
            {threadHref && result?.kind !== 'conversation' && (
              <Button variant="outline" asChild data-testid="task-detail-thread">
                <Link href={threadHref}>
                  <MessagesSquare aria-hidden />
                  {t('detail.openThread')}
                  <ArrowRight aria-hidden className="ml-auto size-4" />
                </Link>
              </Button>
            )}
            {promotable && (
              <Button
                variant="outline"
                onClick={() =>
                  onPromoteToTask?.({ name: task.title, prompt: task.goal ?? '' })
                }
                data-testid="task-detail-promote"
              >
                <CalendarPlus aria-hidden />
                {t('detail.promote')}
              </Button>
            )}
          </div>
          {promotable && (
            <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {t('detail.promoteHint')}
            </p>
          )}
        </section>
      )}

      <p
        className="card-caption text-muted-foreground mt-auto"
        title={formatAbsoluteTime(task.createdAt, locale)}
      >
        {task.requesterName
          ? t('meta.byOn', {
              name: task.requesterName,
              when: formatRelativeTime(task.createdAt, locale),
            })
          : t('meta.on', { when: formatRelativeTime(task.createdAt, locale) })}
      </p>
    </div>
  )
}

/**
 * What the drawer says when there is no block to show.
 *
 * Two different silences, said differently. A run from before run messages
 * existed HAS no account — the drawer falls back to the facts the row carries,
 * which is exactly what the old drawer always showed and is the right answer
 * for a legacy row. A read that was refused has an account the reader simply
 * could not be given, and saying „Auftrag" over the goal would quietly imply
 * that is all there ever was.
 */
function TaskDetailFallback({ task, failed }: { task: TaskWireRow; failed: boolean }): JSX.Element {
  const t = useTranslations('tasks')

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm" data-testid="task-detail-status">
        {t(`status.${task.status}`)}
        {task.review ? ` · ${t(`review.${task.review}`)}` : ''}
      </p>

      {failed && (
        <p className="text-muted-foreground text-sm leading-relaxed" data-testid="task-detail-run-failed">
          {t('detail.runUnavailable')}
        </p>
      )}

      {task.goal && (
        <section aria-label={t('detail.request')}>
          <SectionLabel as="h2">{t('detail.request')}</SectionLabel>
          <p className="mt-2 text-sm leading-relaxed" data-testid="task-detail-goal">
            {task.goal}
          </p>
        </section>
      )}

      {task.review === 'rejected' && task.reviewReason && (
        <p
          className="text-muted-foreground text-sm leading-relaxed"
          data-testid="task-detail-review-reason"
        >
          {task.reviewReason}
        </p>
      )}

      {(task.status === 'failed' || task.status === 'error') && task.error && (
        <p className="text-error text-sm leading-relaxed" data-testid="task-detail-error">
          {task.error}
        </p>
      )}
    </div>
  )
}
