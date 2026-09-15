'use client'

/**
 * One task in detail, as a drawer over the list.
 *
 * It holds no copy of its own — the panel resolves the selection against the
 * live list on every render, so a poll landing while the drawer is open moves
 * the drawer, and a row deleted elsewhere reads as gone rather than as a stale
 * snapshot.
 *
 * Two affordances, in this order and no others:
 *
 *   1. **The result.** One primary button to the one place the result lives
 *      (`taskResultTarget` decides which). This is what the reader opened the
 *      drawer for, so it is the first thing under the title and the only
 *      primary-weight control on the surface.
 *   2. **„Als Zeitplan speichern".** The moment a person has just read a result
 *      they liked is the moment they are most willing to commit to getting it
 *      every week — and it used to cost them a walk to another tab and a
 *      retyped prompt. Offered only on work that is not already on a schedule:
 *      on a scheduled run it would propose duplicating the thing that produced
 *      it.
 *
 * The template half of this drawer moved to `features/jobs/schedule-detail`
 * with the schedules themselves.
 */

import Link from 'next/link'
import { ArrowRight, CalendarPlus, FileText, MessageSquare, ScrollText } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { SectionLabel } from '@/components/ui/section-label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import type { ScheduleDraft } from '@/features/jobs/lib/schedule-draft'
import { taskResultTarget, type TaskWireRow } from '../lib/task-view'

const RESULT_ICON: Record<'document' | 'conversation' | 'report' | 'thinking', LucideIcon> = {
  document: FileText,
  conversation: MessageSquare,
  report: ScrollText,
  thinking: ScrollText,
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
  /** Whether this member may create schedules (`project:skills:manage`). */
  canManageJobs: boolean
  /** Hands a pre-filled schedule to the Zeitplan tab. Omit to hide the action. */
  onPromoteToSchedule?: (draft: ScheduleDraft) => void
  onClose: () => void
}

export function TaskDetail({
  projectId,
  task,
  open,
  goneReason = 'deleted',
  resolving = false,
  canManageJobs,
  onPromoteToSchedule,
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
            onPromoteToSchedule={onPromoteToSchedule}
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
  onPromoteToSchedule,
}: {
  projectId: string
  task: TaskWireRow
  canManageJobs: boolean
  onPromoteToSchedule: ((draft: ScheduleDraft) => void) | undefined
}): JSX.Element {
  const t = useTranslations('tasks')
  const { locale } = useLocale()
  const result = taskResultTarget(projectId, task)
  const ResultIcon = result ? RESULT_ICON[result.kind] : null
  // Only work a person WROTE, and only work that is not already recurring.
  // A scheduled run's prompt is the schedule's, and promoting it would offer
  // to duplicate the schedule that fired it.
  const promotable =
    canManageJobs && onPromoteToSchedule && task.trigger !== 'schedule' && Boolean(task.goal)

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
        <SheetTitle className="mt-2 text-left">{task.title}</SheetTitle>
        <SheetDescription className="text-left">
          {t(`status.${task.status}`)}
          {task.review ? ` · ${t(`review.${task.review}`)}` : ''}
        </SheetDescription>
      </SheetHeader>

      {(result || promotable) && (
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
            {promotable && (
              <Button
                variant="outline"
                onClick={() =>
                  onPromoteToSchedule?.({ name: task.title, prompt: task.goal ?? '' })
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
