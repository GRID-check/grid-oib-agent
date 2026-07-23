'use client'

/**
 * Composer file-state dev preview: the REAL InputArea with files attached, so
 * the file-input surface (inline FileChips above the textarea, the manage-files
 * button, per-file status/retry/remove) can be reviewed and screenshotted at
 * desktop + mobile. Seeds a fake conversation + tracked files into the stores in
 * an effect (backend-free). Not linked anywhere; 404s outside development.
 */

import { useEffect } from 'react'
import { notFound } from 'next/navigation'
import { AppConfigProvider, type AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { InputArea } from '@/features/layout/components'
import { useChatStore } from '@/features/chat'
import { useDocumentsStore, type TrackedFile } from '@/features/documents'

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

export default function ComposerFilesPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  useEffect(() => {
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
  }, [])

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
