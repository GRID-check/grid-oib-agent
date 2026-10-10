import type { JSX } from 'react'
import { type Metadata } from 'next'
import { withPageSession } from '@/lib/auth/require-auth'
import { getTranslations } from '@/i18n/server'
import { getSimilarProjects } from '@/lib/references/service'
import { SimilarProjects } from '@/features/references/components/similar-projects'

interface ReferencesPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.referenzen') }
}

/**
 * The closed projects most like this one that the person may open. The service
 * owns the access (`project:view` on this project, and what each reference
 * shows); the page only asks and draws.
 */
export default async function ReferencesPage({ params }: ReferencesPageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    const page = await getSimilarProjects(session, id)
    return <SimilarProjects projectId={id} page={page} />
  })
}
