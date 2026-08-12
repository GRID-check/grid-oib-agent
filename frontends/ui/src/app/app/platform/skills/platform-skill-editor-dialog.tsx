'use client'

/**
 * The curated-skill editor: the org authoring dialog, pointed at the platform
 * catalogue.
 *
 * A curated skill is not a privileged shape — it is the same agentskills.io
 * document as one an organization writes, with the same name rules, the same
 * description budget, the same `grid-agents` / `grid-cards` controls, the same
 * live SKILL.md preview and the same reviewer. So this is a thin adapter over
 * `SkillEditorDialog` rather than a second editor: two copies would fork the
 * authoring experience, and the copy used less often is the one that rots.
 *
 * Only two things differ, and both go through the `persistence` seam:
 *
 *   where it saves     `/api/platform/skills`, not this org's toolbox.
 *   the master switch  Here it means PUBLISHED — visible to every organization
 *                      — not "enabled for us". An org still has to switch the
 *                      skill on for itself; publishing offers, it does not
 *                      impose.
 */

import { useMemo } from 'react'
import { SkillEditorDialog, type SkillPersistence } from '@/features/skills/components/skill-editor-dialog'
import { useTranslations } from '@/i18n'
import {
  createPlatformSkill,
  deletePlatformSkill,
  updatePlatformSkill,
  type PlatformSkillItem,
  type SkillListItem,
} from '@/adapters/api/skills-client'

interface PlatformSkillEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The curated skill being edited, or null when adding one. */
  skill: PlatformSkillItem | null
  onSaved: () => void
}

/**
 * A catalogue row in the shape the shared editor reads.
 *
 * `id` is deliberately dropped rather than passed through. The editor's default
 * persistence would use it against `/api/skills/{id}` — this org's toolbox —
 * and a platform owner editing the fleet's copy must never be one forgotten
 * prop away from writing a tenant row instead. The `persistence` below is what
 * carries the real id.
 */
function toEditorSkill(skill: PlatformSkillItem): SkillListItem {
  return {
    id: null,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    metadata: skill.metadata,
    origin: 'platform',
    enabled: skill.published,
    clonedFrom: null,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  }
}

export function PlatformSkillEditorDialog({
  open,
  onOpenChange,
  skill,
  onSaved,
}: PlatformSkillEditorDialogProps): JSX.Element {
  const t = useTranslations('platform')

  const persistence = useMemo<SkillPersistence>(
    () => ({
      save: async (input, published) => {
        const payload = {
          name: input.name,
          description: input.description,
          body: input.body,
          metadata: input.metadata,
          published,
        }
        if (skill) await updatePlatformSkill(skill.id, payload)
        else await createPlatformSkill(payload)
      },
      remove: skill ? async () => void (await deletePlatformSkill(skill.id)) : undefined,
      switchLabels: {
        label: t('skills.publishLabel'),
        hint: t('skills.publishHint'),
      },
      titles: {
        create: t('skills.createTitle'),
        edit: t('skills.editTitle'),
        createSubtitle: t('skills.createSubtitle'),
        editSubtitle: t('skills.editSubtitle'),
      },
      successMessage: {
        create: t('skills.createSuccess'),
        edit: t('skills.updateSuccess'),
      },
    }),
    [skill, t],
  )

  return (
    <SkillEditorDialog
      open={open}
      onOpenChange={onOpenChange}
      skill={skill ? toEditorSkill(skill) : null}
      persistence={persistence}
      onSaved={onSaved}
    />
  )
}
