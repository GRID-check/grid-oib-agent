'use client'

/**
 * Outlook archive import dev preview (ADR-0085): the REAL import dialog over
 * fixture state, so every row shape can be reviewed and captured without an
 * archive, a job or a backend. Not linked anywhere; the `/dev` layout 404s it
 * outside development.
 *
 * Variants via `?variant=`:
 *   - default  — a project with history: one import filing (with its progress
 *                bar), one that finished with skipped files, one that failed,
 *                one cancelled, and a colleague's waiting import.
 *   - sending  — this tab sending an archive, with the resumable upload row.
 *   - empty    — nothing imported yet: the picker and the empty history.
 *   - error    — a refused pick (not an archive) above the history.
 */

import { useSearchParams } from 'next/navigation'
import { MailImportDialogView } from '@/features/documents/components/mail-import-dialog'
import type { UseMailImports } from '@/features/documents/hooks/use-mail-imports'
import type { MailImportView } from '@/lib/mail-import/types'

const PROJECT = 'p-wohnbau-nord'
const PART = 32 * 1024 * 1024

function row(overrides: Partial<MailImportView>): MailImportView {
  return {
    id: 'imp-1',
    filename: 'Postfach Bauleitung 2025.pst',
    sizeBytes: 4_200_000_000,
    status: 'completed',
    startedBy: { userId: 'u-anna', email: 'anna.berger@buero.at' },
    ownedByViewer: true,
    cancellable: false,
    folderId: 'folder-1',
    totalItems: 6_412,
    processedItems: 6_412,
    mailsFiled: 6_120,
    filesFiled: 3_874,
    itemsSkipped: 292,
    filesSkipped: 0,
    skippedSamples: [],
    errorCode: null,
    error: null,
    createdAt: '2026-10-07T09:12:00Z',
    completedAt: '2026-10-07T11:40:00Z',
    ...overrides,
  }
}

const HISTORY: MailImportView[] = [
  row({
    id: 'imp-running',
    filename: 'Korrespondenz Behörden.pst',
    status: 'importing',
    cancellable: true,
    sizeBytes: 1_850_000_000,
    totalItems: 2_904,
    processedItems: 1_137,
    mailsFiled: 1_090,
    filesFiled: 812,
    itemsSkipped: 47,
    completedAt: null,
  }),
  row({
    id: 'imp-done',
    filesSkipped: 4,
    skippedSamples: [
      { mail: '#2114', file: null, reason: 'unreadable' },
      { mail: '2025-05-14 11.03 – Kanzlei Weber', file: 'Vertrag_Entwurf.docx', reason: 'screened' },
      { mail: '2025-03-12 14.05 – Statik Huber', file: 'Bewehrung.dwg', reason: 'type' },
      { mail: '2025-04-02 08.40 – Bauamt Wien', file: 'Scan_Gesamt.pdf', reason: 'size' },
      { mail: '2025-04-09 16.22 – Anna Berger', file: 'AW Termin', reason: 'embedded_message' },
    ],
  }),
  row({
    id: 'imp-failed',
    filename: 'alt.pst',
    sizeBytes: 640_000_000,
    status: 'failed',
    totalItems: null,
    processedItems: 0,
    mailsFiled: 0,
    filesFiled: 0,
    itemsSkipped: 0,
    folderId: null,
    errorCode: 'unreadable',
    error: 'The archive could not be read: not a readable Outlook archive',
  }),
  row({ id: 'imp-cancelled', filename: 'Test.ost', status: 'cancelled', mailsFiled: 12, filesFiled: 4, itemsSkipped: 0 }),
  row({
    id: 'imp-colleague',
    filename: 'Projektpostfach.pst',
    status: 'queued',
    ownedByViewer: false,
    // The viewer administers every project, so may stop a colleague's import.
    cancellable: true,
    startedBy: { userId: 'u-max', email: 'max.gruber@buero.at' },
    folderId: null,
    totalItems: null,
    processedItems: 0,
    mailsFiled: 0,
    filesFiled: 0,
    itemsSkipped: 0,
    completedAt: null,
  }),
]

function state(variant: string): UseMailImports {
  const noop = async () => {}
  const base: UseMailImports = {
    list: { imports: HISTORY, maxSizeBytes: 25e9, partSize: PART },
    loadError: false,
    sending: null,
    sendError: null,
    cancelError: false,
    dismissErrors: () => {},
    start: noop,
    resume: noop,
    cancel: async () => true,
  }
  if (variant === 'empty') return { ...base, list: { ...base.list!, imports: [] } }
  if (variant === 'sending') {
    const uploading = row({
      id: 'imp-sending',
      filename: 'Postfach Bauleitung 2026.pst',
      status: 'uploading',
      cancellable: true,
      sizeBytes: 9_300_000_000,
      folderId: null,
      totalItems: null,
      processedItems: 0,
      mailsFiled: 0,
      filesFiled: 0,
      itemsSkipped: 0,
      completedAt: null,
    })
    const broken = row({ ...uploading, id: 'imp-broken', filename: 'Archiv Stiege 3.pst', sizeBytes: 2_100_000_000 })
    return {
      ...base,
      list: { ...base.list!, imports: [uploading, broken, ...HISTORY.slice(1, 3)] },
      sending: {
        projectId: PROJECT,
        importId: 'imp-sending',
        filename: uploading.filename,
        sentBytes: 3_960_000_000,
        totalBytes: uploading.sizeBytes,
        phase: 'sending',
      },
    }
  }
  if (variant === 'error') return { ...base, sendError: 'connection' }
  return base
}

export default function MailImportPreview() {
  const variant = useSearchParams()?.get('variant') ?? 'default'
  return (
    <main className="min-h-screen bg-background p-8" data-testid="mail-import-preview">
      <MailImportDialogView projectId={PROJECT} open onOpenChange={() => {}} state={state(variant)} />
    </main>
  )
}
