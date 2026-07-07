'use client'

/**
 * WorkOS organization-management widgets.
 *
 * The Users Management widget (invite members, assign roles, remove access) is
 * shown to any org admin. The advanced widgets (SSO, Directory Sync, Domain
 * Verification) are each rendered only when the caller holds the matching
 * WorkOS permission — the server decides that and passes booleans down, and the
 * token route independently refuses to mint scopes the caller lacks.
 *
 * Each widget gets its own scoped `authToken` provider. All render inside a
 * single WorkOsWidgets provider whose appearance follows Grid's theme.
 */

import { useMemo } from 'react'
import {
  WorkOsWidgets,
  UsersManagement,
  AdminPortalSsoConnection,
  DirectorySync,
  AdminPortalDomainVerification,
  AdminPortalAuditLogStreaming,
} from '@workos-inc/widgets'
import '@radix-ui/themes/styles.css'

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { makeWidgetTokenFetcher } from '@/lib/workos/widget-token'
import { useResolvedAppearance } from '@/lib/workos/use-widget-appearance'
import { useTranslations } from '@/i18n'

export interface OrgWidgetsProps {
  canManageUsers: boolean
  canManageSso: boolean
  canManageDirectory: boolean
  canManageDomains: boolean
  canManageAuditLogs: boolean
}

export const OrgWidgets = ({
  canManageUsers,
  canManageSso,
  canManageDirectory,
  canManageDomains,
  canManageAuditLogs,
}: OrgWidgetsProps): React.ReactNode => {
  const t = useTranslations('organization')
  const appearance = useResolvedAppearance()

  const usersToken = useMemo(() => makeWidgetTokenFetcher(['widgets:users-table:manage']), [])
  const ssoToken = useMemo(() => makeWidgetTokenFetcher(['widgets:sso:manage']), [])
  const directoryToken = useMemo(() => makeWidgetTokenFetcher(['widgets:dsync:manage']), [])
  const domainsToken = useMemo(
    () => makeWidgetTokenFetcher(['widgets:domain-verification:manage']),
    [],
  )
  const auditLogsToken = useMemo(
    () => makeWidgetTokenFetcher(['widgets:audit-log-streaming:manage']),
    [],
  )

  const hasAdvanced = canManageSso || canManageDirectory || canManageDomains || canManageAuditLogs

  return (
    <WorkOsWidgets theme={{ appearance, radius: 'medium', scaling: '100%' }}>
      {canManageUsers && (
        <Card>
          <CardHeader>
            <CardTitle>{t('members.title')}</CardTitle>
            <CardDescription>{t('members.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <UsersManagement authToken={usersToken} />
          </CardContent>
        </Card>
      )}

      {hasAdvanced && (
        <section className="flex flex-col gap-2">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">{t('advanced.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('advanced.description')}</p>
          </div>

          {canManageSso && (
            <Card>
              <CardHeader>
                <CardTitle>{t('advanced.sso')}</CardTitle>
                <CardDescription>{t('advanced.ssoDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <AdminPortalSsoConnection authToken={ssoToken} />
              </CardContent>
            </Card>
          )}

          {canManageDirectory && (
            <Card>
              <CardHeader>
                <CardTitle>{t('advanced.directory')}</CardTitle>
                <CardDescription>{t('advanced.directoryDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <DirectorySync authToken={directoryToken} />
              </CardContent>
            </Card>
          )}

          {canManageDomains && (
            <Card>
              <CardHeader>
                <CardTitle>{t('advanced.domains')}</CardTitle>
                <CardDescription>{t('advanced.domainsDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <AdminPortalDomainVerification authToken={domainsToken} />
              </CardContent>
            </Card>
          )}

          {canManageAuditLogs && (
            <Card>
              <CardHeader>
                <CardTitle>{t('advanced.auditLogs')}</CardTitle>
                <CardDescription>{t('advanced.auditLogsDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <AdminPortalAuditLogStreaming authToken={auditLogsToken} />
              </CardContent>
            </Card>
          )}
        </section>
      )}
    </WorkOsWidgets>
  )
}
