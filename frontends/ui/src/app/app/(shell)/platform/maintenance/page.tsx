/**
 * Platform → maintenance. Vector-store upkeep. Rarely needed, deliberately last.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 */

import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { VectorMaintenance } from '../vector-maintenance'

export default async function PlatformMaintenancePage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.maintenance.title')} subtitle={t('sections.maintenance.subtitle')} />
      <VectorMaintenance />
    </div>
  )
}
