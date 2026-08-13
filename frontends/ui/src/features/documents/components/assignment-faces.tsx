'use client'

import { AvatarStack } from '@/components/ui/avatar-stack'
import { useTranslations } from '@/i18n'
import type { FileAssignee } from './project-file-workspace'
import { cn } from '@/lib/utils'

export function AssignmentFaces({
  assignees,
  className,
}: {
  assignees: readonly FileAssignee[] | undefined
  className?: string
}) {
  const t = useTranslations('files')
  if (!assignees || assignees.length === 0) {
    return <span className={cn('truncate text-[11px] text-muted-foreground', className)}>{t('assignment.unassigned')}</span>
  }
  const people = assignees.map((person) => ({
    userId: person.userId,
    name: person.name || person.email || person.userId,
    profilePictureUrl: person.profilePictureUrl,
  }))
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)} title={people.map((p) => p.name).join(', ')}>
      <AvatarStack people={people} size="sm" max={3} />
    </span>
  )
}
