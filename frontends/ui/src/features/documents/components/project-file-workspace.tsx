'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Mail } from 'lucide-react'
import { ProjectSectionActions } from '@/components/shell/project-section-frame'
import { createDocumentNameProbeClient } from '@/lib/documents/name-probe-client'
import { useTranslations } from '@/i18n'
import type { DocumentLifecyclePermission } from '@/lib/documents/lifecycle-types'
import { askAboutFile } from '../lib/ask-about-file'
import type { FileShelf } from '../lib/file-shelf'
import { usePhoneLayout } from '../hooks/use-phone-layout'
import { projectEndpoints } from '../lib/file-shelf'
import type { DocumentWireRow } from '../lib/file-item'
import { useProjectDocuments } from '../hooks/use-project-documents'
import type { FolderItem } from '../file-types'
import { FileWorkspace } from './file-workspace'
import { MailImportAction } from './mail-import-action'
import { MailImportDialog } from './mail-import-dialog'
import { InboundMailAddressDialog } from '@/features/inbound-mail/components/inbound-mail-address'
import { inboundMailPaths } from '@/features/inbound-mail/lib/paths'
import { useInboundMailWaiting } from '@/features/inbound-mail/hooks/use-inbound-mail-waiting'

// The row and folder types live in `../file-types`; they are re-exported here
// because this is the name every importer already uses.
export type { FileAssignee, FileItem, FolderItem } from '../file-types'

interface ProjectFileWorkspaceProps {
  projectId: string
  projectName: string
  collectionName: string
  /**
   * Whether the model workspace is reachable (WorkOS `ifc-models`, ADR-0046).
   *
   * It decides the smallest of the things the flag has been: whether the preview
   * offers the way on to the stage. A click always opens the preview, and
   * `?model=` always opens the stage. Off by default, because a viewer whose
   * endpoints answer 403 is worse than no viewer.
   */
  showModels?: boolean
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
   * The folder tree and the first page of the folder level the URL names, as
   * the SERVER already read them, for the first paint — see {@link FileWorkspace}.
   * `initialNextCursor` is where that level continues (null: it was the whole
   * level); `initialFolderId` the level (null: the root, ADR-0102).
   */
  initialFolders?: readonly FolderItem[]
  initialFiles?: readonly DocumentWireRow[]
  initialNextCursor?: string | null
  initialFolderId?: string | null
  /**
   * Whether this reader may change who may read and write a folder
   * (`project:manage`, resolved on the server, ADR-0088). Shows „Zugriff…" in the
   * folder menu; the route checks again.
   */
  canManageFolderAccess?: boolean
  /**
   * What the reader may do at the project root, as the server read it for the
   * first paint (ADR-0088). Absent means `write`; the folder listing refreshes it.
   * The mail import files its folder at the root, so only `write` offers it.
   */
  initialRootAccess?: 'read' | 'write'
  /** Whether the Outlook archive import is offered (`isMailImportEnabled`, ADR-0085). Off by default. */
  mailImportEnabled?: boolean
  /**
   * Whether this reader may decide the project's held mail (the `inbound-mail`
   * entitlement and `project:documents:write`, ADR-0134), resolved on the
   * server. Shows the E-Mail-Eingang entry, its count and „Per E-Mail senden …“.
   */
  inboundMailEnabled?: boolean
}

/**
 * A project's Dateien: {@link FileWorkspace} over the project's shelf.
 *
 * Everything this adds is a fact about a PROJECT: the shelf's endpoints, the
 * project's chat (so a file can be asked about), collaboration, per-role folder
 * access (ADR-0088), the preview the project shell hosts, and the section header
 * the controls portal into.
 */
export function ProjectFileWorkspace({
  projectId,
  projectName,
  collectionName,
  showModels = false,
  canCollaborate = false,
  currentUserId,
  lifecyclePermissions,
  initialFolders,
  initialFiles,
  initialNextCursor = null,
  initialFolderId = null,
  canManageFolderAccess = false,
  initialRootAccess = 'write',
  mailImportEnabled = false,
  inboundMailEnabled = false,
}: ProjectFileWorkspaceProps) {
  const t = useTranslations('files')
  const router = useRouter()
  const probe = useMemo(() => createDocumentNameProbeClient(), [])
  // The Outlook import is a button beside the upload control on a wide screen
  // and an entry in the header's ⋯ on a phone, which has no width for a second button.
  const phone = usePhoneLayout()
  const [mailOpen, setMailOpen] = useState(false)
  const mailOffered = mailImportEnabled && initialRootAccess === 'write'
  const [addressOpen, setAddressOpen] = useState(false)
  const waiting = useInboundMailWaiting(projectId, inboundMailEnabled)

  const shelf: FileShelf = {
    source: 'project',
    documentScope: 'files',
    endpoints: projectEndpoints(projectId),
    projectId,
    collectionName,
    canManage: true,
    folderAccess: { projectId, canManage: canManageFolderAccess, initialRootAccess },
    bin: { href: `/app/projects/${projectId}/files/bin` },
    openPoints: { href: `/app/projects/${projectId}/files/open-points` },
    inboundMail: inboundMailEnabled
      ? {
          href: inboundMailPaths(projectId).list({ status: 'waiting', outcome: null }),
          waiting: waiting.count,
          more: waiting.more,
          openAddress: () => setAddressOpen(true),
        }
      : undefined,
    canCollaborate,
    currentUserId,
    askAbout: (file) => askAboutFile({ projectId, file, navigate: (href) => router.push(href) }),
    useUpload: ({ collectionName: collection, folderId, onComplete }) =>
      useProjectDocuments({ projectId, collectionName: collection, folderId, onComplete }),
    probeNames: (names) => probe.project(projectId, names),
    probeRevisions: (names, landsIn) => probe.projectRevisions(projectId, names, landsIn),
    handoverKey: projectId,
    preview: { kind: 'store', projectName },
    messages: {
      dropToUpload: t('workspace.dropToUpload'),
      ingestionComplete: (name) => t('toast.ingestionComplete', { name }),
    },
    showModels,
    lifecyclePermissions,
  }

  return (
    <>
      <FileWorkspace
        shelf={shelf}
        renderHeader={(controls) => (
          <ProjectSectionActions>
            {controls}
            {mailOffered && !phone && <MailImportAction projectId={projectId} />}
          </ProjectSectionActions>
        )}
        moreEntries={
          mailOffered && phone
            ? [
                {
                  type: 'item',
                  id: 'mail-import',
                  label: t('mailImport.action'),
                  icon: Mail,
                  onSelect: () => setMailOpen(true),
                  testId: 'mail-import-trigger',
                },
              ]
            : undefined
        }
        initialFolders={initialFolders}
        initialFiles={initialFiles}
        initialNextCursor={initialNextCursor}
        initialFolderId={initialFolderId}
      />
      {mailOffered && phone && <MailImportDialog projectId={projectId} open={mailOpen} onOpenChange={setMailOpen} />}
      {inboundMailEnabled && (
        <InboundMailAddressDialog projectId={projectId} projectName={projectName} open={addressOpen} onOpenChange={setAddressOpen} />
      )}
    </>
  )
}
