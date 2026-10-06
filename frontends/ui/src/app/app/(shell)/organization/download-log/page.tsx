/**
 * Organization → download log (ADR-0081): who took which document out, and who
 * opened one in a folder with its own access list.
 *
 * The chrome, the back link and the section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 *
 * Gated on `org:downloads:view`, the permission `GET /api/organization/download-log`
 * enforces, and nothing else: the audit-log permission does not open it, because
 * this is data about what staff opened. The rows are read by the client through
 * the API, so every read is recorded in the audit trail; the page itself reads
 * nothing but the member list for the person filter.
 */

import type { JSX } from 'react'
import { ShieldAlert } from 'lucide-react'
import { withPageSession } from '@/lib/auth/require-auth'
import { canViewDownloadLog } from '@/lib/authz/organizations'
import { listOrganizationMembers } from '@/lib/organizations/service'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { DownloadLogView, type DownloadLogPerson } from '@/features/organization/components/download-log-view'
import { getTranslations } from '@/i18n/server'

export default async function OrganizationDownloadLogPage(): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const t = await getTranslations('organization')

    if (!canViewDownloadLog(session)) {
      return (
        <div className="flex flex-col gap-6">
          <PageHeader title={t('sections.downloads.title')} subtitle={t('sections.downloads.subtitle')} />
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="size-4 text-muted-foreground" aria-hidden />
                {t('notAdmin.title')}
              </CardTitle>
              <CardDescription>{t('notAdmin.description')}</CardDescription>
            </CardHeader>
          </Card>
        </div>
      )
    }

    // The person filter is a convenience: a WorkOS hiccup leaves it with the
    // everyone option only, never a failed page.
    let people: DownloadLogPerson[] = []
    try {
      people = await listOrganizationMembers(session.organizationId)
    } catch {
      people = []
    }

    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('sections.downloads.title')} subtitle={t('sections.downloads.subtitle')} />
        <DownloadLogView people={people} />
      </div>
    )
  })
}
