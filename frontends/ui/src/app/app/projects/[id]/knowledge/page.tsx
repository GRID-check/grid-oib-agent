import { type Metadata } from 'next'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getTranslations } from '@/i18n/server'
import { KnowledgeBasePanel } from '@/features/knowledge/components/knowledge-base-panel'

interface KnowledgePageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.knowledge') }
}

export default async function KnowledgePage({ params }: KnowledgePageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const { id } = await params
  await requireProjectAccess(session, id, 'project:view')

  return <KnowledgeBasePanel projectId={id} />
}
