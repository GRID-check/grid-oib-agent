/**
 * Profile / account settings.
 *
 * A single place to manage identity, appearance (theme), interface language,
 * and session/security. Account identity is read from the WorkOS session on
 * the server; the interactive preference controls render in a client island
 * ({@link ProfileControls}).
 */

import { type JSX } from 'react'
import Link from 'next/link'
import { ArrowLeft, Building2, UserRound } from 'lucide-react'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { getNavFlags } from '@/lib/authz/nav'
import { OrgTopbar } from '@/components/shell'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { getTranslations } from '@/i18n/server'
import type { Translator } from '@/i18n'
import { getOrgSettings, getOrganizationOverview } from '@/lib/organizations/service'
import { ProfileControls } from './profile-controls'

const isAuthRequired = (): boolean => process.env.REQUIRE_AUTH?.toLowerCase() === 'true'

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
  const session = await requireAuthorizedPageSession()
  const navFlags = await getNavFlags(session)
  const t = await getTranslations('profile')

  const displayName = session.name || session.email || t('account.noName')
  const initial = String(displayName).charAt(0).toUpperCase()

  const organizationName = session.organizationId
    ? await resolveOrganizationName(session.organizationId)
    : t('account.noOrganization')

  return (
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

        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </header>

        <div className="flex flex-col gap-6">
          {/* Account */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserRound className="size-4 text-muted-foreground" aria-hidden />
                {t('account.title')}
              </CardTitle>
              <CardDescription>{t('account.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                <Avatar className="size-12">
                  {session.profilePictureUrl && <AvatarImage src={session.profilePictureUrl} alt="" />}
                  <AvatarFallback className="text-base font-medium">{initial}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="truncate text-base font-medium">{displayName}</p>
                  {session.email && (
                    <p className="truncate text-sm text-muted-foreground">{session.email}</p>
                  )}
                </div>
              </div>

              <dl className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase text-muted-foreground">
                    {t('account.name')}
                  </dt>
                  <dd className="mt-1 text-sm">{session.name || t('account.noName')}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase text-muted-foreground">
                    {t('account.email')}
                  </dt>
                  <dd className="mt-1 truncate text-sm">{session.email || t('account.noName')}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase text-muted-foreground">
                    {t('account.organization')}
                  </dt>
                  <dd className="mt-1 flex items-center gap-1.5 text-sm">
                    <Building2 className="size-3.5 text-muted-foreground" aria-hidden />
                    <span className="truncate" title={session.organizationId ?? undefined}>
                      {organizationName}
                    </span>
                  </dd>
                </div>
                {session.role && (
                  <div>
                    <dt className="text-xs font-medium uppercase text-muted-foreground">
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
}
