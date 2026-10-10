'use client'

/**
 * Settings → Members: who may work in this project, in which role.
 *
 * Only reachable for readers who may manage the roster, because that is who
 * the roster endpoint answers (`listProjectMembers`). It used to render for
 * every viewer as a "read-only roster" that could never load: the request was
 * refused and the page showed an error toast on every visit.
 */

import type { JSX } from 'react'
import { ProjectMembersForm } from '@/components/projects/project-members-form'
import { useTranslations } from '@/i18n'
import { SettingsSectionIntro } from './settings-panel'

export interface MembersSettingsProps {
  projectId: string
  /** Same id space as the roster's `organizationMembershipId`: guards against self-lockout. */
  currentMembershipId: string | null
}

export function MembersSettings({
  projectId,
  currentMembershipId,
}: MembersSettingsProps): JSX.Element {
  const t = useTranslations('settings')

  return (
    <div className="flex flex-col gap-4">
      <SettingsSectionIntro
        title={t('project.members.title')}
        description={t('project.members.description')}
      />
      <ProjectMembersForm
        projectId={projectId}
        canManage
        currentMembershipId={currentMembershipId}
      />
    </div>
  )
}
