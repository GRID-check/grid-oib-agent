import { eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { Flex, Text } from '@/adapters/ui'

interface ProjectLayoutProps {
  children: React.ReactNode
  params: Promise<{ id: string }>
}

export default async function ProjectLayout({ children, params }: ProjectLayoutProps): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const { id } = await params
  const db = getDb()

  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)

  const projectName = project?.name ?? 'Project'

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="container mx-auto flex items-center justify-between px-4 py-3">
          <Text kind="body/bold/2xl" className="text-primary">
            {projectName}
          </Text>
          <Flex gap="3">
            <a
              href={`/projects/${id}`}
              className="rounded-lg border px-4 py-2 text-sm font-medium text-primary underline-offset-4 hover:bg-surface-raised-50"
            >
              Documents
            </a>
            <a
              href={`/projects/${id}/chat`}
              className="rounded-lg border px-4 py-2 text-sm font-medium text-primary underline-offset-4 hover:bg-surface-raised-50"
            >
              Chat
            </a>
            <a
              href={`/projects/${id}/members`}
              className="rounded-lg border px-4 py-2 text-sm font-medium text-primary underline-offset-4 hover:bg-surface-raised-50"
            >
              Members
            </a>
            <a
              href="/projects"
              className="rounded-lg border px-4 py-2 text-sm font-medium text-primary underline-offset-4 hover:bg-surface-raised-50"
            >
              All Projects
            </a>
          </Flex>
        </div>
      </header>
      {children}
    </div>
  )
}
