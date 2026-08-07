/**
 * Organization → storage. Bytes stored against the quota that stops uploads.
 *
 * The chrome, the back link and the section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 *
 * Deliberately NOT gated, for the same reason as budgets: when the quota is
 * reached every upload in the tenant is refused, and the person it refused is
 * usually not an admin. `canManageStorage` therefore decides what the card
 * shows — admins additionally get the quota editor — rather than whether the
 * route opens. This page is the only place that explains why an upload failed.
 */

import { HardDrive } from 'lucide-react'
import { withPageSession } from '@/lib/auth/require-auth'
import { canManageStorage } from '@/lib/authz/organizations'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { StorageUsageCard } from '../storage-usage-card'

export default async function OrganizationStoragePage(): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const t = await getTranslations('organization')

    const isAdmin = canManageStorage(session)

    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('sections.storage.title')} subtitle={t('sections.storage.subtitle')} />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="size-4 text-muted-foreground" aria-hidden />
              {t('storage.title')}
            </CardTitle>
            <CardDescription>
              {isAdmin ? t('storage.description') : t('storage.memberDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StorageUsageCard isAdmin={isAdmin} />
          </CardContent>
        </Card>
      </div>
    )
  })
}
