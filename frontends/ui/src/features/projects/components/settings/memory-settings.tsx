'use client'

/**
 * Settings → Memory: what Piloti has learned in this project, for a person to
 * confirm, correct, pin or remove (project-memory-design.md §7). Readers
 * without write access get the list without the controls, and a line saying
 * why, instead of buttons the API refuses.
 */

import type { JSX } from 'react'
import { useTranslations } from '@/i18n'
import { ProjectMemoryPanel } from '../project-memory-panel'

export interface MemorySettingsProps {
  projectId: string
  /** `project:memory:write`. */
  canWrite: boolean
}

export function MemorySettings({ projectId, canWrite }: MemorySettingsProps): JSX.Element {
  const t = useTranslations('settings')

  return (
    <div className="flex flex-col gap-4">
      <ProjectMemoryPanel projectId={projectId} readOnly={!canWrite} />
      {!canWrite && (
        <p className="text-muted-foreground text-xs">{t('project.memory.readOnlyHint')}</p>
      )}
    </div>
  )
}
