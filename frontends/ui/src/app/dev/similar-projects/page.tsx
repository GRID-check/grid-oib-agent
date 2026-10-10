/**
 * Dev preview: the „Ähnliche Projekte" page (`/app/projects/{id}/referenzen`)
 * rendered through the real organism with fixture data, no backend:
 *
 *   1. THREE REFERENCES under „Verglichen nach" (this project's fingerprint, a
 *      suggested Gebäudeklasse marked, two facts open with the link to the
 *      briefing) — a Holzbau project in Niederösterreich whose OIB edition and
 *      shared GK were only suggested from its documents (unconfirmed), with
 *      decisions of all three origins and a permit with its Auflagen; a running
 *      period with a confirmed edition and nothing recorded; and, apart from
 *      them, a closed project that shares nothing, then „… und 3 weitere".
 *   2. THE EMPTY STATE — what a person sees when the office has no closed project.
 *
 * Not linked anywhere; the `/dev` server layout 404s it outside development.
 */

import type { JSX } from 'react'
import { SimilarProjects } from '@/features/references/components/similar-projects'
import { fingerprintOf } from '@/lib/cross-project/fingerprint'
import type { SimilarProject, SimilarProjectsPage } from '@/lib/references/types'

const FIXTURES: SimilarProject[] = [
  {
    id: '11111111-0000-4000-8000-000000000001',
    name: 'Wohnhaus Mödling',
    period: { start: '2019-03-01', end: '2021-11-30' },
    bundesland: { value: 'Niederösterreich', confirmed: true },
    oibEdition: { value: '2019', confirmed: false },
    alike: true,
    sharedTraits: [
      { value: 'Niederösterreich', confirmed: true },
      { value: 'GK 4', confirmed: false },
      { value: 'Holzbau', confirmed: true },
    ],
    counts: { decisions: 3, permits: 1 },
    decisions: [
      {
        id: 'd1',
        kind: 'constraint',
        content: 'Brandsperre je Geschoß aus 1 mm Stahlblech, weil die Holzwand nach OIB-RL 2 die Brandabschnitte nicht selbst trennt.',
        origin: 'person',
        sources: [],
      },
      {
        id: 'd2',
        kind: 'decision',
        content: 'Fluchttreppe außen in Stahl statt eines zweiten Stiegenhauses, weil das Grundstück die Breite nicht hergibt.',
        origin: 'documents',
        sources: [{ fileName: 'Bescheid.pdf', page: '3' }],
      },
      {
        id: 'd3',
        kind: 'decision',
        content: 'Dachstuhl als Brettschichtholz statt Vollholz, auf Wunsch der Bauherrschaft.',
        origin: 'agent',
        sources: [],
      },
    ],
    permits: [
      {
        id: 'p1',
        fileName: 'Baubewilligung.pdf',
        kind: 'bewilligung',
        authority: 'Stadtgemeinde Mödling',
        issuedOn: '2020-06-18',
        requirements: [
          { kind: 'auflage', content: 'Brandschutzkonzept vor Baubeginn der Baubehörde vorlegen.' },
          { kind: 'nachforderung', content: 'Nachweis der Stellplätze nach NÖ Bauordnung ergänzen.' },
        ],
      },
    ],
  },
  {
    id: '22222222-0000-4000-8000-000000000002',
    name: 'Bürogebäude Tulln',
    period: { start: '2016-09-01', end: null },
    bundesland: { value: 'Niederösterreich', confirmed: true },
    oibEdition: { value: '2015', confirmed: true },
    alike: true,
    sharedTraits: [{ value: 'Niederösterreich', confirmed: true }],
    decisions: [],
    permits: [],
    counts: { decisions: 0, permits: 0 },
  },
  {
    id: '33333333-0000-4000-8000-000000000003',
    name: 'Produktionshalle Wels',
    period: { start: '2016-02-01', end: '2017-08-31' },
    bundesland: { value: 'Oberösterreich', confirmed: true },
    oibEdition: null,
    alike: false,
    sharedTraits: [],
    decisions: [],
    permits: [],
    counts: { decisions: 0, permits: 0 },
  },
]

const confirmed = (value: string | string[]) => ({ value, confidence: 'confirmed' as const, source: 'onboarding' as const, updatedAt: '' })

/** This project: Land and Bauweise confirmed, the class only read from its documents, uses and kind of work open. */
const BASIS = fingerprintOf({
  facts: { bundesland: confirmed('niederoesterreich'), bauweise: confirmed(['holzbau']) },
  goals: {},
  unknowns: [],
  assumptions: {
    gebaeudeklasse: { value: 4, status: 'unconfirmed', reason: 'Einreichplan, S. 1', source: 'agent_suggested', updatedAt: '' },
  },
})

const page = (projects: SimilarProject[], more: number): SimilarProjectsPage => ({
  basis: { facts: BASIS, missing: 2 },
  projects,
  more,
})

export default function SimilarProjectsPreview(): JSX.Element {
  return (
    <div className="flex flex-col gap-10">
      <SimilarProjects projectId="preview" page={page(FIXTURES, 3)} />
      <SimilarProjects projectId="preview" page={page([], 0)} />
    </div>
  )
}
