/**
 * Org-wide Archiv — a top-level document store that lives ABOVE projects and is
 * shared by every project in the organization (ADR-0024). Dark-launched behind
 * the `organization-archiv` gate; reachable by any org member, with uploads and
 * deletes gated on `org:archiv:manage`.
 */

import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { withPageSession } from '@/lib/auth/require-auth'
import { getNavFlags } from '@/lib/authz/nav'
import { canManageArchiv } from '@/lib/authz/organizations'
import { requireProjectAccess } from '@/lib/authz/projects'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { resolveActiveProjectId } from '@/lib/collection-scope-request'
import { OrgTopbar } from '@/components/shell'
import { getTranslations } from '@/i18n/server'
import { ArchivWorkspace } from '@/features/documents/components/archiv-workspace'
import { resolveArchivBackLink } from '@/features/documents/archiv-back-link'
import { isAuthRequired } from '@/lib/auth/auth-required'


export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('archiv')
  return { title: t('title') }
}

export default async function ArchivPage(): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    // Feature-flag gate — an org without the flag gets a 404.
    if (!isFeatureEnabled(session, FEATURE_FLAGS.orgArchiv)) {
      notFound()
    }

    const navFlags = await getNavFlags(session)
    const t = await getTranslations('archiv')
    const canManage = canManageArchiv(session)
    const showMetadataPanel = isFeatureEnabled(session, FEATURE_FLAGS.filesMetadataPanel)

    // The Archiv lives above projects, so entering it drops the user's project
    // context. Return them to the project they came from (their active project)
    // when we can — fail open to the all-projects listing when the active project
    // is unset, stale, or no longer accessible (it can go stale, and is never
    // cleaned up), so the back-link never dead-ends.
    let backProjectId = await resolveActiveProjectId(session)
    if (backProjectId) {
      try {
        await requireProjectAccess(session, backProjectId, 'project:view')
      } catch {
        backProjectId = undefined
      }
    }
    const backLink = resolveArchivBackLink(backProjectId)

    return (
      <div className="flex h-dvh flex-col bg-background text-foreground">
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
        {/* Wider than the org settings column: the library card grid needs room. */}
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col overflow-hidden px-4 pb-4 md:px-8 md:pb-6">
          <Link
            href={backLink.href}
            className="my-3 inline-flex items-center gap-1.5 self-start text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {t(backLink.labelKey)}
          </Link>
          <main id="main-content" className="flex-1 overflow-hidden rounded-xl border">
            <ArchivWorkspace canManage={canManage} showMetadataPanel={showMetadataPanel} />
          </main>
        </div>
      </div>
    )
  })
}
