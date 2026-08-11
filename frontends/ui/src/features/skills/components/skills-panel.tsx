'use client'

/**
 * Skills tab root: the org skill TOOLBOX and its editor, and nothing else.
 *
 * A skill knows nothing about time. Everything schedule-shaped — what runs,
 * when, and what a run produces — lives on the Jobs tab
 * (`features/jobs`), where a skill is the optional extra a job attaches.
 *
 * Authoring is gated on org:skills:manage; without it the toolbox is read-only.
 */

import { useState } from 'react'
import { useTranslations } from '@/i18n'
import { SkillEditorDialog } from './skill-editor-dialog'
import { SkillToolbox } from './skill-toolbox'
import type { SkillListItem } from '@/adapters/api/skills-client'

interface SkillsPanelProps {
  /** Whether this member may author/clone/delete skills (org:skills:manage). */
  canManageOrgSkills: boolean
}

export function SkillsPanel({ canManageOrgSkills }: SkillsPanelProps): JSX.Element {
  const t = useTranslations('skills')
  // Editor dialog state: null skill = creating; cloneFrom is set when creating
  // from a platform builtin.
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

  return (
    <div className="mx-auto w-full max-w-[1080px] px-6 pb-10 pt-6 md:px-10 md:pt-[34px]">
      <header className="mb-7 space-y-1.5">
        <h1 className="text-[20px] font-medium tracking-[-0.01em] text-foreground">{t('title')}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>
      <SkillToolbox canManage={canManageOrgSkills} onClone={openClone} onEdit={openSkillEditor} />
      <SkillEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        skill={editSkill}
        cloneFrom={cloneFrom}
        onSaved={() => setEditorOpen(false)}
      />
    </div>
  )
}
