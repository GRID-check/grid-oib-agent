'use client'

/**
 * Dev preview for the model surfaces that turn a file into work products:
 * the Raumbuch, the Massenermittlung, the derived project facts, the revision
 * timeline, and an element chip as it appears inside a chat answer.
 *
 * Fixtures are shaped after `tests/fixtures/ifc/sample-building.ifc`, and they
 * deliberately include the awkward cases — a room with no published area, a
 * wall group with no material, a revision whose extraction failed — because
 * those are the states these components exist to render honestly. A screenshot
 * of only the happy path would prove nothing.
 *
 * Not linked from anywhere and 404s outside development.
 */

import { useState } from 'react'
import { notFound } from 'next/navigation'
import {
  IfcProfileSuggestions,
  IfcQuantityTakeoff,
  IfcRoomSchedule,
} from '@/features/bim/components/ifc-model-tables'
import { IfcRevisionTimeline } from '@/features/bim/components/ifc-revision-timeline'
import { IfcElementChip } from '@/features/bim/components/ifc-element-chip'
import { groupModelRevisions } from '@/features/bim/lib/revisions'
import { parseElementLink } from '@/features/bim/lib/element-question'
import type { BimModelHeaderView } from '@/features/bim/hooks/use-bim-model'
import type { BimProfileSuggestion } from '@/lib/bim/profile'
import type { BimQuantityRow, BimRoomSchedule } from '@/lib/bim/schedule'
import type { BimModelSummary } from '@/lib/bim/types'

const SCHEDULE: BimRoomSchedule = {
  storeys: [
    {
      storeyName: 'Erdgeschoss',
      elevation: 0,
      rooms: [
        {
          globalId: 'g-r01',
          name: 'Wohnen/Essen',
          storeyName: 'Erdgeschoss',
          category: 'INTERNAL',
          netFloorArea: 38.4,
          grossFloorArea: 41.2,
          netVolume: 96,
          height: 2.5,
        },
        {
          globalId: 'g-r02',
          name: 'Küche',
          storeyName: 'Erdgeschoss',
          category: 'INTERNAL',
          netFloorArea: 12.5,
          grossFloorArea: 13.8,
          netVolume: 31.25,
          height: 2.5,
        },
        {
          globalId: 'g-r03',
          name: 'Technik',
          storeyName: 'Erdgeschoss',
          category: 'INTERNAL',
          netFloorArea: null,
          grossFloorArea: null,
          netVolume: null,
          height: null,
        },
      ],
      netFloorArea: 50.9,
      grossFloorArea: 55,
      netVolume: 127.25,
      roomsWithoutArea: 1,
    },
    {
      storeyName: '1. Obergeschoss',
      elevation: 3,
      rooms: [
        {
          globalId: 'g-r04',
          name: 'Schlafen',
          storeyName: '1. Obergeschoss',
          category: 'INTERNAL',
          netFloorArea: 18.2,
          grossFloorArea: 19.6,
          netVolume: 45.5,
          height: 2.5,
        },
        {
          globalId: 'g-r05',
          name: 'Kind 1',
          storeyName: '1. Obergeschoss',
          category: 'INTERNAL',
          netFloorArea: 14.1,
          grossFloorArea: 15.3,
          netVolume: 35.25,
          height: 2.5,
        },
      ],
      netFloorArea: 32.3,
      grossFloorArea: 34.9,
      netVolume: 80.75,
      roomsWithoutArea: 0,
    },
  ],
  totals: {
    rooms: 5,
    roomsWithoutArea: 1,
    netFloorArea: 83.2,
    grossFloorArea: 89.9,
    netVolume: 208,
  },
  units: { area: 'm²', volume: 'm³', length: 'm' },
}

const TAKEOFF: BimQuantityRow[] = [
  { group: 'IfcWall · Stahlbeton', elements: 34, value: 412.8, missing: 0 },
  { group: 'IfcWall · Ziegel', elements: 21, value: 188.4, missing: 2 },
  { group: 'IfcWall · (ohne Material)', elements: 3, value: null, missing: 3 },
]

