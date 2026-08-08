import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getTranslations } from '@/i18n/server'
import { IfcModelWorkspace } from '@/features/bim/components/ifc-model-workspace'

interface ModelPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.model') }
}

export default async function ModelPage({ params }: ModelPageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')

    // 404 rather than a disabled page when the org does not have the feature:
    // the nav entry is already hidden, so a reachable-but-empty page would only
    // advertise something the tenant cannot use.
    if (!isFeatureEnabled(session, FEATURE_FLAGS.ifcModels)) notFound()

    const project = await findProjectInOrg(id, session.organizationId)
    if (!project) notFound()

    return <IfcModelWorkspace projectId={id} />
  })
}
