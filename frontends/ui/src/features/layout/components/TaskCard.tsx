/**
 * TaskCard Component
 *
 * Row-like card displaying a single task/todo item with:
 * - Checkbox (checked when complete, not clickable)
 * - Task name
 * - Status badge with color based on status
 *
 * SSE Events: artifact.update with type: "todo"
 */

'use client'

import { type FC } from 'react'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { motion, fadeRise, springGentle } from '@/components/motion'
import { useTranslations } from '@/i18n'
import type { DeepResearchTodo, DeepResearchTodoStatus } from '@/features/chat/types'

interface TaskCardProps {
  /** Todo item from deep research */
  todo: DeepResearchTodo
}

/**
 * Get badge classes based on task status
 * - success (green): completed
 * - info (blue): in_progress
 * - warning (amber): pending
 * - danger (red): stopped (error state)
 */
const getBadgeClasses = (status: DeepResearchTodoStatus): string => {
  switch (status) {
    case 'completed':
      return 'border-success text-success'
    case 'in_progress':
      return 'border-info text-info'
    case 'pending':
      return 'border-warning text-warning'
    case 'stopped':
      return 'border-error text-error'
    default:
      return 'border-warning text-warning'
  }
}

/**
 * Map a status to its translation key, or null for unknown statuses.
 */
const getStatusKey = (status: DeepResearchTodoStatus): string | null => {
  switch (status) {
    case 'completed':
      return 'taskCard.statusComplete'
    case 'in_progress':
      return 'taskCard.statusInProgress'
    case 'pending':
      return 'taskCard.statusPending'
    case 'stopped':
      return 'taskCard.statusStopped'
    default:
      return null
  }
}

/**
 * Card showing a single task's checkbox, name, and status badge.
 */
export const TaskCard: FC<TaskCardProps> = ({ todo }) => {
  const t = useTranslations('research')
  const isComplete = todo.status === 'completed'
  const statusKey = getStatusKey(todo.status)
  const statusText = statusKey ? t(statusKey) : todo.status

  return (
    // Outer motion wrapper handles the mount fade-rise; inner div keeps the
    // `opacity-70` completed-state class (motion owns inline opacity on its own node)
    <motion.div variants={fadeRise} initial="hidden" animate="visible" transition={springGentle}>
      <div
        className={cn('flex items-center gap-3 rounded-lg border p-3', isComplete && 'opacity-70')}
      >
        {/* Checkbox - checked when complete, always disabled (read-only) */}
        <Checkbox checked={isComplete} disabled aria-label={t('taskCard.task', { content: todo.content })} />

        {/* Task Name */}
        <span
          className={cn(
            'min-w-0 flex-1 text-sm font-semibold',
            isComplete && 'text-muted-foreground line-through'
          )}
        >
          {todo.content}
        </span>

        {/* Status Badge - with spinner for in_progress */}
        <Badge variant="outline" className={cn('gap-1', getBadgeClasses(todo.status))}>
          {todo.status === 'in_progress' && (
            <Spinner size="sm" label={t('taskCard.inProgress')} className="[&_svg]:size-3" />
          )}
          {statusText}
        </Badge>
      </div>
    </motion.div>
  )
}
