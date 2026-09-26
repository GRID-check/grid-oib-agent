/**
 * Platform → overview. Cross-organization directory, spend and headline stats.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 */

import type { JSX } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { PlatformOverview } from './platform-overview'

export default async function PlatformOverviewPage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.overview.title')} subtitle={t('sections.overview.subtitle')} />
      <PlatformOverview />
    </div>
  )
}
