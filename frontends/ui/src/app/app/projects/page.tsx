import { asc, count, eq } from 'drizzle-orm'
import { FolderOpen } from 'lucide-react'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { documents, projects } from '@/lib/db/schema'
import { ProjectCard } from '@/components/projects/project-card'
import { CreateProjectDialog } from '@/components/projects/create-project-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { OrgTopbar } from '@/components/shell'

const isAuthRequired = (): boolean => process.env.REQUIRE_AUTH?.toLowerCase() === 'true'

interface ProjectsPageProps {
  searchParams: Promise<{ new?: string }>
}

export default async function ProjectsPage({ searchParams }: ProjectsPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const { new: newParam } = await searchParams
  const db = getDb()

  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.organizationId, session.organizationId))
    .orderBy(asc(projects.createdAt))

  const docCounts = await db
    .select({ projectId: documents.projectId, total: count() })
    .from(documents)
    .where(eq(documents.organizationId, session.organizationId))
    .groupBy(documents.projectId)

  const docCountByProject = new Map(docCounts.map((row) => [row.projectId, Number(row.total)]))

  const autoOpenCreate = newParam === '1'

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <OrgTopbar
        user={{ name: session.name, email: session.email }}
        authRequired={isAuthRequired()}
        heading="Projects"
      />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 md:px-8">
        <header className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Every building project in one calm workspace — documents, members, OIB/RIS research,
              and chat, grounded together.
            </p>
          </div>
          <CreateProjectDialog defaultOpen={autoOpenCreate} />
        </header>

        <section className="mt-8">
          {rows.length === 0 ? (
            <EmptyState
              icon={FolderOpen}
              title="Start your first project"
              description="Grid is an OIB/RIS building-compliance copilot. Create a project to bring its documents, members, and research into one workspace — then ask Grid questions grounded in Austrian building law."
              action={<CreateProjectDialog label="Create your first project" />}
              className="min-h-96 justify-center"
            />
          ) : (
            <div className="grid grid-cols-1 gap-6 animate-in fade-in-0 sm:grid-cols-2 xl:grid-cols-3">
              {rows.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  docCount={docCountByProject.get(project.id) ?? 0}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
