'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { ProjectSectionActions } from '@/components/shell/project-section-frame'
import { createDocumentNameProbeClient } from '@/lib/documents/name-probe-client'
import { useTranslations } from '@/i18n'
import type { DocumentLifecyclePermission } from '@/lib/documents/lifecycle-types'
import { askAboutFile } from '../lib/ask-about-file'
import type { FileShelf } from '../lib/file-shelf'
import { projectEndpoints } from '../lib/file-shelf'
import type { DocumentWireRow } from '../lib/file-item'
import { useProjectDocuments } from '../hooks/use-project-documents'
import type { FolderItem } from '../file-types'
import { FileWorkspace } from './file-workspace'
import { MailImportAction } from './mail-import-action'

// The row and folder types live in `../file-types`; they are re-exported here
// because this is the name every importer already uses.
export type { FileAssignee, FileItem, FolderItem } from '../file-types'

interface ProjectFileWorkspaceProps {
  projectId: string
  projectName: string
  collectionName: string
  /**
   * Whether the file preview's ingestion-metadata block renders (WorkOS
   * `files-metadata-panel` flag, FB-8). Defaults to true so the feature stays
   * visible with flag enforcement off (fail-open).
   */
  showMetadataPanel?: boolean
  /**
   * Whether the model workspace is reachable (WorkOS `ifc-models`, ADR-0046).
   *
   * It decides the smallest of the things the flag has been: whether the preview
   * offers the way on to the stage. A click always opens the preview, and
   * `?model=` always opens the stage. Off by default, because a viewer whose
   * endpoints answer 403 is worse than no viewer.
   */
  showModels?: boolean
  /**
   * Whether a click on an `.ifc` opens the preview first (`ifc-preview-first`).
   * Defaults to preview-first, the safer direction to be wrong in. Threaded from
   * the page alongside the Archiv's copy of the same flag — the two surfaces
   * must move together.
   */
  previewFirst?: boolean
  /** Faces, Unvergeben, Zuweisen — behind the collaboration flag. */
  canCollaborate?: boolean
  currentUserId?: string
  /**
   * What this reader may do to a document's versions, resolved on the server
   * (`lib/documents/lifecycle-permissions.ts`, ADR-0054). Absent means the pane
   * shows no Freigabe section — never a guessed set.
   */
  lifecyclePermissions?: readonly DocumentLifecyclePermission[]
  /**
   * The folder tree and the corpus as the SERVER already read them, for the
   * first paint — see {@link FileWorkspace}. `initialFilesComplete` is false when
   * the server read only one bounded page.
   */
  initialFolders?: readonly FolderItem[]
  initialFiles?: readonly DocumentWireRow[]
  initialFilesComplete?: boolean
  /**
   * Whether this reader may change who may read and write a folder
   * (`project:manage`, resolved on the server, ADR-0087). Shows „Zugriff…" in the
   * folder menu; the route checks again.
   */
  canManageFolderAccess?: boolean
  /**
   * What the reader may do at the project root, as the server read it for the
   * first paint (ADR-0087). Absent means `write`; the folder listing refreshes it.
   */
  initialRootAccess?: 'read' | 'write'
  /** Whether the Outlook archive import is offered (`isMailImportEnabled`, ADR-0085). Off by default. */
  mailImportEnabled?: boolean
}

/**
 * A project's Dateien: {@link FileWorkspace} over the project's shelf.
 *
 * Everything this adds is a fact about a PROJECT: the shelf's endpoints, the
 * project's chat (so a file can be asked about), collaboration, per-role folder
 * access (ADR-0087), the preview the project shell hosts, and the section header
 * the controls portal into.
 */
export function ProjectFileWorkspace({
  projectId,
  projectName,
  collectionName,
  showMetadataPanel = true,
  showModels = false,
  previewFirst = true,
  canCollaborate = false,
  currentUserId,
  lifecyclePermissions,
  initialFolders,
  initialFiles,
  initialFilesComplete = true,
  canManageFolderAccess = false,
  initialRootAccess = 'write',
  mailImportEnabled = false,
}: ProjectFileWorkspaceProps) {
  const t = useTranslations('files')
  const router = useRouter()
  const probe = useMemo(() => createDocumentNameProbeClient(), [])

  const shelf: FileShelf = {
    source: 'project',
    documentScope: 'files',
    endpoints: projectEndpoints(projectId),
    projectId,
    collectionName,
    canManage: true,
    folderAccess: { projectId, canManage: canManageFolderAccess, initialRootAccess },
    canCollaborate,
    currentUserId,
    askAbout: (file) => askAboutFile({ projectId, file, navigate: (href) => router.push(href) }),
    useUpload: ({ collectionName: collection, folderId, onComplete }) =>
      useProjectDocuments({ projectId, collectionName: collection, folderId, onComplete }),
    probeNames: (names) => probe.project(projectId, names),
    handoverKey: projectId,
    preview: { kind: 'store', projectName },
    messages: {
      dropToUpload: t('workspace.dropToUpload'),
      ingestionComplete: (name) => t('toast.ingestionComplete', { name }),
    },
    showMetadataPanel,
    showModels,
    previewFirst,
    lifecyclePermissions,
  }

  return (
    <FileWorkspace
      shelf={shelf}
      renderHeader={(controls) => (
        <ProjectSectionActions>
          {controls}
          {mailImportEnabled && <MailImportAction projectId={projectId} />}
        </ProjectSectionActions>
      )}
      initialFolders={initialFolders}
      initialFiles={initialFiles}
      initialFilesComplete={initialFilesComplete}
    />
  )
}
