import type { JSX } from 'react'
import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { listFolderBin } from '@/lib/projects/folder-bin'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getTranslations } from '@/i18n/server'
import { FolderBinPanel } from '@/features/documents/components/folder-bin-panel'

interface BinPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('files')
  return { title: t('bin.title') }
}

/**
 * A project's Papierkorb (ADR-0085): the deleted folders the reader may read.
 * Read here so the first paint is the list; the panel re-reads after each
 * action.
 */
export default async function FolderBinPage({ params }: BinPageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')
    if (!(await findProjectInOrg(id, session.organizationId))) notFound()
    const listing = await listFolderBin(session, id).catch((error: unknown) => {
      console.error('[folder-bin] the Papierkorb could not be read:', error)
      return null
    })
    return (
      <FolderBinPanel
        projectId={id}
        initial={
          listing && {
            ...listing,
            entries: listing.entries.map((entry) => ({
              ...entry,
              deletedAt: entry.deletedAt.toISOString(),
              purgeAfter: entry.purgeAfter.toISOString(),
            })),
          }
        }
      />
    )
  })
}
