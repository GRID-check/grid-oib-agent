import type { JSX } from 'react'
import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { isProjectKnowledgePageEnabled } from '@/lib/authz/feature-flags'
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
  return withPageSession(async (session) => {
    // Feature-flagged rollout (default off): the page 404s like it doesn't
    // exist rather than teasing a locked section.
    if (!isProjectKnowledgePageEnabled(session)) {
      notFound()
    }
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')

    return <KnowledgeBasePanel projectId={id} />
  })
}
