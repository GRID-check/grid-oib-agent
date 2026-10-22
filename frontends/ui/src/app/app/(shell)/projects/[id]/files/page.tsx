import type { JSX } from 'react'
import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { can } from '@/lib/authz/decide'
import {
  isCollaborationEnabled,
  isInboundMailEnabled,
  isMailImportEnabled,
  isIfcModelsEnabled,
} from '@/lib/authz/feature-flags'
import { requireMailReviewer } from '@/lib/inbound-mail/access'
import { findProjectInOrg } from '@/lib/projects/repository'
import { listProjectFolders, projectRootAccess } from '@/lib/projects/folder-service'
import { listDocumentsPage } from '@/lib/documents/service'
import { DOCUMENT_LEVEL_PAGE_SIZE } from '@/lib/documents/list-query'
import { summarizeDocumentVersions } from '@/lib/documents/lifecycle'
import { resolveDocumentLifecyclePermissions } from '@/lib/documents/lifecycle-permissions'
import { toDocumentWireRow, toFolderWireRow } from '@/lib/documents/list-projection'
import { getTranslations } from '@/i18n/server'
import { ProjectFileWorkspace } from '@/features/documents/components/project-file-workspace'

interface FilesPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** A folder id as `?folder=` carries it; anything else is not a level the server can seed. */
const FOLDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.files') }
}

export default async function FilesPage({ params, searchParams }: FilesPageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    const { folder } = await searchParams
    const folderParam = typeof folder === 'string' ? folder.trim() : ''
    // The level the URL names, which the workspace opens on (`useFolderParam`).
    // A `?folder=` that is no folder id seeds nothing: the workspace reads it.
    const seedLevel = folderParam === '' || FOLDER_ID.test(folderParam)
    const initialFolderId = folderParam === '' || !seedLevel ? null : folderParam
    await requireProjectAccess(session, id, 'project:view')

    const project = await findProjectInOrg(id, session.organizationId)

    if (!project) {
      notFound()
    }

    // The model viewer lives inside this page now (there is no `/model` route
    // any more — it redirects here). The org flag no longer hides a
    // destination; it decides whether the model surfaces exist at all for this
    // tenant, which is the honest behaviour for one whose BIM endpoints would
    // refuse the request anyway.
    const showModels = isIfcModelsEnabled(session)

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
    // The FIRST page of the folder level the URL names, newest first, exactly
    // as the workspace's own first request would read it (ADR-0102). The
    // workspace reads further pages of the level when the reader scrolls to
    // them, from this page's `nextCursor` (`initialNextCursor`); it never
    // drains the shelf for the first paint.
    const [initialFolders, { documents: initialDocuments, nextCursor }] = await Promise.all([
      listProjectFolders(id, session),
      seedLevel
        ? listDocumentsPage(session, id, {
            level: { folderId: initialFolderId, sort: 'added', dir: 'desc', limit: DOCUMENT_LEVEL_PAGE_SIZE },
          })
        : Promise.resolve<Awaited<ReturnType<typeof listDocumentsPage>>>({ documents: [], nextCursor: null }),
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
    // (ADR-0087); the access route asks the same question again.
    // Who may decide the project's held mail sees the E-Mail-Eingang's entry
    // and its count (ADR-0134); the gate is the feature's own, asked once here.
    const inboundMailEnabled =
      isInboundMailEnabled(session) && (await requireMailReviewer(session, id).then(() => true, () => false))
    const [versionSummaries, lifecyclePermissions, canManageFolderAccess, initialRootAccess] = await Promise.all([
      summarizeDocumentVersions(
        session.organizationId,
        initialDocuments.map((row) => row.id),
      ),
      resolveDocumentLifecyclePermissions(session, id),
      can(session, 'project:manage', { type: 'project', id }),
      // What the reader may do at the project root (ADR-0088); each folder row
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
        initialFiles={
          seedLevel
            ? initialDocuments.map((row) => toDocumentWireRow(row, versionSummaries.get(row.id)))
            : undefined
        }
        initialNextCursor={nextCursor}
        initialFolderId={initialFolderId}
        projectName={project.name}
        collectionName={project.collectionName}
        showModels={showModels}
        canCollaborate={isCollaborationEnabled(session)}
        currentUserId={session.userId}
        mailImportEnabled={isMailImportEnabled(session)}
        inboundMailEnabled={inboundMailEnabled}
      />
    )
  })
}
