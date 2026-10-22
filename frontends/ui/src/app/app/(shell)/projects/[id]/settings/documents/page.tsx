import type { JSX } from 'react'
import { type Metadata } from 'next'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { isInboundMailEnabled, isProjectKnowledgePageEnabled } from '@/lib/authz/feature-flags'
import { requireMailReviewer } from '@/lib/inbound-mail/access'
import { findProjectInOrg } from '@/lib/projects/repository'
import { resolveProjectSettingsAccess } from '@/lib/projects/settings-access'
import { DocumentsSettings } from '@/features/projects/components/settings/documents-settings'
import { getTranslations } from '@/i18n/server'

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings')
  return { title: t('project.nav.documents') }
}

/** Settings → Documents & index: the upload record, the project mail address and the index behind answers. */
export default async function ProjectDocumentsSettingsPage({
  params,
}: PageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')

    const access = await resolveProjectSettingsAccess(session, id)
    // The address card, for whoever may decide the project's held mail (ADR-0134).
    const project =
      isInboundMailEnabled(session) && (await requireMailReviewer(session, id).then(() => true, () => false))
        ? await findProjectInOrg(id, session.organizationId)
        : null

    return (
      <DocumentsSettings
        projectId={id}
        currentUserId={session.userId}
        canReindex={access.writeDocuments}
        showKnowledgeLink={isProjectKnowledgePageEnabled(session)}
        inboundMail={project ? { projectName: project.name } : undefined}
      />
    )
  })
}
