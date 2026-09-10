'use client'

/**
 * TaskCreatedCard — work Piloti has taken on, as something a reader can go back to.
 *
 * System-emitted: `create_task` (`aiq_agent/tools/tasks/register.py`) pushes it
 * once the BFF has written the row, the same way the working directory pushes
 * `document_draft`. The model cannot fabricate one — which is the whole point,
 * because the sentence this card exists beside is „ich mache den Einreichcheck
 * bis Freitag", and until there was a row that sentence was a promise nothing
 * kept.
 *
 * ## Why it offers nothing
 *
 * The task is queued by the time this renders. An Accept would repeat the
 * delegation; a Cancel is a decision about work in flight and belongs where the
 * work is listed, not in the middle of a thread the reader is still reading. So
 * it is `presentational` (`CARD_INTERACTIVITY`) and its one control is a LINK to
 * the conversation the run writes into — a real `<a>`, so middle-click and „copy
 * link address" work, exactly as the draft card's „Im Projekt öffnen" does.
 *
 * ## Why it says „läuft" and not „erledigt"
 *
 * The card states the state, so the answer beside it cannot quietly overstate
 * it. The status line is the product's own promise read back: work was handed
 * over, it is running, and somebody will hear when it is done.
 */

import type { FC } from 'react'
import { ClipboardCheck } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { SectionLabel } from '@/components/ui/section-label'
import { useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { CARD_SHELL } from './card-chrome'

/** The four delegatable kinds, as the dictionary names them. */
const KIND_LABEL = {
  compliance_check: 'complianceCheck',
  einreichcheck: 'einreichcheck',
  document: 'document',
  revision: 'revision',
} as const

interface TaskCreatedCardProps {
  taskId: string
  kind: keyof typeof KIND_LABEL
  title: string
  goal: string
  /** ISO instant the work is wanted by, or absent when none was named. */
  dueAt?: string | null
  /** The thread the run writes into; absent when it could not be created. */
  conversationId?: string | null
}

export const TaskCreatedCard: FC<TaskCreatedCardProps> = ({
  taskId,
  kind,
  title,
  goal,
  dueAt,
  conversationId,
}) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()

  // An unparseable date renders as no date at all rather than „Invalid Date":
  // the field is optional, and a broken one is indistinguishable from an absent
  // one to a reader — but not to somebody who sees `NaN` in a Bauakt.
  const due = dueAt ? new Date(dueAt) : null
  const dueLabel =
    due && !Number.isNaN(due.getTime())
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(due)
      : null

  return (
    <Card data-testid="task-created-card" data-task-id={taskId} className={cn(CARD_SHELL, 'gap-2 p-5')}>
      <SectionLabel icon={ClipboardCheck}>{t('cards.taskCreated.eyebrow')}</SectionLabel>

      <div className="flex min-w-0 flex-col">
        <p className="card-title truncate text-foreground" title={title}>
          {title}
        </p>
        {/* The requester's own sentence, under the title the engine gave it.
            Two lines rather than one because the title is what the task LIST
            will call it and the goal is what the person actually said. */}
        <p className="card-caption text-muted-foreground" title={goal}>
          {goal}
        </p>
      </div>

      <p className="card-caption flex flex-wrap items-center gap-x-3 text-muted-foreground">
        <span className="flex items-center gap-x-2">
          <span data-testid="task-created-kind">
            {t(`cards.taskCreated.kind.${KIND_LABEL[kind]}` as 'cards.taskCreated.kind.einreichcheck')}
          </span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <span data-testid="task-created-status">{t('cards.taskCreated.running')}</span>
          {dueLabel && (
            <>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <span data-testid="task-created-due">{t('cards.taskCreated.due', { date: dueLabel })}</span>
            </>
          )}
        </span>

        {conversationId && (
          <a
            href={`/chat/${conversationId}`}
            data-testid="task-created-open"
            className={cn(
              'inline-flex min-h-11 items-center rounded-sm font-medium text-primary',
              'transition-colors duration-quick ease-out motion-reduce:transition-none',
              'hover:text-primary/80 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-2',
            )}
          >
            {t('cards.taskCreated.open')}
          </a>
        )}
      </p>
    </Card>
  )
}
