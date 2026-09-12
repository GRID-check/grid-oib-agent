'use client'

/**
 * One Aufgabe in detail, as a drawer over the list.
 *
 * Two shapes, like the list: an INSTANCE shows where its single run got to and
 * where its result IS (the filed document first, the conversation to continue
 * second), a TEMPLATE shows its schedule, the frozen prompt it fires, and the
 * run history with a retry-with-the-same-plan. The history is the existing
 * `JobRunHistory`, moved here and not rewritten: the drawer is a new home, not
 * a new history.
 *
 * The drawer holds no copy of its own — the panel resolves the selection
 * against the live lists on every render, so a poll landing while the drawer
 * is open moves the drawer, and a row deleted elsewhere reads as gone rather
 * than as a stale snapshot.
 */

import { useState } from 'react'
import { FileText, MessageSquare, Play, Sparkles } from 'lucide-react'

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
import { runJob, JobApiError, type Job } from '@/adapters/api/jobs-client'
import { JobRunHistory } from '@/features/jobs/components/job-run-history'
import { scheduleSummary } from '@/features/jobs/components/job-list'
import { ScheduleEnableSwitch } from './task-list'
import type { TaskWireRow } from '../lib/task-view'
import { toast } from 'sonner'

export type TaskSelection = { kind: 'task'; id: string } | { kind: 'job'; id: string }

interface TaskDetailProps {
  projectId: string
  projectCollection: string | null
  selection: TaskSelection | null
  /** Resolved live by the caller — null when the row is gone. */
  task: TaskWireRow | null
  job: Job | null
  /** Whether this member may pause/resume/retry schedules (`project:skills:manage`). */
  canManageJobs: boolean
  onJobChanged?: (job: Job) => void
  onClose: () => void
}

type Translate = ReturnType<typeof useTranslations>

