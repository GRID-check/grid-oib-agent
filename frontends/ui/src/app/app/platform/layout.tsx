/**
 * Platform dashboard shell (ADR-0016) — exclusive to the platform owner.
 *
 * The owner gate, the shell chrome and the section nav live here, so every
 * subsection inherits them and none can forget the gate. Previously the whole
 * tier was one page stacking seven admin domains in a single scrolling column;
 * each is now its own route under this layout.
 *
 * Server-gated by isPlatformOwner (GRID Platform org membership with the
 * org-platform-owner role, or the break-glass env allowlist). Non-owners get
 * an explanatory card, mirroring the org page's non-admin experience.
 */

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, ShieldAlert } from 'lucide-react'
import { getGridSession } from '@/lib/auth/session'
import { runWithTenantSlot } from '@/lib/db/tenant-context'
import { getNavFlags } from '@/lib/authz/nav'
import { OrgTopbar } from '@/components/shell'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getTranslations } from '@/i18n/server'
import { PlatformNav } from '@/features/platform/components/platform-nav'
import { isAuthRequired } from '@/lib/auth/auth-required'


export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode
}): Promise<JSX.Element> {
  return runWithTenantSlot(async () => {
    // Deliberately NOT requireAuthorizedPageSession: the break-glass owner of a
    // fresh environment may hold zero org memberships and must still reach this
    // page (the org-onboarding redirect would lock them out — ADR-0016).
    const session = await getGridSession()
    if (!session && isAuthRequired()) {
      redirect('/')
    }
    const navFlags = await getNavFlags(session)
    const t = await getTranslations('platform')
    const tOrg = await getTranslations('organization')

    const shell = (body: React.ReactNode): JSX.Element => (
      <div className="bg-background text-foreground flex min-h-dvh flex-col">
        <OrgTopbar
          user={{ name: session?.name, email: session?.email }}
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
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-10"
        >
          <Link
            href="/app/projects"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 mb-6 inline-flex items-center gap-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {tOrg('backToApp')}
          </Link>
          {body}
        </main>
      </div>
    )

    if (!navFlags.canManagePlatform) {
      return shell(
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="text-muted-foreground size-4" aria-hidden />
              {t('notOwner.title')}
            </CardTitle>
            <CardDescription>{t('notOwner.description')}</CardDescription>
          </CardHeader>
        </Card>
      )
    }

    return shell(
      // Rail beside the content from `lg`; stacked strip below that.
      <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
        <div className="lg:w-52 lg:shrink-0">
          <PlatformNav />
        </div>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    )
  })
}
