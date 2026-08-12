/**
 * Platform → Skills. The skills Piloti curates for every organization.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 */

import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { PlatformSkillCatalog } from './platform-skill-catalog'

export default async function PlatformSkillsPage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.skills.title')} subtitle={t('sections.skills.subtitle')} />
      <PlatformSkillCatalog />
    </div>
  )
}
