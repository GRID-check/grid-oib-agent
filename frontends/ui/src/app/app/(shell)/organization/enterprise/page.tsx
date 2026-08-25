/**
 * Organization → enterprise. The identity plumbing an IT department owns: SSO,
 * Directory Sync, domain verification and audit-log streaming, each rendered by
 * WorkOS' own admin-portal widget.
 *
 * The chrome, the back link and the section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 *
 * Two gates, on purpose. The section needs org-admin standing to open at all,
 * and each widget additionally needs the matching WorkOS widget permission —
 * decided here and passed down as booleans, while the token route independently
 * refuses to mint a scope the caller lacks. Member management is NOT here: it
 * lives in the Access section, so `canManageUsers` is false and the Users widget
 * never renders twice.
 */

import { ShieldAlert } from 'lucide-react'
import { withPageSession } from '@/lib/auth/require-auth'
import { isOrgAdmin } from '@/lib/authz/organizations'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { OrgWidgets } from '../org-widgets'

export default async function OrganizationEnterprisePage(): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const t = await getTranslations('organization')

    const admin = isOrgAdmin(session)
    const perms = session.permissions

    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('sections.enterprise.title')} />

        {admin ? (
          <OrgWidgets
            canManageUsers={false}
            canManageSso={perms.includes('widgets:sso:manage')}
            canManageDirectory={perms.includes('widgets:dsync:manage')}
            canManageDomains={perms.includes('widgets:domain-verification:manage')}
            canManageAuditLogs={perms.includes('widgets:audit-log-streaming:manage')}
          />
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
  })
}
