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

import type { JSX } from 'react'
import { withPageSession } from '@/lib/auth/require-auth'
import {
  canManageMembers,
  canManageModels,
  canViewAuditLogs,
  isOrgAdmin,
} from '@/lib/authz/organizations'
import { BackLink, ShellContent } from '@/components/shell'
import { getTranslations } from '@/i18n/server'
import {
  OrganizationNav,
  type OrganizationSectionKey,
} from '@/features/organization/components/organization-nav'

export default async function OrganizationLayout({
  children,
}: {
  children: React.ReactNode
}): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const t = await getTranslations('organization')

    // Capability flags decide the nav, exactly as they decide each route: a custom
    // role holding a single granular permission (e.g. org:models:manage) sees that
    // one section and nothing else. Order is irrelevant here — the nav owns it.
    // Storage joins the overview and budgets as a section every member sees:
    // a member whose upload was just refused needs to be able to find out why,
    // and the quota itself is only editable with `org:settings:manage`.
    const sections: OrganizationSectionKey[] = ['overview', 'budgets', 'storage']
    if (canManageMembers(session)) sections.push('access')
    if (canManageModels(session)) sections.push('models')
    // Audit-view ONLY, matching `/api/organization/audit-portal`, which gates on
    // `org:audit:view`. The compliance section is currently just that viewer, so
    // admitting `org:compliance:manage` here would show a button whose API answers
    // 403. Widen this the day the section grows holds/deletion UI of its own.
    if (canViewAuditLogs(session)) sections.push('compliance')
    if (isOrgAdmin(session)) sections.push('enterprise')

    return (
      <ShellContent>
        <BackLink
          className="touch-target mb-6"
          fallbackHref="/app/projects"
          fallbackLabel={t('backToApp')}
        />
        {/* Rail beside the content from `lg`; stacked strip below that. */}
        <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
          <div className="lg:w-52 lg:shrink-0">
            <OrganizationNav sections={sections} />
          </div>
          <div className="animate-in fade-in-0 slide-in-from-bottom-1 min-w-0 flex-1 duration-base ease-entrance motion-reduce:animate-none">
            {children}
          </div>
        </div>
      </ShellContent>
    )
  })
}
