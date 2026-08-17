'use client'

/**
 * Skills tab root: the org's skills and their editor, and nothing else.
 *
 * A skill knows nothing about time. Everything schedule-shaped — what runs,
 * when, and what a run produces — lives on the Jobs tab
 * (`features/jobs`), where a skill is the optional extra a job attaches.
 *
 * Authoring is gated on org:skills:manage; without it the page is read-only.
 *
 * The page title lives in the shared project-section chrome. "New skill"
 * portals into that header; this file is the toolbox and the editor only.
 */

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { ProjectSectionActions } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { SkillEditorDialog } from './skill-editor-dialog'
import { SkillToolbox } from './skill-toolbox'
import type { SkillListItem } from '@/adapters/api/skills-client'

interface SkillsPanelProps {
  /** Whether this member may author/delete skills (org:skills:manage). */
  canManageOrgSkills: boolean
}

export function SkillsPanel({ canManageOrgSkills }: SkillsPanelProps): JSX.Element {
  const t = useTranslations('skills')
  // Editor dialog state: a null skill means creating.
  const [editorOpen, setEditorOpen] = useState(false)
  const [editSkill, setEditSkill] = useState<SkillListItem | null>(null)
  /**
   * Remount key for the editor, bumped on every open.
   *
   * The dialog seeds its form and its metadata controls from props in state
   * INITIALISERS, which React runs once per mount — and the dialog is mounted
   * for the life of this panel, so those initialisers ran once, with the props
   * the panel first rendered with: `skill: null`. Every subsequent open
   * therefore showed that first form, which is why opening a second skill to
   * edit showed the first one. The key makes each open a fresh mount.
   */
  const [editorKey, setEditorKey] = useState(0)
  /** Bumped after a save so the list re-fetches and the new row shows up. */
  const [reloadKey, setReloadKey] = useState(0)

  const openSkillEditor = (skill: SkillListItem | null) => {
    setEditSkill(skill)
    setEditorKey((key) => key + 1)
    setEditorOpen(true)
  }

  return (
    <div className="mx-auto w-full max-w-[1080px] px-6 pb-10 pt-6 md:px-10">
      {canManageOrgSkills && (
        <ProjectSectionActions>
          <Button size="sm" className="shrink-0" onClick={() => openSkillEditor(null)}>
            <Plus className="size-4" aria-hidden />
            {t('toolbox.newSkill')}
          </Button>
        </ProjectSectionActions>
      )}
      <SkillToolbox
        canManage={canManageOrgSkills}
        onEdit={openSkillEditor}
        reloadKey={reloadKey}
      />
      <SkillEditorDialog
        key={editorKey}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        skill={editSkill}
        onSaved={() => {
          setEditorOpen(false)
          setReloadKey((key) => key + 1)
        }}
      />
    </div>
  )
}
