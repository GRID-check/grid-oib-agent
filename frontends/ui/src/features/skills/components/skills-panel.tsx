'use client'

/**
 * Skills tab root. List mode shows the org skill toolbox plus the project's
 * schedule list; the builder replaces both while creating/editing a schedule.
 * Opening an existing schedule passes its full row directly (the list already
 * carries the skill snapshot — no extra fetch). Returning to the list remounts
 * it, so it refetches and reflects any create/edit.
 *
 * Capabilities are computed by the page and passed down: org skill authoring
 * (org:skills:manage) and schedule management (project:skills:manage) are
 * different permissions that can be held independently.
 */

import { useState } from 'react'
import { useTranslations } from '@/i18n'
import { SkillEditorDialog } from './skill-editor-dialog'
import { ScheduleBuilder } from './schedule-builder'
import { ScheduleList } from './schedule-list'
import { SkillToolbox } from './skill-toolbox'
import type { SkillListItem, SkillSchedule } from '@/adapters/api/skills-client'

interface SkillsPanelProps {
  projectId: string
  /**
   * Qdrant collection of this project. The run history joins it against the
   * backend's research runs to show each run's live job status.
   */
  projectCollection: string | null
  /** Whether this member may author/clone/delete skills (org:skills:manage). */
  canManageOrgSkills: boolean
  /** Whether this member may create/edit/delete/run schedules (project:skills:manage). */
  canManageProjectSkills: boolean
}

type Mode = 'list' | 'create' | 'edit'

export function SkillsPanel({
  projectId,
  projectCollection,
  canManageOrgSkills,
  canManageProjectSkills,
}: SkillsPanelProps): JSX.Element {
  const t = useTranslations('skills')
  const [mode, setMode] = useState<Mode>('list')
  const [editSchedule, setEditSchedule] = useState<SkillSchedule | null>(null)
  // Editor dialog state: null = closed; an id means an org row is being
  // edited; cloneFrom is set when creating from a platform builtin.
  const [editorOpen, setEditorOpen] = useState(false)
  const [editSkill, setEditSkill] = useState<SkillListItem | null>(null)
  const [cloneFrom, setCloneFrom] = useState<string | null>(null)

  const openClone = (skill: SkillListItem) => {
    setEditSkill(null)
    setCloneFrom(skill.name)
    setEditorOpen(true)
  }

  const openSkillEditor = (skill: SkillListItem | null) => {
    setEditSkill(skill)
    setCloneFrom(null)
    setEditorOpen(true)
  }

  const openCreate = () => {
    setEditSchedule(null)
    setMode('create')
  }

  const openEdit = (schedule: SkillSchedule) => {
    setEditSchedule(schedule)
    setMode('edit')
  }

  const backToList = () => {
    setEditSchedule(null)
    setMode('list')
  }

  return (
    <div className="mx-auto w-full max-w-[1080px] px-6 pb-10 pt-6 md:px-10 md:pt-[34px]">
      {mode === 'list' ? (
        <>
          <header className="mb-7 space-y-1.5">
            <h1 className="text-[20px] font-medium tracking-[-0.01em] text-foreground">
              {t('title')}
            </h1>
            <p className="max-w-3xl text-sm text-muted-foreground">{t('subtitle')}</p>
          </header>
          <SkillToolbox canManage={canManageOrgSkills} onClone={openClone} onEdit={openSkillEditor} />
          <ScheduleList
            projectId={projectId}
            projectCollection={projectCollection}
            canManage={canManageProjectSkills}
            onCreate={openCreate}
            onEdit={openEdit}
          />
          <SkillEditorDialog
            open={editorOpen}
            onOpenChange={setEditorOpen}
            skill={editSkill}
            cloneFrom={cloneFrom}
            onSaved={() => setEditorOpen(false)}
          />
        </>
      ) : (
        <ScheduleBuilder
          projectId={projectId}
          schedule={editSchedule}
          onSaved={backToList}
          onCancel={backToList}
        />
      )}
    </div>
  )
}