export function TaskDetail({
  projectId,
  projectCollection,
  selection,
  task,
  job,
  canManageJobs,
  onJobChanged,
  onClose,
}: TaskDetailProps): JSX.Element {
  const t = useTranslations('tasks')

  return (
    <Sheet open={selection !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        closeLabel={t('detail.close')}
        data-testid="task-detail"
        className="flex flex-col"
      >
        {!selection || (selection.kind === 'task' ? !task : !job) ? (
          <div className="py-8">
            <SheetHeader>
              <SheetTitle>{t('detail.close')}</SheetTitle>
            </SheetHeader>
            <p className="text-muted-foreground mt-2 text-sm">{t('detail.gone')}</p>
          </div>
        ) : selection.kind === 'task' && task ? (
          <InstanceDetail projectId={projectId} task={task} t={t} />
        ) : job ? (
          <TemplateDetail
            projectId={projectId}
            projectCollection={projectCollection}
            job={job}
            canManageJobs={canManageJobs}
            onJobChanged={onJobChanged}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

/** Where one run got to, and where its result IS. */
function InstanceDetail({
  projectId,
  task,
  t,
}: {
  projectId: string
  task: TaskWireRow
  t: Translate
}): JSX.Element {
  const { locale } = useLocale()
  // Canonical homes, not history: the filed result lives in the project's
  // files, a chat run is continued in the project's chat.
  const documentHref = task.filedDocumentId
    ? `/app/projects/${encodeURIComponent(projectId)}/files?doc=${encodeURIComponent(task.filedDocumentId)}`
    : null
  const conversationHref = task.conversationId
    ? `/app/projects/${encodeURIComponent(projectId)}/chat?session=${encodeURIComponent(task.conversationId)}`
    : null

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

      {(documentHref || conversationHref) && (
        <section aria-label={t('detail.result')}>
          <SectionLabel as="h2">{t('detail.result')}</SectionLabel>
          <div className="mt-2 flex flex-col items-start gap-2">
            {documentHref && (
              <Button asChild size="sm" data-testid="task-detail-result-doc">
                <a href={documentHref}>
                  <FileText aria-hidden />
                  {t('detail.openDocument')}
                </a>
              </Button>
            )}
            {conversationHref && (
              <Button asChild size="sm" variant="outline" data-testid="task-detail-continue-chat">
                <a href={conversationHref}>
                  <MessageSquare aria-hidden />
                  {t('detail.continueChat')}
                </a>
              </Button>
            )}
          </div>
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
        <p className="text-muted-foreground text-sm leading-relaxed" data-testid="task-detail-review-reason">
          {task.reviewReason}
        </p>
      )}

      {task.status === 'failed' && task.error && (
        <p className="text-error text-sm leading-relaxed" data-testid="task-detail-error">
          {task.error}
        </p>
      )}

      <p className="card-caption text-muted-foreground mt-auto">
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

/** The schedule, the prompt it fires, and every run it made. */
function TemplateDetail({
  projectId,
  projectCollection,
  job,
  canManageJobs,
  onJobChanged,
}: {
  projectId: string
  projectCollection: string | null
  job: Job
  canManageJobs: boolean
  onJobChanged: ((job: Job) => void) | undefined
}): JSX.Element {
  const t = useTranslations('tasks')
  const tj = useTranslations('jobs')
  const { locale } = useLocale()
  const [running, setRunning] = useState(false)
  // Remounts the run history so a just-started run shows up immediately.
  const [historyToken, setHistoryToken] = useState(0)

  const runNow = async () => {
    setRunning(true)
    try {
      const result = await runJob(projectId, job.id)
      if (result.status === 'submitted') {
        // Retry with the same plan: the schedule, prompt and skill are
        // untouched, only a new run is fired — it appears in the history below.
        toast.success(tj('run.submitted'), { description: tj('run.submittedDetail') })
        setHistoryToken((token) => token + 1)
        onJobChanged?.({ ...job, lastRunAt: new Date().toISOString() })
      } else if (result.status === 'skipped') {
        toast.warning(tj('run.skipped'), { description: result.detail ?? undefined })
      } else {
        toast.error(tj('run.error'), { description: result.detail ?? undefined })
      }
    } catch (err) {
      if (err instanceof JobApiError && err.status === 409) {
        toast.error(tj('run.disabled'))
      } else {
        toast.error(tj('run.error'))
      }
    } finally {
      setRunning(false)
    }
  }

  const nextRun = job.nextRunAt
    ? tj('list.nextRun', { time: formatRelativeTime(job.nextRunAt, locale) })
    : null
  const lastRun = job.lastRunAt
    ? tj('list.lastRun', { time: formatRelativeTime(job.lastRunAt, locale) })
    : tj('list.neverRun')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto py-2 pr-1">
      <SheetHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm" variant="outline">
            {tj(`list.output.${job.output}`)}
          </Chip>
          {!job.enabled && <Chip size="sm" variant="outline">{tj('list.disabled')}</Chip>}
        </div>
        <SheetTitle className="mt-2 text-left">{job.name}</SheetTitle>
        <SheetDescription className="text-left" data-testid="task-detail-schedule">
          {job.scheduleCron
            ? scheduleSummary(tj, job.scheduleCron, job.scheduleTimezone)
            : tj('list.manualOnly')}
          {' · '}
          {nextRun ?? lastRun}
        </SheetDescription>
      </SheetHeader>

      <section aria-label={t('detail.schedule')}>
        <SectionLabel as="h2">{t('detail.schedule')}</SectionLabel>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span
            className="text-muted-foreground text-xs"
            title={
              job.nextRunAt
                ? formatAbsoluteTime(job.nextRunAt, locale)
                : job.lastRunAt
                  ? formatAbsoluteTime(job.lastRunAt, locale)
                  : undefined
            }
          >
            {nextRun ? `${nextRun} · ${lastRun}` : lastRun}
          </span>
          {canManageJobs && <ScheduleEnableSwitch job={job} onChanged={onJobChanged} tj={tj} />}
        </div>
        <p className="text-muted-foreground mt-2 flex min-w-0 items-center gap-1.5 text-xs">
          <Sparkles className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {job.skillName ? tj('list.withSkill', { name: job.skillName }) : tj('list.noSkill')}
          </span>
        </p>
      </section>

      <section aria-label={t('detail.prompt')}>
        <SectionLabel as="h2">{t('detail.prompt')}</SectionLabel>
        <p
          className="bg-muted mt-2 whitespace-pre-wrap rounded-lg p-3 font-mono text-xs leading-relaxed"
          data-testid="task-detail-prompt"
        >
          {job.prompt}
        </p>
      </section>

      <section aria-label={t('detail.runs')}>
        <div className="flex items-center justify-between gap-2">
          <SectionLabel as="h2">{t('detail.runs')}</SectionLabel>
          {canManageJobs && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runNow()}
              disabled={running || !job.enabled}
              aria-busy={running}
              data-testid="task-detail-run-now"
            >
              {running ? (
                <Spinner size="sm" aria-hidden />
              ) : (
                <Play className="size-3.5" aria-hidden />
              )}
              {tj('actions.runNow')}
            </Button>
          )}
        </div>
        <div className="mt-2" data-testid="task-detail-runs">
          <JobRunHistory
            key={historyToken}
            projectId={projectId}
            projectCollection={projectCollection}
            jobId={job.id}
          />
        </div>
      </section>
    </div>
  )
}
