import { type Metadata } from 'next'
import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { ProjectHistory } from '@/features/projects/components/project-history'
import { getTranslations } from '@/i18n/server'

interface ProjectHistoryPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.history') }
}

/**
 * Project History (spec §5, FB-10) — one page over the two existing stores:
 * the project's conversations (the same BFF list the sessions panel hydrates
 * from) and the server-truth deep-research runs list. Rows deep-link back
 * into chat (`?session=` / `?job=`), reusing the chat page's existing URL
 * loaders — no new data model, no new API.
 */
export default async function ProjectHistoryPage({ params }: ProjectHistoryPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:view')

  const t = await getTranslations('nav')

  // The research-runs list scopes its fetch to this project's Qdrant
  // collection — same lookup the legacy research page performed.
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
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('sections.history')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('history.subtitle')}</p>
      </header>
      <ProjectHistory projectId={id} projectCollection={project.collectionName} />
    </div>
  )
}
