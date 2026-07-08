import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { ResearchRunsList } from '@/features/projects/components/research-runs-list'
import { getTranslations } from '@/i18n/server'

interface ProjectResearchPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectResearchPage({ params }: ProjectResearchPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:view')

  const t = await getTranslations('research')

  const db = getDb()
  const [project] = await db
    .select({ collectionName: projects.collectionName })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)

  if (!project) {
    notFound()
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-10">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('runsPage.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('runsPage.subtitle')}</p>
        </div>
      </header>
      <ResearchRunsList projectId={id} projectCollection={project.collectionName} />
    </div>
  )
}
