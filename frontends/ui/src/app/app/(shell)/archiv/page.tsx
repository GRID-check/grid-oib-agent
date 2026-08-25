/**
 * Org-wide Archiv — a top-level document store that lives ABOVE projects and is
 * shared by every project in the organization (ADR-0024). Dark-launched behind
 * the `organization-archiv` gate; reachable by any org member, with uploads and
 * deletes gated on `org:archiv:manage`.
 */

import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { canManageArchiv } from '@/lib/authz/organizations'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findProjectInOrg } from '@/lib/projects/repository'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { resolveActiveProjectId } from '@/lib/collection-scope-request'
import { BackLink, ShellContent } from '@/components/shell'
import { getTranslations } from '@/i18n/server'
import { ArchivWorkspace } from '@/features/documents/components/archiv-workspace'
import { resolveArchivBackLink } from '@/features/documents/archiv-back-link'

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

    const t = await getTranslations('archiv')
    const canManage = canManageArchiv(session)
    const showMetadataPanel = isFeatureEnabled(session, FEATURE_FLAGS.filesMetadataPanel)

    // The Archiv lives above projects, so entering it drops the user's project
    // context. The back control prefers the tab's own return trail (see
    // {@link BackLink}); this server-resolved link is what it falls back to when
    // there is no trail to read — the reader's active project when we can reach
    // it, failing open to the all-projects listing when that id is unset, stale,
    // or no longer accessible, so the fallback never dead-ends either.
    const activeProjectId = await resolveActiveProjectId(session)
    let backProject: { id: string; name?: string | null } | undefined
    if (activeProjectId) {
      try {
        await requireProjectAccess(session, activeProjectId, 'project:view')
        // Named only after the access check, never before: a project's name is
        // exactly the read ADR-0038 withholds from a member without
        // `project:view`. A missing row (soft-deleted) still yields a link, just
        // an unnamed one.
        const project = await findProjectInOrg(activeProjectId, session.organizationId)
        backProject = { id: activeProjectId, name: project?.name }
      } catch {
        backProject = undefined
      }
    }
    const backLink = resolveArchivBackLink(backProject)

    return (
      // `wide` + `fill`: the library is a card grid that owns its own scrolling,
      // so the column fills the shell's `<main>` and the sheet inside it
      // scrolls. The frame supplies the `<main>` landmark and the page
      // background; this page adds neither.
      <ShellContent width="wide" fill className="pb-4 md:pb-6">
        {/* The Archiv's own title sits in the first band of the sheet below,
            beside the count and the upload control it belongs with (see
            {@link ArchivWorkspace}). Naming it again out here was a second
            header for one page. */}
        <div className="shrink-0 pb-4">
          <BackLink
            fallbackHref={backLink.href}
            fallbackLabel={t(
              backLink.labelKey,
              backLink.name ? { name: backLink.name } : undefined
            )}
          />
        </div>
        {/* The library reads as one sheet lifted off the page: hairline border,
            soft elevation, and the same fade-and-rise entrance the rest of the
            app opens surfaces with, so arriving here settles instead of
            snapping. */}
        <div className="animate-in fade-in-0 slide-in-from-bottom-1 shadow-xs min-h-0 flex-1 overflow-hidden rounded-xl border duration-300 ease-out motion-reduce:animate-none">
          <ArchivWorkspace canManage={canManage} showMetadataPanel={showMetadataPanel} />
        </div>
      </ShellContent>
    )
  })
}
