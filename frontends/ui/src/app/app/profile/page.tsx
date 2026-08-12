/**
 * Profile / account settings.
 *
 * A single place to manage identity, appearance (theme), interface language,
 * and session/security. Account identity is read from the WorkOS session on
 * the server; the interactive preference controls render in a client island
 * ({@link ProfileControls}).
 */

import { Building2, UserRound } from 'lucide-react'
import { withPageSession } from '@/lib/auth/require-auth'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { getNavFlags } from '@/lib/authz/nav'
import { BackLink, OrgTopbar } from '@/components/shell'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import type { Translator } from '@/i18n'
import { getOrgSettings, getOrganizationOverview } from '@/lib/organizations/service'
import { ProfileControls } from './profile-controls'
import { isAuthRequired } from '@/lib/auth/auth-required'

const KNOWN_ROLE_SLUGS = new Set(['org-platform-owner', 'admin', 'member'])

/**
 * Turn an unknown WorkOS role slug into a readable label: drop an `org-`
 * prefix and title-case the words (`org-billing-admin` → `Billing Admin`).
 */
const humanizeRoleSlug = (slug: string): string =>
  slug
    .replace(/^org-/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || slug

/** Localized role label, falling back to a humanized slug for unknown roles. */
const roleLabel = (slug: string, t: Translator): string =>
  KNOWN_ROLE_SLUGS.has(slug) ? t(`account.roles.${slug}`) : humanizeRoleSlug(slug)

/**
 * Best-effort organization display name. Prefers the Grid-side display name,
 * falls back to the WorkOS org name, and finally the raw id — never throws, so
 * a lookup failure degrades gracefully instead of crashing the page.
 */
const resolveOrganizationName = async (organizationId: string): Promise<string> => {
  try {
    const settings = await getOrgSettings(organizationId)
    if (settings.displayName) return settings.displayName
  } catch {
    // Non-fatal — fall through to the WorkOS lookup.
  }
  try {
    const overview = await getOrganizationOverview(organizationId)
    if (overview.name) return overview.name
  } catch {
    // Non-fatal — fall through to the raw id.
  }
  return organizationId
}

export default async function ProfilePage(): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const navFlags = await getNavFlags(session)
    const t = await getTranslations('profile')

    const displayName = session.name || session.email || t('account.noName')
    const initial = String(displayName).charAt(0).toUpperCase()

    const organizationName = session.organizationId
      ? await resolveOrganizationName(session.organizationId)
      : t('account.noOrganization')

    return (
      <div className="bg-background text-foreground flex min-h-dvh flex-col">
        <OrgTopbar
          user={{ name: session.name, email: session.email }}
          authRequired={isAuthRequired()}
          heading={t('title')}
          canManageOrganization={navFlags.canManageOrganization}
          canViewOrganization={navFlags.canViewOrganization}
          canManagePlatform={navFlags.canManagePlatform}
          canAccessArchiv={navFlags.canAccessArchiv}
          canAccessInbox={navFlags.canAccessInbox}
        />

        <main
          id="main-content"
          className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 md:px-8 md:py-10"
        >
          <BackLink
            className="touch-target mb-6"
            fallbackHref="/app/projects"
            fallbackLabel={t('backToApp')}
          />

          <PageHeader className="mb-8" title={t('title')} subtitle={t('subtitle')} />

          <div className="flex flex-col gap-6">
            {/* Account */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UserRound className="text-muted-foreground size-4" aria-hidden />
                  {t('account.title')}
                </CardTitle>
                <CardDescription>{t('account.description')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4">
                  <Avatar className="size-12">
                    {session.profilePictureUrl && (
                      <AvatarImage src={session.profilePictureUrl} alt="" />
                    )}
                    <AvatarFallback className="text-base font-medium">{initial}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate text-base font-medium">{displayName}</p>
                    {session.email && (
                      <p className="text-muted-foreground truncate text-sm">{session.email}</p>
                    )}
                  </div>
                </div>

                <dl className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground text-xs font-medium uppercase">
                      {t('account.name')}
                    </dt>
                    <dd className="mt-1 text-sm">{session.name || t('account.noName')}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs font-medium uppercase">
                      {t('account.email')}
                    </dt>
                    <dd className="mt-1 truncate text-sm">
                      {session.email || t('account.noName')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs font-medium uppercase">
                      {t('account.organization')}
                    </dt>
                    <dd className="mt-1 flex items-center gap-1.5 text-sm">
                      <Building2 className="text-muted-foreground size-3.5" aria-hidden />
                      <span className="truncate" title={session.organizationId ?? undefined}>
                        {organizationName}
                      </span>
                    </dd>
                  </div>
                  {session.role && (
                    <div>
                      <dt className="text-muted-foreground text-xs font-medium uppercase">
                        {t('account.role')}
                      </dt>
                      <dd className="mt-1 text-sm" title={session.role}>
                        {roleLabel(session.role, t)}
                      </dd>
                    </div>
                  )}
                </dl>
              </CardContent>
            </Card>

            <ProfileControls
              authRequired={isAuthRequired()}
              email={session.email}
              shortcutsAvailable={isFeatureEnabled(session, FEATURE_FLAGS.keyboardShortcuts)}
            />
          </div>
        </main>
      </div>
    )
  })
}
