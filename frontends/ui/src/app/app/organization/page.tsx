/**
 * Organization → overview. Who this organization is (WorkOS truth) and the
 * Grid-side settings that shape how it behaves for everyone in it.
 *
 * The chrome, the back link and the section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it. The organization tier used to
 * be one page stacking seven unrelated admin domains in a single scrolling
 * column — each is now its own route, and this one keeps the identity of the org
 * itself.
 *
 * Both reads are best-effort on purpose: a WorkOS outage or a Grid-DB hiccup
 * must degrade one card into a dash or a "could not load" note, never take down
 * the section. Everything here is admin-only; a plain member still lands on
 * their organization's identifier plus a pointer at who can change the rest,
 * rather than on a blank page.
 */

import { Building2, Globe, Mail, ShieldAlert, Users } from 'lucide-react'
import { withPageSession } from '@/lib/auth/require-auth'
import { isOrgAdmin } from '@/lib/authz/organizations'
import {
  getOrganizationOverview,
  getOrgSettings,
  type OrganizationOverview,
} from '@/lib/organizations/service'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { getLocale, getTranslations } from '@/i18n/server'
import { OrgSettingsForm } from './org-settings-form'

export default async function OrganizationOverviewPage(): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const t = await getTranslations('organization')
    const locale = await getLocale()

    const admin = isOrgAdmin(session)

    // Non-admins get the one fact that is theirs by definition — the id of the
    // organization their own session is scoped to — and the admin-access note.
    // No org-scoped read happens for them, so nothing new is exposed.
    if (!admin) {
      return (
        <div className="flex flex-col gap-6">
          <PageHeader
            title={t('sections.overview.title')}
            subtitle={t('sections.overview.subtitle')}
          />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="size-4 text-muted-foreground" aria-hidden />
                {t('overview.title')}
              </CardTitle>
              <CardDescription>{t('overview.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <dl>
                <dt className="text-xs font-medium uppercase text-muted-foreground">
                  {t('overview.id')}
                </dt>
                <dd className="mt-1 truncate font-mono text-sm">{session.organizationId}</dd>
              </dl>
            </CardContent>
          </Card>

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

    // Live overview is best-effort — never block the section on a WorkOS hiccup.
    let overview: OrganizationOverview | null = null
    try {
      overview = await getOrganizationOverview(session.organizationId)
    } catch {
      overview = null
    }
    // Grid-side settings are best-effort too — a Grid-DB hiccup must degrade this
    // one card (a "could not load" note) rather than crash the whole section.
    let settings: Awaited<ReturnType<typeof getOrgSettings>> | null = null
    let settingsError = false
    try {
      settings = await getOrgSettings(session.organizationId)
    } catch {
      settingsError = true
    }

    const createdLabel = overview
      ? new Date(overview.createdAt).toLocaleDateString(locale, {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      : null

    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('sections.overview.title')} subtitle={t('sections.overview.subtitle')} />

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

        {(settings || settingsError) && (
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
                <p className="text-muted-foreground text-sm">{t('settings.loadError')}</p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    )
  })
}
