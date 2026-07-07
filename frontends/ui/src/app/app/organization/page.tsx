/**
 * Organization management (admin).
 *
 * Server-gated to org admins. Renders a live overview (from WorkOS), the
 * Grid-side settings form, the WorkOS Users Management widget (invite / roles /
 * remove), and — per the admin's permissions — the advanced enterprise widgets.
 */

import Link from 'next/link'
import { ArrowLeft, Building2, Globe, Mail, ShieldAlert, Users } from 'lucide-react'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { isOrgAdmin } from '@/lib/authz/organizations'
import { getOrganizationOverview, getOrgSettings, type OrganizationOverview } from '@/lib/organizations/service'
import { OrgTopbar } from '@/components/shell'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { getTranslations, getLocale } from '@/i18n/server'
import { OrgSettingsForm } from './org-settings-form'
import { OrgWidgets } from './org-widgets'

const isAuthRequired = (): boolean => process.env.REQUIRE_AUTH?.toLowerCase() === 'true'

export default async function OrganizationPage(): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const t = await getTranslations('organization')
  const locale = await getLocale()

  const shell = (children: React.ReactNode): JSX.Element => (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <OrgTopbar
        user={{ name: session.name, email: session.email }}
        authRequired={isAuthRequired()}
        heading={t('title')}
        canManageOrganization={isOrgAdmin(session)}
      />
      <main id="main-content" className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 md:px-8">
        <Link
          href="/app/projects"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {t('backToApp')}
        </Link>
        {children}
      </main>
    </div>
  )

  // Non-admins never see org management.
  if (!isOrgAdmin(session)) {
    return shell(
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-muted-foreground" aria-hidden />
            {t('notAdmin.title')}
          </CardTitle>
          <CardDescription>{t('notAdmin.description')}</CardDescription>
        </CardHeader>
      </Card>,
    )
  }

  // Live overview is best-effort — never block the page on a WorkOS hiccup.
  let overview: OrganizationOverview | null = null
  try {
    overview = await getOrganizationOverview(session.organizationId)
  } catch {
    overview = null
  }
  const settings = await getOrgSettings(session.organizationId)

  const perms = session.permissions
  const createdLabel = overview
    ? new Date(overview.createdAt).toLocaleDateString(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null

  return shell(
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>

      {/* Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="size-4 text-muted-foreground" aria-hidden />
            {t('overview.title')}
          </CardTitle>
          <CardDescription>{t('overview.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase text-muted-foreground">
                {t('overview.name')}
              </dt>
              <dd className="mt-1 text-sm">{settings.displayName || overview?.name || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-muted-foreground">
                {t('overview.id')}
              </dt>
              <dd className="mt-1 truncate font-mono text-sm">{session.organizationId}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-muted-foreground">
                {t('overview.members')}
              </dt>
              <dd className="mt-1 flex items-center gap-1.5 text-sm">
                <Users className="size-3.5 text-muted-foreground" aria-hidden />
                {overview
                  ? overview.memberCountCapped
                    ? t('overview.membersCapped', { count: overview.memberCount })
                    : overview.memberCount
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-muted-foreground">
                {t('overview.pendingInvites')}
              </dt>
              <dd className="mt-1 flex items-center gap-1.5 text-sm">
                <Mail className="size-3.5 text-muted-foreground" aria-hidden />
                {overview ? overview.pendingInviteCount : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-muted-foreground">
                {t('overview.domains')}
              </dt>
              <dd className="mt-1 flex items-center gap-1.5 text-sm">
                <Globe className="size-3.5 text-muted-foreground" aria-hidden />
                {overview && overview.domains.length > 0
                  ? overview.domains.join(', ')
                  : t('overview.noDomains')}
              </dd>
            </div>
            {createdLabel && (
              <div>
                <dt className="text-xs font-medium uppercase text-muted-foreground">
                  {t('overview.created')}
                </dt>
                <dd className="mt-1 text-sm">{createdLabel}</dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>

      {/* Grid-side settings */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.title')}</CardTitle>
          <CardDescription>{t('settings.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <OrgSettingsForm
            initialDisplayName={settings.displayName}
            initialDefaultLocale={settings.defaultLocale}
          />
        </CardContent>
      </Card>

      {/* WorkOS org widgets */}
      <OrgWidgets
        canManageUsers
        canManageSso={perms.includes('widgets:sso:manage')}
        canManageDirectory={perms.includes('widgets:dsync:manage')}
        canManageDomains={perms.includes('widgets:domain-verification:manage')}
        canManageAuditLogs={perms.includes('widgets:audit-log-streaming:manage')}
      />
    </div>,
  )
}
