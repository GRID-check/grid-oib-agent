'use client'

/**
 * Settings → Project profile: what Piloti assumes about this project in every
 * answer, and which OIB-Richtlinien follow from it.
 *
 * Read-only by design (click-dummy spec §9.1): the profile has one editor, the
 * intake wizard, because its facts are interdependent and the wizard is where
 * they are checked against each other. The brief carries the one link there.
 * The standards sit under it because they are derived from it: change the
 * building class in the wizard and this list changes.
 */

import type { JSX } from 'react'
import { useTranslations } from '@/i18n'
import type { ProjectOverviewData } from '../../types'
import { ApplicableStandards } from '../applicable-standards'
import { ProjectBrief } from '../project-brief'
import { SettingsSectionIntro } from './settings-panel'

export interface ProfileSettingsProps {
  data: Pick<
    ProjectOverviewData,
    'id' | 'profile' | 'profileDisplay' | 'applicableStandards' | 'briefComplete'
  >
  /** Open the wizard (`project:edit`, what `PUT /profile` enforces). */
  canEdit: boolean
}

export function ProfileSettings({ data, canEdit }: ProfileSettingsProps): JSX.Element {
  const t = useTranslations('settings')

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <SettingsSectionIntro
          title={t('project.profile.title')}
          description={t('project.profile.description')}
        />
        <ProjectBrief
          projectId={data.id}
          profile={data.profile}
          summary={data.profileDisplay?.summary}
          summaryLocale={data.profileDisplay?.summaryLocale}
          briefStarted={data.profileDisplay != null}
          canEdit={canEdit}
        />
      </div>

      <ApplicableStandards
        projectId={data.id}
        standards={data.applicableStandards}
        briefComplete={data.briefComplete}
      />
    </div>
  )
}
