import type { JSX } from 'react'
import { type Metadata } from 'next'
import { withPageSession } from '@/lib/auth/require-auth'
import { getSimilarProjects } from '@/lib/references/service'
import { SimilarProjects } from '@/features/references/components/similar-projects'
import { getTranslations } from '@/i18n/server'

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings')
  return { title: t('project.nav.references') }
}

/**
 * Hub → Similar projects: the closed projects most like this one that the
 * person may open (ADR-0094). The service owns the access (`project:view` on
 * this project, and what each reference shows); the page only asks and draws.
 */
export default async function ProjectReferencesPage({ params }: PageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    const projects = await getSimilarProjects(session, id)
    return <SimilarProjects projects={projects} />
  })
}
