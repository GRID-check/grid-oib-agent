'use client'

/**
 * Composer file-state dev preview: the REAL InputArea with files attached, so
 * the file-input surface (inline FileChips above the textarea, the manage-files
 * button, per-file status/retry/remove) can be reviewed and screenshotted at
 * desktop + mobile. Seeds a fake conversation + tracked files into the stores in
 * an effect (backend-free). Not linked anywhere; 404s outside development.
 *
 * `?state=` selects an extra captured state:
 *   - (none)   → the composer with clickable chips + the mobile "manage" entry.
 *   - preview  → the shared read-only FilePreviewDialog opened from a chip.
 *   - sheet    → the mobile FileSourcesTab bottom-sheet (manage files).
 *
 * A module-scope fetch shim (browser + dev only) serves the file-preview URL and
 * visual-details payload so the preview pane renders fully backend-free — same
 * pattern as /dev/file-preview.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { AppConfigProvider, type AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { InputArea, FileSourcesTab } from '@/features/layout/components'
import { useLayoutStore } from '@/features/layout/store'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/features/chat'
import { useDocumentsStore, type TrackedFile } from '@/features/documents'
import { FilePreviewDialog } from '@/features/documents/components/file-preview-dialog'
import type { FileItem } from '@/features/documents/components/project-file-workspace'

const CONV_ID = 'dev-files-conv'

const config: AppConfig = {
  authRequired: false,
  fileUpload: getFileUploadConfigFromEnv(),
}

const files: TrackedFile[] = [
  {
    id: 'f1',
    fileName: 'Einreichplan_EG.pdf',
    fileSize: 2_400_000,
    status: 'success',
    progress: 100,
    collectionName: CONV_ID,
    uploadedAt: '2024-01-15T09:00:00Z',
  },
  {
    id: 'f2',
    fileName: 'Baubeschreibung_2024_final.docx',
    fileSize: 840_000,
    status: 'ingesting',
    progress: 60,
    collectionName: CONV_ID,
  },
  {
    id: 'f3',
    fileName: 'Energieausweis.pdf',
    fileSize: 1_200_000,
    status: 'failed',
    progress: 0,
    collectionName: CONV_ID,
    errorMessage: 'Ingestion failed',
  },
]

// Rich fixture for the read-only chip preview — a real "document page" so the
// left pane renders something, plus indexed metadata the pane tolerates.
const PAGE_SVG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="700" viewBox="0 0 520 700">
       <rect width="520" height="700" fill="#ffffff"/>
       <rect x="40" y="48" width="240" height="16" rx="3" fill="#1f2937"/>
       <rect x="40" y="76" width="150" height="10" rx="3" fill="#9ca3af"/>
       <rect x="40" y="128" width="440" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="150" width="440" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="172" width="360" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="500" width="440" height="8" rx="3" fill="#d1d5db"/>
     </svg>`
  )

const PREVIEW_FIXTURE: FileItem = {
  id: 'f1',
  filename: 'Einreichplan_EG.pdf',
  fileSize: 2_400_000,
  contentType: 'image/png',
  status: 'ready',
  folderId: null,
  createdAt: '2024-01-15T09:00:00Z',
  errorMessage: null,
  summary:
    'Einreichplan Erdgeschoss — Grundriss mit Raumwidmungen, Fluchtwegen und ' +
    'Brandabschnittsgrenzen. Maßstab 1:100.',
  pageCount: 3,
  chunkCount: 12,
  contentTypes: ['drawing', 'text'],
  tags: ['Grundriss', 'Brandschutz'],
}

// Install the fetch shim at module scope (before any component effect fires) so
// the pane's preview / visual-details fetches always resolve. Idempotent +
// dev/browser-guarded.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __composerFilesShim?: boolean }
  if (!w.__composerFilesShim) {
    w.__composerFilesShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (/\/api\/documents\/.+\/preview$/.test(url)) {
        return Response.json({ url: PAGE_SVG })
      }
      if (/\/api\/documents\/.+\/visual-details$/.test(url)) {
        return Response.json({ details: [] })
      }
      return real(input, init)
    }
  }
}

export default function ComposerFilesPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Read the requested state after mount (in an effect, not during render) so
  // the server and first client render agree — avoids a hydration mismatch.
  const [state, setState] = useState<string | null>(null)

  useEffect(() => {
    setState(new URLSearchParams(window.location.search).get('state'))
    useChatStore.setState({
      currentConversation: {
        id: CONV_ID,
        userId: 'dev',
        projectId: 'dev',
        title: 'Dev',
        messages: [],
        createdAt: new Date('2024-01-15'),
        updatedAt: new Date('2024-01-15'),
      },
    })
    useDocumentsStore.setState({ trackedFiles: files })
    useLayoutStore.setState({ knowledgeLayerAvailable: true })
  }, [])

  // Preview state: the shared read-only dialog as opened from a successful chip.
  if (state === 'preview') {
    return (
      <AppConfigProvider config={config}>
        <FilePreviewDialog file={PREVIEW_FIXTURE} canManage={false} onClose={() => {}} />
        <span data-testid="composer-files-preview" className="sr-only">
          composer-files preview
        </span>
      </AppConfigProvider>
    )
  }

  // Sheet state: the mobile FileSourcesTab bottom-sheet (manage files). Renders
  // the exact bottom-sheet chrome the composer's manage-files dialog uses.
  if (state === 'sheet') {
    return (
      <AppConfigProvider config={config}>
        <Dialog open>
          <DialogContent
            className={cn(
              'flex max-w-full flex-col gap-0 rounded-b-none rounded-t-2xl p-0',
              'bottom-0 left-0 top-auto translate-x-0 translate-y-0',
              'h-[85dvh] max-h-[85dvh]',
              'sm:bottom-auto sm:left-[50%] sm:top-[50%] sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-3xl sm:p-6'
            )}
          >
            <DialogHeader className="border-b px-4 py-3 text-left sm:border-0 sm:p-0">
              <DialogTitle>Dateien verwalten</DialogTitle>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 sm:px-0 sm:pb-0 sm:pt-2">
              <FileSourcesTab />
            </div>
          </DialogContent>
        </Dialog>
        <span data-testid="composer-files-preview" className="sr-only">
          composer-files sheet
        </span>
      </AppConfigProvider>
    )
  }

  return (
    <AppConfigProvider config={config}>
      <main className="min-h-dvh bg-muted/30 px-4 py-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
          <h1 className="font-mono text-xs text-muted-foreground" data-testid="composer-files-preview">
            /dev/composer-files — composer with attached files (desktop + mobile)
          </h1>

          <div>
            <div className="mb-2 font-mono text-xs text-muted-foreground">↓ desktop</div>
            <InputArea isAuthenticated connectionMode="sse" projectName="Stadthaus Wien 1090" />
          </div>

          <div>
            <div className="mb-2 font-mono text-xs text-muted-foreground">↓ mobile width (390px)</div>
            <div className="w-[390px] max-w-full">
              <InputArea isAuthenticated connectionMode="sse" projectName="Stadthaus Wien 1090" />
            </div>
          </div>
        </div>
      </main>
    </AppConfigProvider>
  )
}
