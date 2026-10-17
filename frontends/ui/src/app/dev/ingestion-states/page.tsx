'use client'

/**
 * Dev preview: every ingestion state, side by side, on every surface that
 * names one.
 *
 * The other previews show a surface in a moment (`/dev/upload-tray` walks one
 * batch from drop to settled, `/dev/file-browser?variant=uploading` the grid
 * just after). This one is the comparison: each state a document can be in
 * between the drop and being readable, once per surface, so states that share
 * a colour can be checked for telling themselves apart anyway.
 *
 *   1. The status badge, as the list and the preview draw it.
 *   2. The file card, where the badge floats on the thumbnail's frost.
 *   3. The Files list, one row per state.
 *   4. The upload tray, one row per phase, the three failures apart:
 *      a retryable upload, a read that failed, and a taken name a retry
 *      cannot fix; and a file held because the one it replaces is held.
 *   5. The chat's file peek, for a held file beside a citable one.
 *
 * Backend-free: fixtures only, and a fetch shim that 404s thumbnails so every
 * card draws the sketch placeholder. `src/app/dev/layout.tsx` 404s the route
 * outside development.
 */

import type { JSX, ReactNode } from 'react'
import { DocumentStatusBadge } from '@/features/documents/components/document-status'
import { FileCard } from '@/features/documents/components/file-card'
import { FileListView } from '@/features/documents/components/file-list-view'
import { UploadTray } from '@/features/documents/components/upload-tray'
import type { FileItem } from '@/features/documents/components/project-file-workspace'
import type { TrackedFile } from '@/features/documents/types'
import { FileReferencePeek } from '@/features/chat/components/FileReferencePeek'
import { useLocale, useTranslations } from '@/i18n'

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __ingestionStatesShim?: boolean }
  if (!w.__ingestionStatesShim) {
    w.__ingestionStatesShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      // Only this preview's fixtures (`s0`…`s8`): the shim outlives the page on
      // a client navigation, and a real document's id is a UUID.
      if (/\/api\/documents\/s\d+\/thumbnail$/.test(url)) return new Response(null, { status: 404 })
      return real(input, init)
    }
  }
}

const MB = 1_000_000

const HELD_VERDICT =
  'quarantined:{"reasons":[{"kind":"term","term":"Honorarvereinbarung","pages":[1,3]},{"kind":"iban","sample":"AT61 •••• 1234","pages":[3]}],"checked":"full"}'

/** One row per state a stored document can be in, in the order a reader scans for them. */
const STATES: { status: string; note: string; queueAhead?: number; errorMessage?: string; name: string }[] = [
  { status: 'uploading', note: 'bytes still arriving', name: 'Wohnbau-Nord_Gesamtmodell.ifc' },
  { status: 'pending', note: 'in the office’s ingest queue', queueAhead: 3, name: 'Baubeschreibung_Einreichung.pdf' },
  { status: 'processing', note: 'Piloti is reading it', name: 'Brandschutzkonzept_Wohnbau-Nord.pdf' },
  { status: 'completed', note: 'Piloti can cite it', name: 'Energieausweis.pdf' },
  {
    status: 'quarantined',
    note: 'held by the content check (ADR-0086)',
    errorMessage: HELD_VERDICT,
    name: 'Honorarvereinbarung_Wohnbau-Nord.pdf',
  },
  {
    status: 'failed',
    note: 'the read broke',
    errorMessage: 'office_rendition_required: conversion timed out',
    name: 'Statik_Positionsplan.docx',
  },
  { status: 'stored', note: 'kept, deliberately not read', name: 'Lageplan_Bestand.dwg' },
  { status: 'mystery', note: 'a status nobody declared', name: 'Einreichplan_10_Dachgeschoss.pdf' },
]

const doc = (index: number, state: (typeof STATES)[number]): FileItem => ({
  id: `s${index}`,
  filename: state.name,
  displayName: null,
  fileSize: 2.4 * MB,
  contentType: state.name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
  status: state.status,
  queueAhead: state.queueAhead ?? null,
  folderId: null,
  // Fixed, so the list's "added" column does not move between captures.
  createdAt: `2026-06-14T09:0${index}:00Z`,
  errorMessage: state.errorMessage ?? null,
  summary: state.status === 'completed' ? 'Energieausweis nach OIB-Richtlinie 6, HWB 28 kWh/m²a.' : null,
  pageCount: state.status === 'completed' ? 6 : null,
  chunkCount: null,
  contentTypes: ['text'],
  tags: null,
  topics: null,
  capture: null,
})

