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

import { redirect } from 'next/navigation'
import { ShieldAlert } from 'lucide-react'
import { getGridSession } from '@/lib/auth/session'
import { runWithTenantSlot } from '@/lib/db/tenant-context'
import { getNavFlags } from '@/lib/authz/nav'
import { BackLink, ShellContent } from '@/components/shell'
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
      <ShellContent>
        <BackLink className="mb-6" fallbackHref="/app/projects" fallbackLabel={tOrg('backToApp')} />
        {body}
      </ShellContent>
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
        <div className="animate-in fade-in-0 slide-in-from-bottom-1 min-w-0 flex-1 duration-200 ease-out motion-reduce:animate-none">
          {children}
        </div>
      </div>
    )
  })
}
