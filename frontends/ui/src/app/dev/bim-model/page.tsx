'use client'

/**
 * Dev preview for the IFC/BIM model surfaces.
 *
 * Renders the REAL explorer components (overview, spatial tree, element table,
 * property panel) plus the viewer's no-WebGPU fallback against fixture data
 * matching `tests/fixtures/ifc/sample-building.ifc`, so the layout is
 * reviewable and screenshottable without a backend, an upload, or a GPU.
 *
 * The 3D viewport itself is deliberately NOT exercised here: headless Chromium
 * has no WebGPU adapter, so a screenshot of it would be a picture of the
 * fallback either way — and the fallback is the state worth pinning, because it
 * is what a Safari or Firefox user actually sees.
 *
 * Not linked from anywhere and 404s outside development.
 */

import { useState } from 'react'
import { notFound } from 'next/navigation'
import {
  IfcElementTable,
  IfcModelHealthPanel,
  IfcModelOverview,
  IfcPropertyPanel,
  IfcSpatialTree,
} from '@/features/bim/components/ifc-model-explorer'
import { IfcModelCompare } from '@/features/bim/components/ifc-model-compare'
import { IfcModelViewer } from '@/features/bim/components/ifc-model-viewer'
import type { BimModelSummary } from '@/lib/bim/types'
import type { BimViewerElement } from '@/features/bim/lib/model-index'
import type { BimElementDetail } from '@/features/bim/hooks/use-bim-model'

