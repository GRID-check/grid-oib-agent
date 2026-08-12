'use client'

/**
 * Dev preview for the upload surface and the explorer's detail view.
 *
 * The tray is rendered in every stage it can be in, because the whole point of
 * the rework is that those stages LOOK different — the old bar drew one
 * determinate track across all of them and therefore had to invent a value for
 * most. Reading top to bottom you should be able to tell, without any copy:
 *
 *   1. bytes are moving and there is a real position  → determinate track, %
 *   2. the backend is reading and no position exists  → sweep, elapsed, no %
 *   3. it is finished                                 → a mark, no track
 *   4. something failed                               → the reason and a retry
 *
 * Backend-free: every fixture is a plain `TrackedFile`. Not linked from
 * anywhere and 404s outside development.
 */

import { notFound } from 'next/navigation'
import { UploadTray } from '@/features/documents/components/upload-tray'
import { FileListView } from '@/features/documents/components/file-list-view'
import type { TrackedFile } from '@/features/documents/types'
import type { FileItem } from '@/features/documents/components/project-file-workspace'

const MB = 1_000_000

const file = (overrides: Partial<TrackedFile> & Pick<TrackedFile, 'id' | 'fileName' | 'fileSize'>): TrackedFile => ({
  status: 'uploading',
  progress: 0,
  collectionName: 'proj-1',
  ...overrides,
})

/** Mid-transfer: one file sending, one queued behind the concurrency limit. */
const TRANSFERRING: TrackedFile[] = [
  file({
    id: 't1',
    fileName: 'Brandschutzkonzept_Wohnbau-Nord.pdf',
    fileSize: 4.8 * MB,
    uploadStartedAt: 1,
    bytesUploaded: 3 * MB,
  }),
  file({
    id: 't2',
    fileName: 'Fluchtwegplan_EG-2OG.pdf',
    fileSize: 1.2 * MB,
    uploadStartedAt: 1,
    bytesUploaded: 0.3 * MB,
  }),
  file({ id: 't3', fileName: 'Wohnbau-Nord_Gesamtmodell.ifc', fileSize: 152 * MB }),
  file({ id: 't4', fileName: 'Statik_Positionsplan.pdf', fileSize: 2.9 * MB }),
  file({ id: 't5', fileName: 'Energieausweis.pdf', fileSize: 0.9 * MB, status: 'success' }),
]

/** Handed over: the bytes are in, the backend is indexing. No percentage exists. */
const PROCESSING: TrackedFile[] = [
  file({ id: 'p1', fileName: 'Brandschutzkonzept_Wohnbau-Nord.pdf', fileSize: 4.8 * MB, status: 'ingesting' }),
  file({ id: 'p2', fileName: 'Fluchtwegplan_EG-2OG.pdf', fileSize: 1.2 * MB, status: 'ingesting' }),
  file({ id: 'p3', fileName: 'Energieausweis.pdf', fileSize: 0.9 * MB, status: 'success' }),
]

/** Settled and clean — this is the state that retires itself after a moment. */
const DONE: TrackedFile[] = [
  file({ id: 'd1', fileName: 'Brandschutzkonzept_Wohnbau-Nord.pdf', fileSize: 4.8 * MB, status: 'success' }),
  file({ id: 'd2', fileName: 'Fluchtwegplan_EG-2OG.pdf', fileSize: 1.2 * MB, status: 'success' }),
  file({ id: 'd3', fileName: 'Energieausweis.pdf', fileSize: 0.9 * MB, status: 'success' }),
]

/** Settled with a problem — never auto-retires; the row carries the recovery. */
const PARTIAL: TrackedFile[] = [
  file({ id: 'x1', fileName: 'Brandschutzkonzept_Wohnbau-Nord.pdf', fileSize: 4.8 * MB, status: 'success' }),
  file({
    id: 'x2',
    fileName: 'Wohnbau-Nord_Gesamtmodell.ifc',
    fileSize: 152 * MB,
    status: 'failed',
    bytesUploaded: 96 * MB,
    errorMessage: 'File exceeds the 100 MB upload limit',
  }),
  file({ id: 'x3', fileName: 'Fluchtwegplan_EG-2OG.pdf', fileSize: 1.2 * MB, status: 'canceled' }),
]

