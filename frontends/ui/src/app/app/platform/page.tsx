/**
 * Platform dashboard (ADR-0016) — exclusive to the platform owner.
 *
 * Server-gated by isPlatformOwner (GRID Platform org membership with the
 * org-platform-owner role, or the break-glass env allowlist). Non-owners get
 * an explanatory card, mirroring the org page's non-admin experience.
 */

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, ShieldAlert } from 'lucide-react'
import { getGridSession } from '@/lib/auth/session'
import { getNavFlags } from '@/lib/authz/nav'
import { OrgTopbar } from '@/components/shell'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { BaseKnowledge } from './base-knowledge'
import { PlatformOverview } from './platform-overview'
import { VectorMaintenance } from './vector-maintenance'
import { AgentProfiler } from '@/features/platform/components/agent-profiler'
import { NormRegistry } from '@/features/platform/components/norm-registry'

const isAuthRequired = (): boolean => process.env.REQUIRE_AUTH?.toLowerCase() === 'true'

export default async function PlatformPage(): Promise<JSX.Element> {
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

  const shell = (children: React.ReactNode): JSX.Element => (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <OrgTopbar
        user={{ name: session?.name, email: session?.email }}
        authRequired={isAuthRequired()}
        heading={t('title')}
        canManageOrganization={navFlags.canManageOrganization}
        canViewOrganization={navFlags.canViewOrganization}
        canManagePlatform={navFlags.canManagePlatform}
        canAccessArchiv={navFlags.canAccessArchiv}
      />
      <main id="main-content" className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 md:px-8 md:py-10">
        <Link
          href="/app/projects"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {tOrg('backToApp')}
        </Link>
        {children}
      </main>
    </div>
  )

  if (!navFlags.canManagePlatform) {
    return shell(
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-muted-foreground" aria-hidden />
            {t('notOwner.title')}
          </CardTitle>
          <CardDescription>{t('notOwner.description')}</CardDescription>
        </CardHeader>
      </Card>,
    )
  }

  return shell(
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <PlatformOverview />
      <AgentProfiler />
      <BaseKnowledge />
      <NormRegistry />
      <VectorMaintenance />
    </div>,
  )
}
