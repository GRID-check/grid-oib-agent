/**
 * Organization → storage. Bytes stored against the quota that stops uploads.
 *
 * The chrome, the back link and the section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 *
 * Deliberately NOT gated, for the same reason as budgets: when the quota is
 * reached every upload in the tenant is refused, and the person it refused is
 * usually not an admin. This page is the only place that explains why.
 *
 * Read-only for everyone, including org admins. The quota is set by the
 * platform operator (ADR-0042) — a tenant that could raise its own limit would
 * not be limited — so there is no editor here for any role.
 */

import type { JSX } from 'react'
import { HardDrive } from 'lucide-react'
import { withPageSession } from '@/lib/auth/require-auth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { StorageUsageCard } from '../storage-usage-card'

export default async function OrganizationStoragePage(): Promise<JSX.Element> {
  return withPageSession(async () => {
    const t = await getTranslations('organization')

    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('sections.storage.title')} subtitle={t('sections.storage.subtitle')} />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="size-4 text-muted-foreground" aria-hidden />
              {t('storage.title')}
            </CardTitle>
            <CardDescription>{t('storage.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <StorageUsageCard />
          </CardContent>
        </Card>
      </div>
    )
  })
}
