import type { JSX } from 'react'
import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { can } from '@/lib/authz/decide'
import {
  FEATURE_FLAGS,
  isCollaborationEnabled,
  isMailImportEnabled,
  isFeatureEnabled,
  isIfcModelsEnabled,
  isIfcPreviewFirstEnabled,
} from '@/lib/authz/feature-flags'
import { findProjectInOrg } from '@/lib/projects/repository'
import { listProjectFolders, projectRootAccess } from '@/lib/projects/folder-service'
import { listDocumentsPage } from '@/lib/documents/service'
import { summarizeDocumentVersions } from '@/lib/documents/lifecycle'
import { resolveDocumentLifecyclePermissions } from '@/lib/documents/lifecycle-permissions'
import { toDocumentWireRow, toFolderWireRow } from '@/lib/documents/list-projection'
import { getTranslations } from '@/i18n/server'
import { ProjectFileWorkspace } from '@/features/documents/components/project-file-workspace'

interface FilesPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.files') }
}

export default async function FilesPage({ params }: FilesPageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')

    const project = await findProjectInOrg(id, session.organizationId)

    if (!project) {
      notFound()
    }

    // Org-level gate for the ingestion-metadata block (WorkOS `files-metadata-panel`).
    // Fail-open when enforcement is off (isFeatureEnabled → true).
    const showMetadataPanel = isFeatureEnabled(session, FEATURE_FLAGS.filesMetadataPanel)

    // The model viewer lives inside this page now (there is no `/model` route
    // any more — it redirects here). The org flag no longer hides a
    // destination; it decides whether the model surfaces exist at all for this
    // tenant, which is the honest behaviour for one whose BIM endpoints would
    // refuse the request anyway.
    const showModels = isIfcModelsEnabled(session)

    // What a click on an `.ifc` DOES — preview first, or straight to the stage.
    // Read here AND in the Archiv sheet from the same helper, because the whole
    // point of the flag is that it moves both file surfaces together.
    const previewFirst = isIfcPreviewFirstEnabled(session)

    /*
     * THE LISTING, READ HERE INSTEAD OF AFTER HYDRATION.
     *
     * Dateien used to paint a skeleton, download and boot its JavaScript, and
     * only then ask for the folders and the documents — three round trips
     * stacked behind the bundle, on a page whose entire job is to show a list
     * this request could already have. The first thing anyone saw was a grid of
     * grey rectangles, for as long as the slowest of those took.
     *
     * Both reads run here, in parallel with each other, and the workspace is
     * handed the answers. They cost this request the slower of two queries it
     * would have served a moment later anyway; what they save is the whole
     * waterfall behind them. The client keeps every one of its own loaders —
     * they are what a filter change, a settling poll and a retry use — it
     * simply no longer needs one to see the corpus for the first time.
     *
     * `Promise.all` and not two awaits: the folder listing does not depend on
     * the document listing, and sequencing them here would rebuild in one tier
     * the waterfall this removes from the other.
     */
    // The FIRST page only: the paint needs rows now, not the whole corpus. The
    // workspace reads the remaining pages itself when `nextCursor` says there
    // are any (`initialFilesComplete`).
    const [initialFolders, { documents: initialDocuments, nextCursor }] = await Promise.all([
      listProjectFolders(id, session),
      listDocumentsPage(session, id),
    ])

    /*
     * The editorial state of every document in the listing, and what THIS
     * reader may do about it.
     *
     * Both ride with the first paint for the same reason the listing does: the
     * badge is part of the row, and the review controls are the answer to a
     * question the reader has already asked by opening the file. The permission
     * set is derived here — on the server, from `decide` — and handed down as
     * data; the client never guesses one, and a control it renders is one the
     * route would also allow.
     */
    // `project:manage` decides whether „Zugriff…" is offered on a folder
    // (ADR-0086); the access route asks the same question again.
    const [versionSummaries, lifecyclePermissions, canManageFolderAccess, initialRootAccess] = await Promise.all([
      summarizeDocumentVersions(
        session.organizationId,
        initialDocuments.map((row) => row.id),
      ),
      resolveDocumentLifecyclePermissions(session, id),
      can(session, 'project:manage', { type: 'project', id }),
      // What the reader may do at the project root (ADR-0087); each folder row
      // carries its own.
      projectRootAccess(session, id),
    ])

    return (
      <ProjectFileWorkspace
        lifecyclePermissions={lifecyclePermissions}
        projectId={id}
        initialFolders={initialFolders.map(toFolderWireRow)}
        canManageFolderAccess={canManageFolderAccess}
        initialRootAccess={initialRootAccess}
        initialFiles={initialDocuments.map((row) =>
          toDocumentWireRow(row, versionSummaries.get(row.id)),
        )}
        initialFilesComplete={nextCursor === null}
        projectName={project.name}
        collectionName={project.collectionName}
        showMetadataPanel={showMetadataPanel}
        showModels={showModels}
        previewFirst={previewFirst}
        canCollaborate={isCollaborationEnabled(session)}
        currentUserId={session.userId}
        mailImportEnabled={isMailImportEnabled(session)}
      />
    )
  })
}
