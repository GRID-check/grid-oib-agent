'use client'

/**
 * Dev preview for the Prüfbuch.
 *
 * The fixture is deliberately a MESSY project, because the clean case proves
 * nothing: two failing doors, thirty-four walls whose fire rating the model
 * never published, a rule that stood down because the brief has no
 * Gebäudeklasse, and a rule with no affected elements at all. Those four states
 * are the ones the panel exists to render honestly, and a screenshot of a green
 * list would hide every one of them.
 *
 * Not linked from anywhere and 404s outside development.
 */

import { notFound } from 'next/navigation'
import { IfcCompliancePanel } from '@/features/bim/components/ifc-compliance-panel'
import type { BimRuleResult } from '@/lib/bim/rules'

function rule(overrides: Partial<BimRuleResult> & Pick<BimRuleResult, 'ruleId'>): BimRuleResult {
  return {
    richtlinie: 'OIB 2',
    clause: '3',
    titleDe: 'Tragende Bauteile — Feuerwiderstand',
    thresholdDe: 'Feuerwiderstand nach Gebäudeklasse (GK1 R 30 … GK5 REI 90)',
    applicable: true,
    passed: 0,
    failed: 0,
    undecidable: 0,
    failures: [],
    unknowns: [],
    truncated: false,
    missing: [],
    ...overrides,
  }
}

const RULES: BimRuleResult[] = [
  rule({
    ruleId: 'oib4-tuer-durchgangsbreite',
    richtlinie: 'OIB 4',
    clause: '3',
    titleDe: 'Türen — lichte Durchgangsbreite',
    thresholdDe: 'lichte Durchgangsbreite ≥ 0,80 m',
    passed: 22,
    failed: 2,
    failures: [
      {
        globalId: '1kTvXnbbzCWw8lcMd1dR4o',
        name: 'T-14 Abstellraum',
        storeyName: 'Erdgeschoss',
        status: 'fail',
        reading: 'Breite 0,7 m — Schwellwert ≥ 0,80 m',
      },
      {
        globalId: '0RSwXnbbzCWw8lcMd1dR9z',
        name: 'T-21 Technik',
        storeyName: 'Kellergeschoss',
        status: 'fail',
        reading: 'Breite 0,75 m — Schwellwert ≥ 0,80 m',
      },
    ],
  }),
  rule({
    ruleId: 'oib4-treppe-steigungsverhaeltnis',
    richtlinie: 'OIB 4',
    clause: '2.2',
    titleDe: 'Treppen — Steigungsverhältnis',
    thresholdDe: '2 × Steigung + Auftritt = 59–65 cm, Steigung ≤ 18 cm, Auftritt ≥ 28 cm',
    passed: 3,
  }),
  rule({
    ruleId: 'oib2-feuerwiderstand-tragend',
    undecidable: 34,
    unknowns: [
      {
        globalId: '2mUvXnbbzCWw8lcMd1dR7q',
        name: 'AW 38 Nord',
        storeyName: 'Erdgeschoss',
        status: 'undecidable',
        reading: 'Kein Feuerwiderstand am Bauteil hinterlegt — erforderlich REI 60',
      },
      {
        globalId: '3nWvXnbbzCWw8lcMd1dR2p',
        name: 'IW 20 Stiegenhaus',
        storeyName: '1. Obergeschoss',
        status: 'undecidable',
        reading: 'Feuerwiderstand „F 90“ nicht mit REI 60 vergleichbar (andere oder unlesbare Klassifizierung) — bitte manuell prüfen',
      },
    ],
    missing: [{ path: 'Pset_WallCommon.FireRating', elements: 34 }],
  }),
  rule({
    ruleId: 'oib3-raumhoehe',
    richtlinie: 'OIB 3',
    clause: '2',
    titleDe: 'Aufenthaltsräume — lichte Raumhöhe',
    thresholdDe: 'lichte Raumhöhe ≥ 2,50 m',
    passed: 9,
    undecidable: 2,
    unknowns: [
      {
        globalId: '4pXvXnbbzCWw8lcMd1dR5t',
        name: 'Kind 2',
        storeyName: 'Dachgeschoss',
        status: 'undecidable',
        reading: 'Keine Raumhöhe im Modell veröffentlicht',
      },
    ],
    missing: [{ path: 'Qto_SpaceBaseQuantities.FinishCeilingHeight', elements: 2 }],
  }),
  rule({
    ruleId: 'oib6-u-wert-aussenwand',
    richtlinie: 'OIB 6',
    clause: '4.1',
    titleDe: 'Außenwände — Wärmedurchgangskoeffizient',
    thresholdDe: 'U ≤ 0,35 W/m²K',
    applicable: false,
    notApplicableReason:
      'Gebäudeklasse in den Projektangaben nicht gesetzt — die Anforderung hängt daran',
  }),
  rule({
    ruleId: 'oib5-schalldaemmung-deklariert',
    richtlinie: 'OIB 5',
    titleDe: 'Trennbauteile — Schalldämmung deklariert',
    thresholdDe: 'bewertetes Schalldämm-Maß am Bauteil hinterlegt',
  }),
]

export default function BimCompliancePreviewPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <div data-testid="bim-compliance-preview" className="bg-background text-foreground min-h-dvh p-6">
      <div className="mx-auto max-w-[820px]">
        <IfcCompliancePanel
          rules={RULES}
          summary={{
            rulesApplicable: 5,
            rulesNotApplicable: 1,
            rulesFailing: 1,
            rulesUndecidable: 1,
            rulesPassing: 2,
            rulesEmpty: 1,
            elementsFailed: 2,
            elementsUndecidable: 36,
          }}
          shoppingList={[
            {
              path: 'Pset_WallCommon.FireRating',
              elements: 34,
              rules: ['oib2-feuerwiderstand-tragend'],
            },
            {
              path: 'Qto_SpaceBaseQuantities.FinishCeilingHeight',
              elements: 2,
              rules: ['oib3-raumhoehe'],
            },
          ]}
          isLoading={false}
          error={null}
          projectId="p1"
          modelFilename="wohnhaus-beispielgasse_V3.ifc"
          missingFacts={['Gebäudeklasse']}
          askHref="/app/projects/p1/chat?ask=x"
        />
      </div>
    </div>
  )
}
