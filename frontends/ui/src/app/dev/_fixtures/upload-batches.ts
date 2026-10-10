/**
 * Upload summaries and history rows for the `/dev/upload-summary` and
 * `/dev/upload-history` previews and the specs: one mixed batch that exercises
 * every branch of the summary, and a history with the reader's own and a
 * colleague's uploads. Typed as the wire types, so a fixture that stops
 * matching the endpoint fails to compile.
 */

import type { UploadHistoryEntry, UploadSummary } from '@/adapters/api/upload-batches-client'

export const FIXTURE_PROJECT_ID = 'proj-stadthaus'
export const FIXTURE_PROJECT_NAME = 'Stadthaus Lindengasse'
export const FIXTURE_USER_ID = 'user_01JOWN'
export const FIXTURE_COLLEAGUE_ID = 'user_01JCOLLEAGUE'

/**
 * A folder upload into a project with one file still being read: every
 * outcome, every note, two folders and the root. „Gutachten" has its own
 * access list, so both files there are protected, and the Brandschutzkonzept
 * was there already: this upload is a new version of it. Open, so the summary
 * polls.
 */
export const MIXED_SUMMARY: UploadSummary = {
  id: '0f0e4c1e-6d7a-4b8e-9a51-3c2d1e0f9a10',
  scope: 'project',
  projectId: FIXTURE_PROJECT_ID,
  conversationId: null,
  createdAt: '2026-10-01T08:12:00.000Z',
  sealedAt: '2026-10-01T08:13:10.000Z',
  completedAt: null,
  expectedCount: 14,
  unchangedCount: 4,
  failedCount: 1,
  excluded: [
    { term: 'Rechnung', count: 3 },
    { term: 'Lohnzettel', count: 1 },
  ],
  documents: [
    {
      id: 'doc-grundriss-eg',
      filename: 'EG_Grundriss_M100.pdf',
      displayName: 'Grundriss Erdgeschoss 1:100',
      folderPath: 'Pläne/Einreichung',
      status: 'ready',
      outcome: 'ready',
      screening: 'clean',
      quarantine: null,
      errorMessage: null,
      summary:
        'Einreichplan Erdgeschoss im Maßstab 1:100 mit Raumbezeichnungen, Flächenangaben und Fluchtwegen. Zeigt den barrierefreien Zugang an der Lindengasse, das Stiegenhaus mit Aufzug und die Lage der Fahrradabstellräume im Hof.',
      tags: ['Grundriss', 'Nutzungssicherheit/Barrierefreiheit'],
      pageCount: 1,
      replaced: false,
      restricted: false,
    },
    {
      id: 'doc-schnitt-aa',
      filename: 'Schnitt_A-A.pdf',
      displayName: null,
      folderPath: 'Pläne/Einreichung',
      status: 'ready',
      outcome: 'ready',
      screening: 'partial',
      quarantine: null,
      errorMessage: null,
      summary: 'Gebäudeschnitt A-A durch Stiegenhaus und Innenhof mit Geschoßhöhen und Traufhöhe.',
      tags: ['Schnitt', 'Brandschutz'],
      pageCount: 2,
      replaced: false,
      restricted: false,
    },
    {
      id: 'doc-brandschutz',
      filename: 'Brandschutzkonzept_v3.pdf',
      displayName: 'Brandschutzkonzept Version 3',
      folderPath: 'Gutachten',
      status: 'processing',
      outcome: 'reading',
      screening: null,
      quarantine: null,
      errorMessage: null,
      summary: null,
      tags: [],
      pageCount: null,
      replaced: true,
      restricted: true,
    },
    {
      id: 'doc-honorar',
      filename: 'Honorarvereinbarung_Statik.pdf',
      displayName: null,
      folderPath: 'Gutachten',
      status: 'quarantined',
      outcome: 'quarantined',
      screening: 'quarantined',
      quarantine: {
        reasons: [
          { kind: 'term', term: 'Honorar', count: 3, pages: [1, 4] },
          { kind: 'iban', sample: 'AT61 •••• •••• •••• 3456', count: 1 },
        ],
        checked: 'full',
      },
      errorMessage: null,
      summary: null,
      tags: [],
      pageCount: 4,
      replaced: false,
      restricted: true,
    },
    {
      id: 'doc-scan',
      filename: 'Bescheid_MA37_Scan.pdf',
      displayName: null,
      folderPath: null,
      status: 'failed',
      outcome: 'failed',
      screening: 'unchecked',
      quarantine: null,
      errorMessage: 'pdf_pages_unreadable: 3 of 12 pages could not be read',
      summary: null,
      tags: [],
      pageCount: 12,
      replaced: false,
      restricted: false,
    },
    {
      id: 'doc-foto',
      filename: 'Bestand_Fassade_Nord.jpg',
      displayName: null,
      folderPath: null,
      status: 'ready',
      outcome: 'ready',
      screening: 'unchecked',
      quarantine: null,
      errorMessage: null,
      summary: 'Foto der Nordfassade im Bestand mit Gesimsen und Fensterachsen.',
      tags: ['Foto'],
      pageCount: null,
      replaced: false,
      restricted: false,
    },
  ],
}

/** The same batch once the last file has been read: complete, so the summary stops asking. */
export const SETTLED_SUMMARY: UploadSummary = {
  ...MIXED_SUMMARY,
  completedAt: '2026-10-01T08:21:40.000Z',
  documents: MIXED_SUMMARY.documents.map((document) =>
    document.outcome === 'reading'
      ? {
          ...document,
          status: 'ready',
          outcome: 'ready',
          screening: 'clean',
          summary: 'Brandschutzkonzept für Gebäudeklasse 4 nach OIB-Richtlinie 2 mit Fluchtwegen und Brandabschnitten.',
          tags: ['Gutachten', 'Brandschutz'],
          pageCount: 18,
        }
      : document
  ),
}

/** The reader's own uploads and a colleague's, newest first. */
export const HISTORY: UploadHistoryEntry[] = [
  {
    id: MIXED_SUMMARY.id,
    createdBy: FIXTURE_USER_ID,
    createdByName: 'Mara Lindner',
    createdAt: '2026-10-01T08:12:00.000Z',
    completedAt: null,
    expectedCount: 14,
    unchangedCount: 4,
    failedCount: 1,
    excludedCount: 4,
    counts: { ready: 3, reading: 1, quarantined: 1, failed: 1, stored: 0 },
  },
  {
    id: '7c1d9e2f-3a4b-4c5d-8e6f-0a1b2c3d4e5f',
    createdBy: FIXTURE_COLLEAGUE_ID,
    createdByName: 'Jonas Berger',
    createdAt: '2026-09-29T14:40:00.000Z',
    completedAt: '2026-09-29T14:52:00.000Z',
    expectedCount: 38,
    unchangedCount: 0,
    failedCount: 0,
    excludedCount: 0,
    counts: { ready: 37, reading: 0, quarantined: 1, failed: 0, stored: 0 },
  },
  {
    id: '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a',
    createdBy: FIXTURE_USER_ID,
    createdByName: 'Mara Lindner',
    createdAt: '2026-09-22T09:05:00.000Z',
    completedAt: '2026-09-22T09:06:30.000Z',
    expectedCount: 2,
    unchangedCount: 2,
    failedCount: 0,
    excludedCount: 0,
    counts: { ready: 0, reading: 0, quarantined: 0, failed: 0, stored: 0 },
  },
]