const SUMMARY: BimModelSummary = {
  schema: 'IFC4',
  header: {
    name: 'wohnhaus-beispielgasse.ifc',
    timeStamp: '2026-02-03T10:00:00',
    author: ['A. Muster'],
    organization: ['Musterbüro ZT GmbH'],
    preprocessorVersion: 'IFC4 Exporter 26.1',
    originatingSystem: 'Autodesk Revit 2026',
    description: ['ViewDefinition [CoordinationView_V2.0]'],
  },
  units: {
    length: { symbol: 'mm', siScale: 0.001 },
    area: { symbol: 'm²', siScale: 1 },
    volume: { symbol: 'm³', siScale: 1 },
  },
  projectName: 'Wohnhaus Beispielgasse',
  siteName: 'Grundstück Beispielgasse 12',
  buildingNames: ['Haus A'],
  storeys: [
    { globalId: 'g-kg', expressId: 15, name: 'Kellergeschoss', elevation: -2.85, elementCount: 24 },
    { globalId: 'g-eg', expressId: 16, name: 'Erdgeschoss', elevation: 0, elementCount: 62 },
    { globalId: 'g-og', expressId: 17, name: '1. Obergeschoss', elevation: 3, elementCount: 58 },
    { globalId: 'g-dg', expressId: 18, name: 'Dachgeschoss', elevation: 6, elementCount: 31 },
  ],
  spatial: {
    globalId: 'g-project',
    expressId: 13,
    ifcType: 'IfcProject',
    name: 'Wohnhaus Beispielgasse',
    elevation: null,
    elementCount: 0,
    children: [
      {
        globalId: 'g-site',
        expressId: 14,
        ifcType: 'IfcSite',
        name: 'Grundstück Beispielgasse 12',
        elevation: null,
        elementCount: 0,
        children: [
          {
            globalId: 'g-building',
            expressId: 15,
            ifcType: 'IfcBuilding',
            name: 'Haus A',
            elevation: null,
            elementCount: 0,
            children: [
              {
                globalId: 'g-kg',
                expressId: 15,
                ifcType: 'IfcBuildingStorey',
                name: 'Kellergeschoss',
                elevation: -2.85,
                elementCount: 24,
                children: [],
              },
              {
                globalId: 'g-eg',
                expressId: 16,
                ifcType: 'IfcBuildingStorey',
                name: 'Erdgeschoss',
                elevation: 0,
                elementCount: 62,
                children: [
                  {
                    globalId: 'g-space-wohn',
                    expressId: 36,
                    ifcType: 'IfcSpace',
                    name: 'Wohnzimmer',
                    elevation: null,
                    elementCount: 0,
                    children: [],
                  },
                  {
                    globalId: 'g-space-kueche',
                    expressId: 37,
                    ifcType: 'IfcSpace',
                    name: 'Küche',
                    elevation: null,
                    elementCount: 0,
                    children: [],
                  },
                ],
              },
              {
                globalId: 'g-og',
                expressId: 17,
                ifcType: 'IfcBuildingStorey',
                name: '1. Obergeschoss',
                elevation: 3,
                elementCount: 58,
                children: [],
              },
              {
                globalId: 'g-dg',
                expressId: 18,
                ifcType: 'IfcBuildingStorey',
                name: 'Dachgeschoss',
                elevation: 6,
                elementCount: 31,
                children: [],
              },
            ],
          },
        ],
      },
    ],
  },
  typeCounts: {
    IfcWall: 64,
    IfcDoor: 28,
    IfcWindow: 26,
    IfcSpace: 22,
    IfcSlab: 12,
    IfcColumn: 11,
    IfcStair: 4,
    IfcRailing: 4,
    IfcRoof: 2,
    IfcBeam: 2,
  },
  propertySetNames: ['Pset_DoorCommon', 'Pset_WallCommon', 'Pset_WindowCommon'],
  quantitySetNames: ['Qto_SpaceBaseQuantities', 'Qto_WallBaseQuantities'],
  materialNames: ['Aussenputz', 'Stahlbeton', 'Wärmedämmung EPS'],
  totals: { entities: 18_442, elements: 175, spaces: 22, storeys: 4 },
  quantityTotals: { netFloorAreaM2: 486.4, grossFloorAreaM2: 524.75, netVolumeM3: 1264.6 },
  health: {
    score: 82,
    totals: { error: 1, warning: 2, info: 1 },
    issues: [
      {
        rule: 'spatial-orphan-elements',
        stage: 'spatial',
        severity: 'error',
        count: 6,
        total: 175,
        sampleGlobalIds: ['g-w4'],
        detail: null,
      },
      {
        rule: 'complete-space-without-area',
        stage: 'complete',
        severity: 'warning',
        count: 3,
        total: 22,
        sampleGlobalIds: ['g-s3'],
        detail: null,
      },
      {
        rule: 'properties-missing-common-pset',
        stage: 'properties',
        severity: 'warning',
        count: 11,
        total: 64,
        sampleGlobalIds: ['g-w3'],
        detail: 'IfcWall · Pset_WallCommon',
      },
      {
        rule: 'complete-no-classifications',
        stage: 'complete',
        severity: 'info',
        count: 175,
        total: 175,
        sampleGlobalIds: [],
        detail: null,
      },
    ],
  },
  parseMs: 412,
  fileSizeBytes: 24_118_402,
  truncatedAt: null,
}

