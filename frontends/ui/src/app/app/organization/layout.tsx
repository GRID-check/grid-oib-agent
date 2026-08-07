/**
 * Organization tier shell (ADR-0016).
 *
 * The chrome, the "back to projects" way out and the section nav live here, so
 * every subsection inherits them and none can forget them. The tier used to be
 * one page stacking settings, members, models, BYOK, budgets and the audit trail
 * in a single scrolling column; each is now its own route under this layout.
 *
 * Deliberately NOT a gate. Two of the sections — the overview and a member's own
 * usage — are open to anyone in the organization, so blocking here would lock
 * plain members out of the surface the app's Organization nav entry sends them
 * to. Each route carries its own permission check, and the nav below is handed
 * only the sections this session can actually reach, so nobody is offered a link
 * that answers 403.
 */

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { withPageSession } from '@/lib/auth/require-auth'
import { getNavFlags } from '@/lib/authz/nav'
import {
  canManageMembers,
  canManageModels,
  canViewAuditLogs,
  isOrgAdmin,
} from '@/lib/authz/organizations'
import { OrgTopbar } from '@/components/shell'
import { getTranslations } from '@/i18n/server'
import {
  OrganizationNav,
  type OrganizationSectionKey,
} from '@/features/organization/components/organization-nav'
import { isAuthRequired } from '@/lib/auth/auth-required'


export default async function OrganizationLayout({
  children,
}: {
  children: React.ReactNode
}): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const navFlags = await getNavFlags(session)
    const t = await getTranslations('organization')

    // Capability flags decide the nav, exactly as they decide each route: a custom
    // role holding a single granular permission (e.g. org:models:manage) sees that
    // one section and nothing else. Order is irrelevant here — the nav owns it.
    const sections: OrganizationSectionKey[] = ['overview', 'budgets']
    if (canManageMembers(session)) sections.push('access')
    if (canManageModels(session)) sections.push('models')
    // Audit-view ONLY, matching `/api/organization/audit-portal`, which gates on
    // `org:audit:view`. The compliance section is currently just that viewer, so
    // admitting `org:compliance:manage` here would show a button whose API answers
    // 403. Widen this the day the section grows holds/deletion UI of its own.
    if (canViewAuditLogs(session)) sections.push('compliance')
    if (isOrgAdmin(session)) sections.push('enterprise')

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
          canCollaborate={navFlags.canCollaborate}
        />
        <main id="main-content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-10">
          <Link
            href="/app/projects"
            className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none touch-target"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {t('backToApp')}
          </Link>
          {/* Rail beside the content from `lg`; stacked strip below that. */}
          <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
            <div className="lg:w-52 lg:shrink-0">
              <OrganizationNav sections={sections} />
            </div>
            <div className="min-w-0 flex-1">{children}</div>
          </div>
        </main>
      </div>
    )
  })
}
