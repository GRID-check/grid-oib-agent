/**
 * Platform → storage. Every tenant's consumption, and the quota that bounds it.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it. The card under the header
 * says what it holds (usage by organization) rather than repeating the page
 * title.
 */

import type { JSX } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { SectionCard } from '@/features/platform/components/section-card'
import { getTranslations } from '@/i18n/server'
import { PlatformStorageTable } from '../storage-table'

export default async function PlatformStoragePage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.storage.title')} subtitle={t('sections.storage.subtitle')} />
      <SectionCard
        title={t('storage.title')}
        description={t('storage.description')}
        testId="platform-storage-card"
      >
        <PlatformStorageTable />
      </SectionCard>
    </div>
  )
}
