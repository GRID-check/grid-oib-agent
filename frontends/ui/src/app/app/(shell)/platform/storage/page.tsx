/**
 * Platform → storage. Every tenant's consumption, and the quota that bounds it.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 */

import type { JSX } from 'react'
import { HardDrive } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { PlatformStorageTable } from '../storage-table'

export default async function PlatformStoragePage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.storage.title')} subtitle={t('sections.storage.subtitle')} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="text-muted-foreground size-4" aria-hidden />
            {t('storage.title')}
          </CardTitle>
          <CardDescription>{t('storage.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <PlatformStorageTable />
        </CardContent>
      </Card>
    </div>
  )
}