const ELEMENTS: BimViewerElement[] = [
  { globalId: 'g-w1', expressId: 21, ifcType: 'IfcWall', name: 'Außenwand Nord', storeyName: 'Erdgeschoss', tag: 'W-01' },
  { globalId: 'g-w2', expressId: 22, ifcType: 'IfcWall', name: 'Außenwand Süd', storeyName: 'Erdgeschoss', tag: 'W-02' },
  { globalId: 'g-w3', expressId: 23, ifcType: 'IfcWall', name: 'Innenwand EG', storeyName: 'Erdgeschoss', tag: 'W-03' },
  { globalId: 'g-d1', expressId: 26, ifcType: 'IfcDoor', name: 'Eingangstür', storeyName: 'Erdgeschoss', tag: 'T-01' },
  { globalId: 'g-d2', expressId: 27, ifcType: 'IfcDoor', name: 'Zimmertür EG', storeyName: 'Erdgeschoss', tag: 'T-02' },
  { globalId: 'g-f1', expressId: 28, ifcType: 'IfcWindow', name: 'Fenster Süd 1', storeyName: 'Erdgeschoss', tag: 'F-01' },
  { globalId: 'g-s1', expressId: 36, ifcType: 'IfcSpace', name: 'Wohnzimmer', storeyName: 'Erdgeschoss' },
  { globalId: 'g-s2', expressId: 37, ifcType: 'IfcSpace', name: 'Küche', storeyName: 'Erdgeschoss' },
  { globalId: 'g-w4', expressId: 24, ifcType: 'IfcWall', name: 'Außenwand Nord OG', storeyName: '1. Obergeschoss', tag: 'W-04' },
  { globalId: 'g-s3', expressId: 38, ifcType: 'IfcSpace', name: 'Schlafzimmer', storeyName: '1. Obergeschoss' },
  { globalId: 'g-st1', expressId: 33, ifcType: 'IfcStair', name: 'Treppe EG–OG', storeyName: 'Erdgeschoss', tag: 'S-01' },
  { globalId: 'g-r1', expressId: 35, ifcType: 'IfcRoof', name: 'Flachdach', storeyName: 'Dachgeschoss', tag: 'R-01' },
]

const SELECTED: BimElementDetail = {
  globalId: 'g-w1',
  expressId: 21,
  ifcType: 'IfcWall',
  name: 'Außenwand Nord',
  description: null,
  predefinedType: 'SOLIDWALL',
  objectType: null,
  tag: 'W-01',
  typeName: 'AW 38 Stahlbeton',
  storeyName: 'Erdgeschoss',
  materials: ['Stahlbeton', 'Wärmedämmung EPS', 'Aussenputz'],
  classifications: [{ system: 'ON B 1800', identification: 'B.1.2', name: 'Außenwand' }],
  properties: {
    Pset_WallCommon: {
      IsExternal: true,
      LoadBearing: true,
      FireRating: 'REI 90',
      ThermalTransmittance: 0.18,
      Reference: 'AW38',
    },
  },
  quantities: { Qto_WallBaseQuantities: { NetSideArea: 24.5, NetVolume: 7.35, Length: 8.2 } },
}

export default function BimModelPreviewPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <BimModelPreview />
}

function BimModelPreview(): JSX.Element {
  const [storey, setStorey] = useState<string | null>('Erdgeschoss')
  const [selected, setSelected] = useState<string | null>('g-w1')

  return (
    <div
      data-testid="bim-model-preview"
      className="bg-background text-foreground min-h-dvh p-6"
    >
      <div className="mx-auto grid max-w-[1200px] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="flex flex-col gap-5">
          <IfcModelOverview summary={SUMMARY} filename="wohnhaus-beispielgasse.ifc" />
          {SUMMARY.health && <IfcModelHealthPanel health={SUMMARY.health} />}
          <IfcSpatialTree summary={SUMMARY} selectedStorey={storey} onSelectStorey={setStorey} />
          <IfcElementTable
            elements={ELEMENTS}
            storeyFilter={storey}
            selectedGlobalId={selected}
            onSelect={(element) => setSelected(element.globalId)}
          />
          <IfcModelCompare
            modelId="model-v2"
            candidates={[
              {
                id: 'model-v1',
                documentId: 'doc-v1',
                projectId: 'p1',
                filename: 'wohnhaus-beispielgasse-v1.ifc',
                status: 'ready',
                schemaVersion: 'IFC4',
                elementCount: 171,
                errorMessage: null,
                summary: null,
              },
            ]}
          />
        </div>
        <div className="flex flex-col gap-4">
          <IfcModelViewer sourceUrl={null} elements={ELEMENTS} className="h-[320px]" />
          <section className="rounded-lg border p-3">
            <h2 className="mb-2 text-sm font-semibold">Properties</h2>
            <IfcPropertyPanel element={SELECTED} isLoading={false} error={null} />
          </section>
        </div>
      </div>
    </div>
  )
}
