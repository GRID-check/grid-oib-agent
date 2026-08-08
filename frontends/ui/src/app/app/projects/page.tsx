import { withPageSession } from '@/lib/auth/require-auth'
import { getNavFlags } from '@/lib/authz/nav'
import { canManageCompliance } from '@/lib/authz/organizations'
import { getProjectsGridData } from '@/lib/projects/service'
import { ProjectsGrid } from '@/components/projects/projects-grid'
import { ArchivEntryCard } from '@/components/projects/archiv-entry-card'
import { OrgTopbar } from '@/components/shell'
import { RecentlyDeleted } from '@/features/projects/components/recently-deleted'
import { getTranslations } from '@/i18n/server'
import { isAuthRequired } from '@/lib/auth/auth-required'


interface ProjectsPageProps {
  searchParams: Promise<{ new?: string }>
}

export default async function ProjectsPage({ searchParams }: ProjectsPageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const navFlags = await getNavFlags(session)
    const { new: newParam } = await searchParams
    const t = await getTranslations('projects')

    // The page is transport: it resolves the session, asks the service for the
    // view, and renders. Tenancy scope, FGA filtering and the document counts all
    // belong to the service/repository pair behind this call — see
    // `getProjectsGridData`.
    const { projects: rows, documentCounts: docCountByProject } = await getProjectsGridData(session, 'oldest')

    const autoOpenCreate = newParam === '1'

    return (
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        <OrgTopbar
          user={{ name: session.name, email: session.email }}
          authRequired={isAuthRequired()}
          canManageOrganization={navFlags.canManageOrganization}
          canViewOrganization={navFlags.canViewOrganization}
          canManagePlatform={navFlags.canManagePlatform}
          canAccessArchiv={navFlags.canAccessArchiv}
          canAccessInbox={navFlags.canAccessInbox}
        />

        <main id="main-content" className="flex-1 px-6 pt-[34px] pb-10 md:px-10">
          <div className="mx-auto w-full max-w-[1080px]">
            <ProjectsGrid projects={rows} docCounts={docCountByProject} autoOpenCreate={autoOpenCreate} />

            {/* Org-wide Archiv entry — gated server-side on the `organization-archiv`
                flag, the same check the /app/archiv page enforces (ADR-0024). */}
            {navFlags.canAccessArchiv && (
              <section className="mt-6" aria-label={t('archivCard.title')}>
                <ArchivEntryCard />
              </section>
            )}

            <RecentlyDeleted canManageCompliance={canManageCompliance(session)} />
          </div>
        </main>
      </div>
    )
  })
}
