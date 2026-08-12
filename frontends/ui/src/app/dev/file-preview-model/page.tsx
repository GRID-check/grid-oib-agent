'use client'

/**
 * Dev preview for an `.ifc` opened in the Dateien pane — the same real
 * `FilePreviewDialog` as `/dev/file-preview`, with a model fixture instead of a
 * document one, so the two can be compared side by side.
 *
 * A module-scope fetch shim (browser + dev only) serves the project's model
 * list, the element query and — as a blob — a real, tiny IFC, so the viewport
 * parses an actual building with no backend, no object store and no fixture in
 * `public/`. Whether the capture ends up showing the geometry or the viewer's
 * degraded state depends on the WebGPU adapter the capturing browser has; both
 * are worth pinning, and the degraded one has to read as "the picture is
 * missing, the model is over there", never as "this file is broken".
 *
 * Not linked from anywhere and 404s outside development.
 */

import { notFound } from 'next/navigation'
import { FilePreviewDialog } from '@/features/documents/components/file-preview-dialog'
import type { FileItem } from '@/features/documents/components/project-file-workspace'
import type { BimModelHeaderView } from '@/features/bim/hooks/use-bim-model'
import type { BimModelSummary } from '@/lib/bim/types'
import { SAMPLE_IFC } from './sample-model'

const PROJECT_ID = 'proj-demo'

const FIXTURE: FileItem = {
  id: 'dev-model-1',
  filename: 'Wohnhaus-Grungasse-14_V3.ifc',
  displayName: null,
  fileSize: 148_900_000,
  // What an object store reports for an IFC. The preview must not depend on it:
  // exporters disagree, and the file name is the reliable signal.
  contentType: 'application/octet-stream',
  status: 'ready',
  folderId: null,
  createdAt: '2026-08-04T08:30:00Z',
  errorMessage: null,
  summary:
    'IFC4-Modell des Wohnhauses Grungasse 14 (Bauteil A), exportiert aus ArchiCAD 27. ' +
    'Vier Geschoße über Erdgeschoß, 1 842 Bauteile, davon 214 Wände, 96 Türen und 41 Räume ' +
    'mit veröffentlichten Flächen. Der Assistent beantwortet Fragen zum Gebäude aus diesem Modell.',
  pageCount: null,
  chunkCount: 6,
  contentTypes: ['text'],
  tags: ['Einreichplanung'],
}

/**
 * What extraction read out of the file. Typed rather than hand-shaped, so the
 * fixture cannot drift away from the payload the rail actually receives.
 *
 * `grossFloorAreaM2` and `netVolumeM3` are deliberately null: an ArchiCAD
 * export that publishes `Qto_SpaceBaseQuantities` but no gross figures is the
 * common case, and the rail must be seen omitting those rows rather than
 * printing a zero.
 */
const SUMMARY: BimModelSummary = {
  schema: 'IFC4',
  header: {
    name: FIXTURE.filename,
    description: [],
    author: ['A. Muster'],
    organization: ['Musterbüro ZT GmbH'],
    preprocessorVersion: null,
    originatingSystem: 'ArchiCAD 27',
    timeStamp: '2026-08-04T08:30:00',
  },
  units: {
    length: { symbol: 'mm', siScale: 0.001 },
    area: { symbol: 'm²', siScale: 1 },
    volume: { symbol: 'm³', siScale: 1 },
  },
  projectName: 'Wohnhaus Grungasse 14',
  siteName: null,
  buildingNames: ['Bauteil A'],
  storeys: [],
  spatial: null,
  typeCounts: {},
  propertySetNames: [],
  quantitySetNames: [],
  materialNames: [],
  totals: { entities: 41_208, elements: 1842, spaces: 41, storeys: 5 },
  quantityTotals: { netFloorAreaM2: 1240.5, grossFloorAreaM2: null, netVolumeM3: null },
  health: null,
  parseMs: 4_180,
  fileSizeBytes: 148_900_000,
  truncatedAt: null,
}

const MODEL: BimModelHeaderView = {
  id: 'dev-bim-1',
  documentId: FIXTURE.id,
  projectId: PROJECT_ID,
  filename: FIXTURE.filename,
  displayName: null,
  status: 'ready',
  schemaVersion: 'IFC4',
  elementCount: SUMMARY.totals.elements,
  errorMessage: null,
  summary: SUMMARY,
  updatedAt: '2026-08-04T08:34:00Z',
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __filePreviewModelShim?: boolean }
  if (!w.__filePreviewModelShim) {
    w.__filePreviewModelShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      // Scoped to THIS fixture's ids. The shim is installed at module scope
      // and survives client-side navigation, so a broad pattern went on
      // answering for every project and model in the dev session — a real dev
      // page opened afterwards would be served this fixture instead of its own
      // data.
      if (url.includes(`/api/projects/${PROJECT_ID}/bim/models`)) {
        return Response.json({ models: [MODEL] })
      }
      if (/\/api\/bim\/models\/dev-bim-1\/query$/.test(url)) {
        // Empty on purpose: the pane shows the building, and every table that
        // would need element rows lives in the workspace one link away.
        return Response.json({ elements: [], total: 0 })
      }
      // A real (tiny) IFC, handed over as a blob the viewport can fetch and
      // parse exactly as it would the presigned object-store URL.
      if (/\/api\/bim\/models\/dev-bim-1\/source$/.test(url)) {
        return Response.json({ url: URL.createObjectURL(new Blob([SAMPLE_IFC])) })
      }
      return real(input, init)
    }
  }
}

export default function FilePreviewModelDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <FilePreviewDialog
      file={FIXTURE}
      projectId={PROJECT_ID}
      projectName="Wohnbau Nord — Linz"
      canManage
      onClose={() => {}}
    />
  )
}
