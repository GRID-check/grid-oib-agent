/**
 * Organization management (admin).
 *
 * Server-gated to org admins. Renders a live overview (from WorkOS), the
 * Grid-side settings form, the WorkOS Users Management widget (invite / roles /
 * remove), and — per the admin's permissions — the advanced enterprise widgets.
 */

import { type JSX } from 'react'
import Link from 'next/link'
import { ArrowLeft, Building2, Cpu, Gauge, Globe, KeyRound, Mail, ScrollText, ShieldAlert, Users } from 'lucide-react'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { canManageBudgets, canManageModels, canViewAuditLogs, isOrgAdmin } from '@/lib/authz/organizations'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { AuditLogButton } from '@/components/audit/audit-log-button'
import { getNavFlags } from '@/lib/authz/nav'
import { getOrganizationOverview, getOrgSettings, type OrganizationOverview } from '@/lib/organizations/service'
import { OrgTopbar } from '@/components/shell'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { getTranslations, getLocale } from '@/i18n/server'
import { OrgSettingsForm } from './org-settings-form'
import { OrgWidgets } from './org-widgets'
import { ModelConfigCard } from './model-config-card'
import { LlmCredentialsCard } from './llm-credentials-card'
import { BudgetUsageCard } from './budget-usage-card'

const isAuthRequired = (): boolean => process.env.REQUIRE_AUTH?.toLowerCase() === 'true'

export default async function OrganizationPage(): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const navFlags = await getNavFlags(session)
  const t = await getTranslations('organization')
  const locale = await getLocale()

  const shell = (children: React.ReactNode): JSX.Element => (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <OrgTopbar
        user={{ name: session.name, email: session.email }}
        authRequired={isAuthRequired()}
        heading={t('title')}
        canManageOrganization={navFlags.canManageOrganization}
        canViewOrganization={navFlags.canViewOrganization}
        canManagePlatform={navFlags.canManagePlatform}
        canAccessArchiv={navFlags.canAccessArchiv}
      />
      <main id="main-content" className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 md:px-8 md:py-10">
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

  // Capability flags: full admins see everything; custom roles holding only
  // a granular permission (e.g. org:budgets:manage) see just their cards —
  // the UI mirrors the API's permission model (ADR-0016).
  const admin = isOrgAdmin(session)
  // Permission AND feature flag — the card mirrors the API's double gate.
  const models = canManageModels(session) && isFeatureEnabled(session, FEATURE_FLAGS.modelConfiguration)
  // BYOK LLM credentials (ADR-0022) — same permission, its own flag.
  const byok = canManageModels(session) && isFeatureEnabled(session, FEATURE_FLAGS.byokLlm)
  const budgets = canManageBudgets(session)
  const audit = canViewAuditLogs(session)

  // Users with no org capability at all can't manage the organization, but the
  // page must still be worth landing on (the Organization nav entry is now
  // visible to plain members). The usage API returns a member's own spend for
  // non-admins, so give them a "Your usage" self-view — the primary way a
  // budget-capped member can see why chat stopped — alongside a small note that
  // full org management needs admin access.
  if (!admin && !models && !byok && !budgets && !audit) {
    return shell(
      <div className="flex flex-col gap-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('memberSubtitle')}</p>
        </header>

        {/* Member self-view of usage (ADR-0015). isAdmin=false hides the
            admin-only limit editors and member/project tables; the card shows
            the member's own spend meters and legend. */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="size-4 text-muted-foreground" aria-hidden />
              {t('budgets.memberTitle')}
            </CardTitle>
            <CardDescription>{t('budgets.memberDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <BudgetUsageCard isAdmin={false} />
          </CardContent>
        </Card>

        {/* Polite admin-access note — org management lives behind admin caps. */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-muted-foreground" aria-hidden />
              {t('notAdmin.title')}
            </CardTitle>
            <CardDescription>{t('notAdmin.description')}</CardDescription>
          </CardHeader>
        </Card>
      </div>,
    )
  }

  // Live overview is best-effort — never block the page on a WorkOS hiccup.
  // Admin-only data is only fetched for admins.
  let overview: OrganizationOverview | null = null
  if (admin) {
    try {
      overview = await getOrganizationOverview(session.organizationId)
    } catch {
      overview = null
    }
  }
  // Grid-side settings are best-effort too — a Grid-DB hiccup must degrade this
  // one card (a "could not load" note) rather than crash the whole admin page.
  let settings: Awaited<ReturnType<typeof getOrgSettings>> | null = null
  let settingsError = false
  if (admin) {
    try {
      settings = await getOrgSettings(session.organizationId)
    } catch {
      settingsError = true
    }
  }

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

      {/* Overview (admins only) */}
      {admin && (
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
              <dd className="mt-1 text-sm">{settings?.displayName || overview?.name || '—'}</dd>
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

      )}

      {/* Grid-side settings (admins only) */}
      {admin && (settings || settingsError) && (
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.title')}</CardTitle>
          <CardDescription>{t('settings.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {settings ? (
            <OrgSettingsForm
              initialDisplayName={settings.displayName}
              initialDefaultLocale={settings.defaultLocale}
              initialWebSearchEnabled={settings.settings.webSearchEnabled !== false}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t('settings.loadError')}</p>
          )}
        </CardContent>
      </Card>

      )}

      {/* Runtime model configuration (ADR-0014) */}
      {models && (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cpu className="size-4 text-muted-foreground" aria-hidden />
            {t('models.title')}
          </CardTitle>
          <CardDescription>{t('models.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ModelConfigCard />
        </CardContent>
      </Card>

      )}

      {/* BYOK LLM credentials (ADR-0022) */}
      {byok && (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" aria-hidden />
            {t('byok.title')}
          </CardTitle>
          <CardDescription>{t('byok.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <LlmCredentialsCard />
        </CardContent>
      </Card>

      )}

      {/* Usage & budgets (ADR-0015) */}
      {budgets && (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="size-4 text-muted-foreground" aria-hidden />
            {t('budgets.title')}
          </CardTitle>
          <CardDescription>{t('budgets.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <BudgetUsageCard isAdmin={budgets} />
        </CardContent>
      </Card>

      )}

      {/* Audit trail — native WorkOS viewer, scoped to THIS organization */}
      {audit && (
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

      )}

      {/* WorkOS org widgets (admins only) */}
      {admin && (
      <OrgWidgets
        canManageUsers
        canManageSso={perms.includes('widgets:sso:manage')}
        canManageDirectory={perms.includes('widgets:dsync:manage')}
        canManageDomains={perms.includes('widgets:domain-verification:manage')}
        canManageAuditLogs={perms.includes('widgets:audit-log-streaming:manage')}
      />
      )}
    </div>,
  )
}
