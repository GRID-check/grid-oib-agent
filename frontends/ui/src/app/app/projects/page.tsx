import { and, asc, count, eq, isNull } from 'drizzle-orm'
import { FolderOpen } from 'lucide-react'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { getNavFlags } from '@/lib/authz/nav'
import { getDb } from '@/lib/db'
import { documents, projects } from '@/lib/db/schema'
import { ProjectsGrid } from '@/components/projects/projects-grid'
import { CreateProjectDialog } from '@/components/projects/create-project-dialog'
import { EmptyState } from '@/components/ui/empty-state'
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
        heading={t('list.heading')}
        canManageOrganization={navFlags.canManageOrganization}
        canViewOrganization={navFlags.canViewOrganization}
        canManagePlatform={navFlags.canManagePlatform}
      />

      <main id="main-content" className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 md:px-8 md:py-10">
        <header className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t('list.heading')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('list.description')}</p>
          </div>
          <CreateProjectDialog defaultOpen={autoOpenCreate} />
        </header>

        <section className="mt-8">
          {rows.length === 0 ? (
            <EmptyState
              icon={FolderOpen}
              title={t('list.empty.title')}
              description={t('list.empty.description')}
              action={<CreateProjectDialog label={t('list.empty.action')} />}
              className="min-h-96 justify-center"
            />
          ) : (
            <ProjectsGrid projects={rows} docCounts={docCountByProject} />
          )}
        </section>

        <RecentlyDeleted />
      </main>
    </div>
  )
}
