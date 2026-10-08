'use client'

import { useCallback, useMemo, type ReactNode } from 'react'
import { Archive } from 'lucide-react'
import { sourceTint } from '@/lib/ui/source-tint'
import { CountPill } from '@/components/ui/count-pill'
import { useTranslations } from '@/i18n'
import { createDocumentNameProbeClient } from '@/lib/documents/name-probe-client'
import { inferDocumentKind } from '../document-kind'
import type { FileItem } from '../file-types'
import { useArchivDocuments } from '../hooks/use-archiv-documents'
import { ARCHIV_ENDPOINTS, type CardExtras, type FileShelf } from '../lib/file-shelf'
import { FileWorkspace } from './file-workspace'

interface ArchivWorkspaceProps {
  /** Whether the viewer may change the Archiv (holds `org:archiv:manage`). */
  canManage: boolean
  /** Whether an `.ifc` here can reach the model workspace (`ifc-models`). */
  showModels?: boolean
  /**
   * Whether a click on an `.ifc` opens the preview first (`ifc-preview-first`).
   * Threaded to BOTH file surfaces from their pages so it can only ever move
   * them together.
   */
  previewFirst?: boolean
  /** Gates the ingestion-metadata block, mirroring the project Files tab. */
  showMetadataPanel?: boolean
  /**
   * Controls appended at the end of the identity row, after the upload button.
   * The Archiv sheet slots its close control here so the workspace's own
   * header stays the sheet's ONE header instead of gaining a twin above it.
   */
  trailingActions?: ReactNode
}

/**
 * Gold Büroarchiv identity mark (spec §4, `--source-office`): icon + label
 * together so color is never the only carrier (a11y).
 */
const OFFICE_TINT = sourceTint('office')

/**
 * The office Archiv: {@link FileWorkspace} over the organization's shelf.
 *
 * It is a project's Dateien with the project taken out. What it adds is the
 * office's own identity — the gold mark, name and count, the sheet's close
 * control — and the permission model: a member without `org:archiv:manage` gets
 * the read-only view (list, folders, search, filters, preview, download).
 * There is no assignment (collaboration is project-scoped) and no „Frage zur
 * Datei" (there is no project chat to ask in).
 */
export function ArchivWorkspace({
  canManage,
  showMetadataPanel = true,
  showModels = false,
  previewFirst = true,
  trailingActions,
}: ArchivWorkspaceProps) {
  const t = useTranslations('archiv')
  const probe = useMemo(() => createDocumentNameProbeClient(), [])

  /** The gold kind chip, and where the document came from when it says. */
  const cardExtras = useCallback(
    (file: FileItem): CardExtras => {
      const kind = inferDocumentKind(file)
      const provenance = (file.tags ?? []).slice(0, 3).join(' · ')
      const line = t('library.provenance', { source: provenance })
      return {
        source: 'buero',
        sourceLabel: t(`library.kind.${kind}` as 'library.kind.document'),
        ...(provenance !== ''
          ? {
              footerLead: (
                <span
                  className="text-muted-foreground/80 min-w-0 flex-1 truncate"
                  data-testid="archiv-provenance"
                  title={line}
                >
                  {line}
                </span>
              ),
            }
          : {}),
      }
    },
    [t]
  )

  const shelf: FileShelf = {
    source: 'office',
    documentScope: 'archiv',
    endpoints: ARCHIV_ENDPOINTS,
    projectId: null,
    canManage,
    canCollaborate: false,
    // Only managers drive the upload engine; no collection for a read-only
    // viewer keeps its orchestrator effects inert (no background calls that
    // would 403 for them anyway).
    useUpload: ({ collectionName, folderId, onComplete }) =>
      useArchivDocuments({
        collectionName: canManage ? collectionName : undefined,
        folderId,
        onComplete,
      }),
    probeNames: probe.archiv,
    preview: { kind: 'dialog' },
    cardExtras,
    messages: {
      dropToUpload: t('workspace.dropToUpload'),
      ingestionComplete: (name) => t('toast.ingestionComplete', { name }),
    },
    showMetadataPanel,
    showModels,
    previewFirst,
  }

  return (
    <FileWorkspace
      shelf={shelf}
      renderHeader={(controls, { count }) => (
        // Identity row — the gold Büroarchiv mark, the name of the store, and
        // how much is in it. The count sits with the title: it is a property of
        // the Archiv, and the one number a reader wants before they filter.
        <div className="flex min-h-[4rem] flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="shadow-2xs flex size-9 shrink-0 items-center justify-center rounded-xl"
              style={OFFICE_TINT}
              aria-hidden
            >
              <Archive className="size-[18px]" />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="text-foreground truncate text-sm font-semibold tracking-tight">{t('title')}</h2>
                <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center">
                  {count !== null && count > 0 && (
                    <CountPill data-testid="archiv-document-count">{count}</CountPill>
                  )}
                </span>
              </div>
              <p className="text-muted-foreground truncate text-xs">{t('subtitle')}</p>
            </div>
          </div>
          <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
            {controls}
            {trailingActions}
          </div>
        </div>
      )}
    />
  )
}
