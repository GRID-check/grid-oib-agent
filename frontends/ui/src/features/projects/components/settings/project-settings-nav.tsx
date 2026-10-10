'use client'

import type { JSX } from 'react'
import {
  Brain,
  FileStack,
  Gauge,
  GitCompareArrows,
  LayoutDashboard,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { SectionNav } from '@/components/shell/section-nav'
import { useTranslations } from '@/i18n'
import {
  PROJECT_SETTINGS_SECTION_KEYS,
  settingsSectionHref,
  type ProjectSettingsSectionKey,
} from '../../lib/settings-sections'

const ICONS: Record<ProjectSettingsSectionKey, LucideIcon> = {
  overview: LayoutDashboard,
  members: Users,
  memory: Brain,
  usage: Gauge,
  documents: FileStack,
  references: GitCompareArrows,
}

/**
 * The project Settings section nav. Told which sections exist rather than
 * working it out, for the organization nav's reason: the access rules stay on
 * the server, and a link that lands on a 404 is worse than no link.
 */
export function ProjectSettingsNav({
  projectId,
  sections,
}: {
  projectId: string
  sections: readonly ProjectSettingsSectionKey[]
}): JSX.Element {
  const t = useTranslations('settings')

  const items = PROJECT_SETTINGS_SECTION_KEYS.filter((key) => sections.includes(key)).map(
    (key) => ({
      key,
      href: settingsSectionHref(projectId, key),
      icon: ICONS[key],
      label: t(`project.nav.${key}`),
    })
  )

  return (
    <SectionNav
      label={t('project.nav.label')}
      items={items}
      rootHref={settingsSectionHref(projectId, 'overview')}
      pillId="project-settings-nav-pill"
      orientation="tabs"
      data-testid="project-settings-nav"
    />
  )
}