const doc = (
  id: string,
  filename: string,
  overrides: Partial<FileItem> = {}
): FileItem => ({
  id,
  filename,
  displayName: null,
  fileSize: 2.4 * MB,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-06-14T09:00:00Z',
  errorMessage: null,
  summary: null,
  pageCount: 24,
  chunkCount: 48,
  contentTypes: ['text'],
  tags: null,
  ...overrides,
})

/**
 * A set of drawings that is NUMBERED — `Plan_2` before `Plan_10` is the whole
 * argument for a numeric collator, and it is only visible with both present.
 */
const LISTING: FileItem[] = [
  doc('l1', 'Einreichplan_2_Regelgeschoss.pdf', {
    summary: 'Regelgeschoss mit Wohnungstrennwänden REI 60.',
    createdAt: '2026-06-12T09:00:00Z',
  }),
  doc('l2', 'Einreichplan_10_Dachgeschoss.pdf', {
    summary: 'Dachgeschoss mit Rauch- und Wärmeabzug im Treppenhaus.',
    createdAt: '2026-06-14T11:30:00Z',
  }),
  doc('l3', 'Wohnbau-Nord_Gesamtmodell.ifc', {
    fileSize: 152 * MB,
    contentType: 'application/octet-stream',
    status: 'processing',
    pageCount: null,
    summary: null,
    createdAt: '2026-06-14T12:05:00Z',
  }),
  doc('l4', 'Energieausweis.pdf', {
    fileSize: 0.9 * MB,
    status: 'failed',
    errorMessage: 'Ingestion could not be started',
    pageCount: null,
    summary: null,
    createdAt: '2026-06-10T08:15:00Z',
  }),
  doc('l5', 'Brandschutzkonzept_Wohnbau-Nord.pdf', {
    fileSize: 4.8 * MB,
    summary: 'Zwei unabhängige Fluchtwege je Nutzungseinheit, Gehweglänge 34 m.',
    createdAt: '2026-06-14T09:00:00Z',
  }),
]

function Stage({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      <div className="overflow-hidden rounded-xl border">{children}</div>
    </section>
  )
}

const noop = () => {}

export default function UploadTrayDevPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-lg font-semibold">Upload surface + explorer detail view</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A percentage is drawn only where bytes are actually moving. Every other phase gets motion and an elapsed
          time instead of a number nobody measured.
        </p>
      </div>

      <Stage
        title="1 · Transferring"
        note="Real bytes, real speed, real ETA — and the files still waiting for a slot say so rather than sitting at zero."
      >
        <UploadTray files={TRANSFERRING} onRetry={noop} onCancel={noop} onCancelAll={noop} onDismiss={noop} />
      </Stage>

      <Stage
        title="2 · Reading"
        note="The bytes are in and the backend is indexing. No position exists, so none is drawn: a sweep and an elapsed time."
      >
        <UploadTray files={PROCESSING} onRetry={noop} onCancel={noop} onDismiss={noop} />
      </Stage>

      <Stage title="3 · Done" note="Confirmed, then it retires itself. Success should not need dismissing.">
        <UploadTray files={DONE} onRetry={noop} onDismiss={noop} />
      </Stage>

      <Stage
        title="4 · Partly failed"
        note="Never auto-retires. The server's own reason sits on the row that owns it, with retry beside it."
      >
        <UploadTray files={PARTIAL} onRetry={noop} onDismiss={noop} />
      </Stage>

      <Stage
        title="Explorer — detail view"
        note="Sortable, keyboard-navigable, numeric-aware: Einreichplan_2 sorts before Einreichplan_10."
      >
        <div className="bg-card">
          <FileListView files={LISTING} selectedFileId="l5" onSelectFile={noop} />
        </div>
      </Stage>
    </main>
  )
}
