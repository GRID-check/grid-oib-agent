/**
 * Organization → sensitive data. The lists every upload is screened against
 * before any model reads it (ADR-0079).
 *
 * The chrome, the back link and the section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 *
 * Deliberately NOT gated, for the same reason as storage: the person whose file
 * was held back is usually not an admin, and this page is where they see which
 * list caught it. Editing needs `org:settings:manage`, the same permission
 * `PUT /api/organization/upload-screening` enforces; everyone else reads.
 */

import type { JSX } from 'react'
import { ScanSearch } from 'lucide-react'
import { withPageSession } from '@/lib/auth/require-auth'
import { hasPermission, ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { UploadScreeningCard } from '@/features/organization/components/upload-screening-card'
import { getTranslations } from '@/i18n/server'

export default async function OrganizationScreeningPage(): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const t = await getTranslations('organization')

    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('sections.screening.title')} subtitle={t('sections.screening.subtitle')} />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScanSearch className="size-4 text-muted-foreground" aria-hidden />
              {t('screening.title')}
            </CardTitle>
            <CardDescription>{t('screening.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <UploadScreeningCard canEdit={hasPermission(session, ORG_PERMISSIONS.settingsManage)} />
          </CardContent>
        </Card>
      </div>
    )
  })
}