const SUGGESTIONS: BimProfileSuggestion[] = [
  {
    key: 'geschosse_oberirdisch',
    value: 3,
    confidence: 'high',
    evidence: '3 Geschosse mit Höhenlage ≥ 0 im Modell: Erdgeschoss, 1. Obergeschoss, Dachgeschoss',
  },
  {
    key: 'geschosse_unterirdisch',
    value: 1,
    confidence: 'high',
    evidence: '1 Geschosse mit negativer Höhenlage: Kellergeschoss (-2.85 m)',
  },
  {
    key: 'fluchtniveau',
    value: '<=7m',
    confidence: 'medium',
    evidence: 'Oberstes belegtes Geschoss liegt bei 6 m (Dachgeschoss)',
  },
  {
    key: 'hauptnutzung',
    value: 'wohnen',
    confidence: 'medium',
    evidence: '7 Räume im Modell tragen Namen dieser Nutzung',
  },
]

function summary(elements: number, spaces: number, score: number): BimModelSummary {
  return {
    schema: 'IFC4',
    header: {
      name: null,
      timeStamp: null,
      author: [],
      organization: [],
      preprocessorVersion: null,
      originatingSystem: null,
      description: [],
    },
    units: { length: null, area: { symbol: 'm²', siScale: 1 }, volume: null },
    projectName: null,
    siteName: null,
    buildingNames: [],
    storeys: [],
    spatial: null,
    typeCounts: {},
    propertySetNames: [],
    quantitySetNames: [],
    materialNames: [],
    totals: { entities: 0, elements, spaces, storeys: 4 },
    quantityTotals: { netFloorAreaM2: 402.5, grossFloorAreaM2: null, netVolumeM3: null },
    health: { score, issues: [], totals: { error: 0, warning: 0, info: 0 } },
    parseMs: 1,
    fileSizeBytes: 1,
    truncatedAt: null,
  }
}

function model(
  filename: string,
  updatedAt: string,
  modelSummary: BimModelSummary | null
): BimModelHeaderView {
  return {
    id: `id-${filename}`,
    documentId: `doc-${filename}`,
    projectId: 'p1',
    filename,
    status: modelSummary ? 'ready' : 'failed',
    schemaVersion: 'IFC4',
    elementCount: modelSummary?.totals.elements ?? 0,
    errorMessage: modelSummary ? null : 'Die Datei konnte nicht gelesen werden.',
    summary: modelSummary,
    updatedAt,
  }
}

const SERIES = groupModelRevisions([
  model('wohnhaus-beispielgasse.ifc', '2026-01-08T09:00:00.000Z', summary(171, 12, 74)),
  model('wohnhaus-beispielgasse_V2.ifc', '2026-02-11T09:00:00.000Z', summary(188, 12, 82)),
  model('wohnhaus-beispielgasse_V3.ifc', '2026-03-02T09:00:00.000Z', summary(188, 11, 82)),
])[0]

const CHIP_LINK = parseElementLink(
  '/app/projects/p1/model?model=wohnhaus-beispielgasse_V3.ifc&element=1kTvXnbbzCWw8lcMd1dR4o&hl=fail:1kTvXnbbzCWw8lcMd1dR4o&xray=1'
)

export default function BimTablesPreviewPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <BimTablesPreview />
}

function BimTablesPreview(): JSX.Element {
  const [quantity, setQuantity] = useState('NetSideArea')
  const [byMaterial, setByMaterial] = useState(true)

  return (
    <div data-testid="bim-tables-preview" className="bg-background text-foreground min-h-dvh p-6">
      <div className="mx-auto grid max-w-[1200px] gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-8">
          <IfcRoomSchedule
            schedule={SCHEDULE}
            isLoading={false}
            error={null}
            filename="wohnhaus-beispielgasse.ifc"
            selectedGlobalId="g-r02"
            onSelect={() => {}}
          />
          <IfcQuantityTakeoff
            rows={TAKEOFF}
            isLoading={false}
            error={null}
            quantity={quantity}
            onQuantityChange={setQuantity}
            byMaterial={byMaterial}
            onByMaterialChange={setByMaterial}
          />
        </div>
        <div className="flex flex-col gap-8">
          <IfcRevisionTimeline
            series={SERIES}
            currentModelId="id-wohnhaus-beispielgasse_V3.ifc"
            onOpen={() => {}}
            onCompareWithPrevious={() => {}}
          />
          <IfcProfileSuggestions
            suggestions={SUGGESTIONS}
            isLoading={false}
            error={null}
            askHref="/app/projects/p1/chat?ask=x"
          />
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Element chip in an answer</h2>
            <p className="text-sm leading-relaxed text-foreground">
              Die Trennwand zwischen Stiegenhaus und Wohnung 03 —{' '}
              {CHIP_LINK && <IfcElementChip link={CHIP_LINK}>Innenwand IW-12</IfcElementChip>} —
              führt kein Pset mit Feuerwiderstand.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