const DOCUMENTS = STATES.map((state, index) => doc(index, state))

const tracked = (overrides: Partial<TrackedFile> & Pick<TrackedFile, 'id' | 'fileName' | 'fileSize'>): TrackedFile => ({
  status: 'uploading',
  progress: 0,
  collectionName: 'proj-1',
  ...overrides,
})

/** One row per live and settled phase. */
const TRAY_LIVE: TrackedFile[] = [
  tracked({ id: 'q', fileName: 'Wohnbau-Nord_Gesamtmodell.ifc', fileSize: 152 * MB }),
  tracked({
    id: 'u',
    fileName: 'Brandschutzkonzept_Wohnbau-Nord.pdf',
    fileSize: 4.8 * MB,
    uploadStartedAt: 1,
    bytesUploaded: 3 * MB,
  }),
  tracked({ id: 'p', fileName: 'Fluchtwegplan_EG-2OG.pdf', fileSize: 1.2 * MB, status: 'ingesting', serverFileId: 'd-p' }),
  tracked({ id: 'r', fileName: 'Energieausweis.pdf', fileSize: 0.9 * MB, status: 'success', serverFileId: 'd-r' }),
  tracked({
    id: 'same',
    fileName: 'Baubeschreibung_Einreichung.pdf',
    fileSize: 1.7 * MB,
    status: 'success',
    unchanged: true,
    serverFileId: 'd-same',
  }),
  tracked({ id: 'st', fileName: 'Lageplan_Bestand.dwg', fileSize: 1.1 * MB, status: 'stored', serverFileId: 'd-st' }),
]

type FilesTranslator = ReturnType<typeof useTranslations>

/**
 * The rows that ask something of the reader: held (by its own verdict, and
 * because the file it replaces is held, the 409 a re-upload meets), the three
 * failures apart, and a cancelled one. Said from the dictionary, as the upload
 * hook says them.
 */
const traySettled = (t: FilesTranslator): TrackedFile[] => [
  tracked({
    id: 'h',
    fileName: 'Honorarvereinbarung_Wohnbau-Nord.pdf',
    fileSize: 0.4 * MB,
    status: 'held',
    serverFileId: 'd-h',
    errorMessage: HELD_VERDICT,
  }),
  // The 409 onto a held file its uploader may see: held with it, not failed,
  // its own sentence and the request for a review of the held file.
  tracked({
    id: 'h-replace',
    fileName: 'Honorarvereinbarung_Wohnbau-Nord_v2.pdf',
    fileSize: 0.4 * MB,
    status: 'held',
    retryable: false,
    replacesHeld: { documentId: 'd-h', ownUpload: true },
    errorMessage: t('errors.quarantinedReplace', { name: 'Honorarvereinbarung_Wohnbau-Nord_v2.pdf' }),
  }),
  // Never reached the server: a retry sends it again.
  tracked({
    id: 'f-up',
    fileName: 'Wohnbau-Nord_Fassade.ifc',
    fileSize: 112 * MB,
    status: 'failed',
    bytesUploaded: 40 * MB,
    errorMessage: t('errors.uploadNetwork'),
  }),
  // Accepted and could not be read: the reason in the reader's words, „Details" for the raw text.
  tracked({
    id: 'f-read',
    fileName: 'Statik_Positionsplan.docx',
    fileSize: 2.9 * MB,
    status: 'failed',
    serverFileId: 'd-f-read',
    errorMessage: 'office_rendition_required: conversion timed out',
  }),
  // A taken name, a refusal a retry meets again: no retry, only the sentence.
  // A held file the uploader may not see reads exactly like this.
  tracked({
    id: 'f-final',
    fileName: 'Baubeschreibung.pdf',
    fileSize: 0.4 * MB,
    status: 'failed',
    retryable: false,
    errorMessage: t('errors.nameTaken', { name: 'Baubeschreibung.pdf' }),
  }),
  tracked({ id: 'c', fileName: 'Statik_Positionsplan_alt.pdf', fileSize: 2.9 * MB, status: 'canceled' }),
]

