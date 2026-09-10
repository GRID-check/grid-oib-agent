'use client'

/**
 * The project's delegated work, newest first (ADR-0051).
 *
 * ## Why this exists at all
 *
 * `tasks` was built as the durable unit of delegated work and given a read
 * route, an inbox item and a review verb — and no listing. A person could
 * delegate work from a chat („@Piloti prüf das bis Freitag"), get an inbox row
 * when it finished, and then have no place to ask what else was running, what
 * a reviewer had said, or where the result went. ADR-0051 deferred the surface;
 * a deferred surface for a durable row is a row nobody can see.
 *
 * ## What one row says, and what it deliberately does not
 *
 * Five facts: what kind of work it is, what was asked for, where it got to,
 * how a person judged it, and where the result is. The PROMPT is not among
 * them — it carries a skill's whole body, it is not what anybody scanning a
 * list needs, and the wire projection does not send it. The run's output lives
 * in the document or the conversation the row links to, which is the point of
 * linking there rather than restating it here.
 *
 * Read-only. Reviewing a task is `POST …/tasks/[id]/review` in the inbox, where
 * the person was told about it; a second place to press Annehmen would be a
 * second decision surface for one decision.
 */

import { CheckCircle2, CircleDashed, FileText, MessageSquare, XCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useLocale, useTranslations } from '@/i18n'
import { formatRelativeTime } from '@/lib/format'
import type { TaskStatus } from '@/lib/tasks/task-vocabulary'
import type { TaskWireRow } from '../lib/task-view'

/**
 * The chip tone per status — a `Record`, so a status added to the tuple has to
 * be given a colour before this compiles.
 *
 * `interrupted` is a warning and not an error on purpose: the run was stopped,
 * which is a thing a person did or a budget did, and painting it red would put
 * it beside the failures a person has to look into.
 */
const STATUS_TONE: Record<TaskStatus, 'muted' | 'info' | 'success' | 'destructive' | 'warning'> = {
  queued: 'muted',
  running: 'info',
  succeeded: 'success',
  failed: 'destructive',
  interrupted: 'warning',
}

const REVIEW_ICON: Record<'accepted' | 'rejected', LucideIcon> = {
  accepted: CheckCircle2,
  rejected: XCircle,
}

export interface TaskListProps {
  tasks: readonly TaskWireRow[]
  loading?: boolean
  failed?: boolean
}

export function TaskList({ tasks, loading, failed }: TaskListProps): JSX.Element {
  const t = useTranslations('tasks')
  const { locale } = useLocale()

  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-4 md:p-6" data-testid="task-list-loading">
        {[0, 1, 2].map((row) => (
          <div key={row} className="rounded-lg border p-3">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="mt-2 h-3.5 w-full" />
          </div>
        ))}
      </div>
    )
  }

  if (failed) {
    return (
      <div className="p-4 md:p-6">
        <EmptyState
          icon={CircleDashed}
          tone="destructive"
          title={t('list.errorTitle')}
          description={t('list.errorDescription')}
        />
      </div>
    )
  }

  if (tasks.length === 0) {
    return (
      <div className="p-4 md:p-6">
        <EmptyState
          icon={CircleDashed}
          title={t('list.emptyTitle')}
          description={t('list.emptyDescription')}
        />
      </div>
    )
  }

  return (
    <ul className="flex flex-col gap-2 p-4 md:p-6" data-testid="task-list">
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} t={t} locale={locale} />
      ))}
    </ul>
  )
}

function TaskRow({
  task,
  t,
  locale,
}: {
  task: TaskWireRow
  t: (key: string, values?: Record<string, string | number>) => string
  locale: string
}): JSX.Element {
  const requester = task.requesterName
  const ReviewIcon = task.review ? REVIEW_ICON[task.review] : null

  return (
    <li className="rounded-lg border p-3" data-testid="task-row">
      <div className="flex flex-wrap items-center gap-2">
        <Chip size="sm" variant="outline" data-testid="task-kind">
          {t(`kind.${task.kind}`)}
        </Chip>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={task.title}>
          {task.title}
        </span>
        <Chip size="sm" variant={STATUS_TONE[task.status]} data-testid="task-status">
          {t(`status.${task.status}`)}
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

      {/* The requester's own sentence. A job-fired run has none — its title IS
          the job's name — and an empty line is better than the prompt. */}
      {task.goal && <p className="card-caption mt-1.5 text-muted-foreground">{task.goal}</p>}

      {/* What a reviewer said when they sent it back. The words are theirs and
          are never paraphrased: the next run reads exactly this string. */}
      {task.review === 'rejected' && task.reviewReason && (
        <p className="card-caption mt-1.5 text-muted-foreground" data-testid="task-review-reason">
          {task.reviewReason}
        </p>
      )}

      {task.status === 'failed' && task.error && (
        <p className="card-caption mt-1.5 text-error" data-testid="task-error">
          {task.error}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="card-caption text-muted-foreground">
          {requester
            ? t('meta.byOn', { name: requester, when: formatRelativeTime(task.createdAt, locale) })
            : t('meta.on', { when: formatRelativeTime(task.createdAt, locale) })}
        </span>
        {/* Where the result IS. The one thing a list of finished work has to
            answer, and the reason the row does not try to summarise it. */}
        {task.filedDocumentId && (
          <a
            className="card-caption text-primary inline-flex items-center gap-1 hover:underline"
            href={`/documents/${task.filedDocumentId}`}
            data-testid="task-document-link"
          >
            <FileText aria-hidden className="size-3.5" />
            {t('meta.document')}
          </a>
        )}
        {task.conversationId && (
          <a
            className="card-caption text-primary inline-flex items-center gap-1 hover:underline"
            href={`/chat/${task.conversationId}`}
            data-testid="task-conversation-link"
          >
            <MessageSquare aria-hidden className="size-3.5" />
            {t('meta.conversation')}
          </a>
        )}
      </div>
    </li>
  )
}
