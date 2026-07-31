/**
 * Organization → compliance. The evidence trail: every privileged change made
 * in this organization, in WorkOS' own org-scoped audit viewer.
 *
 * The chrome, the back link and the section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 *
 * Gated on `org:audit:view` alone — the same permission
 * `/api/organization/audit-portal` enforces. `org:compliance:manage` does NOT
 * open it: this section is currently only the viewer, so admitting compliance
 * managers would render a button the server answers 403 to. The shipped
 * `org-compliance-officer` role holds both permissions, so it is unaffected.
 */

import { ScrollText, ShieldAlert } from 'lucide-react'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { canViewAuditLogs } from '@/lib/authz/organizations'
import { AuditLogButton } from '@/components/audit/audit-log-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'

export default async function OrganizationCompliancePage(): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const t = await getTranslations('organization')

  // Matches the API gate on `/api/organization/audit-portal` exactly. A UI that
  // offers a button the server refuses is worse than one that hides it.
  const canRead = canViewAuditLogs(session)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('sections.compliance.title')}
        subtitle={t('sections.compliance.subtitle')}
      />

      {canRead ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScrollText className="size-4 text-muted-foreground" aria-hidden />
              {t('audit.title')}
            </CardTitle>
            <CardDescription>{t('audit.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <AuditLogButton
              endpoint="/api/organization/audit-portal"
              label={t('audit.open')}
              errorMessage={t('audit.error')}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-muted-foreground" aria-hidden />
              {t('notAdmin.title')}
            </CardTitle>
            <CardDescription>{t('notAdmin.description')}</CardDescription>
          </CardHeader>
        </Card>
      )}
    </div>
  )
}