function Stage({ title, note, children }: { title: string; note: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
      </div>
      {children}
    </section>
  )
}

const noop = () => {}

/** The chat's file peek: a held file says it is held back, a citable one says nothing of the kind. */
const PEEKS: { note: string; file: FileItem }[] = [
  { note: 'quarantined', file: DOCUMENTS[4] },
  { note: 'completed', file: DOCUMENTS[3] },
]

export default function IngestionStatesDevPage(): JSX.Element {
  const { locale } = useLocale()
  const t = useTranslations('files')
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 py-8 md:px-8" data-testid="ingestion-states">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Ingestion states</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every state a document passes between the drop and being readable, on every surface that names it. States
          that share a colour are told apart by their glyph.
        </p>
      </div>

      <Stage title="1 · Status badge" note="As the Files list and the preview draw it: glyph, word and colour from one state.">
        <div className="overflow-hidden rounded-lg border bg-card">
          <dl className="divide-y">
            {STATES.map((state) => (
              <div key={state.status} className="flex items-center gap-4 px-4 py-2.5">
                <dt className="w-28 shrink-0 font-mono text-xs text-muted-foreground">{state.status}</dt>
                <dd className="flex min-w-0 flex-1 items-center gap-3">
                  <DocumentStatusBadge status={state.status} queueAhead={state.queueAhead} />
                  <span className="hidden truncate text-xs text-muted-foreground sm:inline">{state.note}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Stage>

      <Stage
        title="2 · File card"
        note="The badge on the thumbnail's frost; a citable card shows none. A card still being read holds its summary lines."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {DOCUMENTS.map((file) => (
            <FileCard key={file.id} file={file} isSelected={false} onSelect={noop} locale={locale} />
          ))}
        </div>
      </Stage>

      <Stage title="3 · Files list" note="One row per state, in the status column the list keeps narrow.">
        <div className="overflow-hidden rounded-lg border bg-card">
          <FileListView files={DOCUMENTS} selectedFileId={null} onSelectFile={noop} />
        </div>
      </Stage>

      <Stage
        title="3b · Files list, narrow"
        note="The same rows where the list is narrow: beside the chat (560px) and on a phone (340px). The columns step out by the list's own width, and a name that does not fit loses its middle, then its start behind a leading „…“, never a hard edge."
      >
        <div className="flex flex-wrap items-start gap-4">
          {[560, 340].map((width) => (
            <div key={width} className="space-y-1" style={{ width }} data-testid={`narrow-list-${width}`}>
              <p className="font-mono text-[11px] text-muted-foreground">{width}px</p>
              <div className="overflow-hidden rounded-lg border bg-card">
                <FileListView files={DOCUMENTS} selectedFileId={null} onSelectFile={noop} />
              </div>
            </div>
          ))}
        </div>
      </Stage>

      <Stage
        title="4 · Upload tray, in flight"
        note="Waiting for a slot, sending (the only percentage), reading, citable, unchanged, filed. One loop: the header's."
      >
        <div className="overflow-hidden rounded-lg border">
          <UploadTray files={TRAY_LIVE} onRetry={noop} onCancel={noop} onCancelAll={noop} onDismiss={noop} />
        </div>
      </Stage>

      <Stage
        title="5 · Upload tray, settled with something to do"
        note="Held (amber, no retry), then a file held because the one it would replace is held (its own sentence, a request for review), then three failures: an upload that can be sent again, a read that failed, a taken name a retry cannot fix (no retry). Then a cancelled file, which is a decision and never red."
      >
        <div className="overflow-hidden rounded-lg border">
          <UploadTray files={traySettled(t)} onRetry={noop} onDismiss={noop} />
        </div>
      </Stage>

      <Stage
        title="6 · Chat file peek"
        note="What the reader sees hovering a file named in an answer: a held file says it is held back and cited only once someone allows it through; a citable one says nothing of the kind."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {PEEKS.map(({ note, file }) => (
            <div key={note} className="space-y-1" data-testid={`peek-${note}`}>
              <p className="font-mono text-[11px] text-muted-foreground">{note}</p>
              <div className="w-72 max-w-full rounded-lg border bg-popover p-3 shadow-sm">
                <FileReferencePeek stored={{ file, corpus: 'projekt' }} onOpen={noop} />
              </div>
            </div>
          ))}
        </div>
      </Stage>
    </main>
  )
}
