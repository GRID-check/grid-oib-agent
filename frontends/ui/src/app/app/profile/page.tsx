/**
 * Profile / account settings.
 *
 * A single place to manage identity, appearance (theme), interface language,
 * and session/security. Account identity is read from the WorkOS session on
 * the server; the interactive preference controls render in a client island
 * ({@link ProfileControls}).
 */

import Link from 'next/link'
import { ArrowLeft, Building2, UserRound } from 'lucide-react'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { getNavFlags } from '@/lib/authz/nav'
import { OrgTopbar } from '@/components/shell'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { getTranslations } from '@/i18n/server'
import { ProfileControls } from './profile-controls'

const isAuthRequired = (): boolean => process.env.REQUIRE_AUTH?.toLowerCase() === 'true'

export default async function ProfilePage(): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const navFlags = await getNavFlags(session)
  const t = await getTranslations('profile')

  const displayName = session.name || session.email || t('account.noName')
  const initial = String(displayName).charAt(0).toUpperCase()

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <OrgTopbar
        user={{ name: session.name, email: session.email }}
        authRequired={isAuthRequired()}
        heading={t('title')}
        canManageOrganization={navFlags.canManageOrganization}
        canManagePlatform={navFlags.canManagePlatform}
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
                    {session.organizationId || t('account.noOrganization')}
                  </dd>
                </div>
                {session.role && (
                  <div>
                    <dt className="text-xs font-medium uppercase text-muted-foreground">
                      {t('account.role')}
                    </dt>
                    <dd className="mt-1 text-sm">{session.role}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>

          <ProfileControls authRequired={isAuthRequired()} email={session.email} />
        </div>
      </main>
    </div>
  )
}
