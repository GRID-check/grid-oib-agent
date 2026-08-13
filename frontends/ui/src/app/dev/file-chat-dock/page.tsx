'use client'

/**
 * The asked file as a floating frame beside chat — Figma-quiet, same
 * hairline + shadow-xs language as the thread toolbar.
 */

import { Maximize2, X } from 'lucide-react'
import { I18nProvider } from '@/i18n'
import { FilePreviewPane } from '@/features/documents/components/file-preview-pane'
import type { FileItem } from '@/features/documents/components/project-file-workspace'

const FILE: FileItem = {
  id: 'doc-brandschutz',
  filename: 'Brandschutzplan_EG.pdf',
  displayName: null,
  fileSize: 2_458_112,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-04-02T09:00:00.000Z',
  errorMessage: null,
  summary: 'Brandschutzkonzept Erdgeschoss, Fluchtwege und Feuerwiderstand der tragenden Wände.',
  pageCount: 12,
  chunkCount: 48,
  contentTypes: ['text', 'drawing'],
  tags: ['Brandschutz'],
}

export default function FileChatDockPreviewPage(): JSX.Element {
  return (
    <I18nProvider locale="de">
      <div className="bg-background relative flex h-[100dvh]" data-testid="file-chat-dock">
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-0.5 rounded-lg border border-base bg-card/70 p-0.5 shadow-xs backdrop-blur">
            <span className="text-muted-foreground px-2 py-1 text-[12px] font-medium">Seestadt Baufeld</span>
          </div>
          <div className="text-muted-foreground flex flex-1 items-center justify-center px-8 text-center text-[13.5px] leading-relaxed">
            Frage zu Brandschutzplan_EG.pdf…
          </div>
          <div className="px-4 pb-4">
            <div className="border-base text-muted-foreground rounded-lg border bg-card/70 px-3 py-2 text-[13px] shadow-xs">
              Frage zu Brandschutzplan_EG.pdf…
            </div>
          </div>
        </section>
        <div className="w-[22.5rem] shrink-0" aria-hidden />
        <aside className="border-base bg-card/95 absolute top-14 right-3 bottom-3 flex w-80 flex-col overflow-hidden rounded-2xl border shadow-xs backdrop-blur">
          <div className="flex h-9 shrink-0 items-center gap-1 px-2.5">
            <p className="min-w-0 flex-1 truncate text-[12px] font-medium tracking-[-0.01em]">
              Brandschutzplan_EG.pdf
            </p>
            <span className="text-muted-foreground flex size-7 items-center justify-center">
              <Maximize2 className="size-3.5" />
            </span>
            <span className="text-muted-foreground flex size-7 items-center justify-center">
              <X className="size-3.5" />
            </span>
          </div>
          <FilePreviewPane file={FILE} projectId="proj-1" projectName="Seestadt Baufeld" presentation="peek" />
        </aside>
      </div>
    </I18nProvider>
  )
}
