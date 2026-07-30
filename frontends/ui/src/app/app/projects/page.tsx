import { and, asc, count, eq, isNull } from 'drizzle-orm'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { getNavFlags } from '@/lib/authz/nav'
import { canManageCompliance } from '@/lib/authz/organizations'
import { getDb } from '@/lib/db'
import { documents, projects } from '@/lib/db/schema'
import { ProjectsGrid } from '@/components/projects/projects-grid'
import { ArchivEntryCard } from '@/components/projects/archiv-entry-card'
import { OrgTopbar } from '@/components/shell'
import { RecentlyDeleted } from '@/features/projects/components/recently-deleted'
import { getTranslations } from '@/i18n/server'

const isAuthRequired = (): boolean => process.env.REQUIRE_AUTH?.toLowerCase() === 'true'

interface ProjectsPageProps {
  searchParams: Promise<{ new?: string }>
}

export default async function ProjectsPage({ searchParams }: ProjectsPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const navFlags = await getNavFlags(session)
  const { new: newParam } = await searchParams
  const t = await getTranslations('projects')
  const db = getDb()

  const rows = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, session.organizationId),
        isNull(projects.deletedAt),
      ),
    )
    .orderBy(asc(projects.createdAt))

  const docCounts = await db
    .select({ projectId: documents.projectId, total: count() })
    .from(documents)
    .where(eq(documents.organizationId, session.organizationId))
    .groupBy(documents.projectId)

  const docCountByProject: Record<string, number> = Object.fromEntries(
    docCounts.map((row) => [row.projectId, Number(row.total)]),
  )

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
        canCollaborate={navFlags.canCollaborate}
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
}
