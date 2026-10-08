/**
 * Platform → maintenance. Vector-store upkeep and the deep-research kill switch.
 * Rarely needed, deliberately last.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 */

import type { JSX } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { RunKillSwitch } from '../run-kill-switch'
import { VectorMaintenance } from '../vector-maintenance'

export default async function PlatformMaintenancePage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.maintenance.title')} subtitle={t('sections.maintenance.subtitle')} />
      <VectorMaintenance />
      <RunKillSwitch />
    </div>
  )
}
