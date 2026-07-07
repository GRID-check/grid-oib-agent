import { eq } from 'drizzle-orm'
import { Users } from 'lucide-react'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { ProjectMembersForm } from '@/components/projects/project-members-form'
import { getTranslations } from '@/i18n/server'

interface ProjectMembersPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectMembersPage({ params }: ProjectMembersPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const { id } = await params
  const t = await getTranslations('members')

  // Read access is enough to view the roster; management controls are gated
  // separately (below) so editors/viewers get a dignified read-only view
  // instead of a hard crash.
  const { role } = await requireProjectAccess(session, id, 'project:view')
  const canManage = role === 'project-admin'

  const db = getDb()
  const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, id)).limit(1)

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-10">
      <header className="mb-10 flex items-start gap-4 border-b border-border pb-8">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-muted text-primary">
          <Users className="h-6 w-6" aria-hidden />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {t('header.eyebrow')}
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('header.title', { name: project?.name ?? t('header.projectFallback') })}
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {canManage ? t('header.descriptionManage') : t('header.descriptionReadOnly')}
          </p>
        </div>
      </header>
      <ProjectMembersForm projectId={id} canManage={canManage} />
    </div>
  )
}
