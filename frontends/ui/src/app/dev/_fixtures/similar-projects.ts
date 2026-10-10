/**
 * Similar-projects fixtures, shared by the `/dev/similar-projects` and
 * `/dev/settings` previews: a Holzbau project in Niederösterreich whose OIB
 * edition was only suggested from its documents, with decisions of all three
 * origins and a permit with its Auflagen; and a project with nothing recorded.
 */

import type { SimilarProject } from '@/lib/references/types'

export const SIMILAR_PROJECTS: SimilarProject[] = [
  {
    id: '11111111-0000-4000-8000-000000000001',
    name: 'Wohnhaus Mödling',
    period: { start: '2019-03-01', end: '2021-11-30' },
    bundesland: { value: 'Niederösterreich', confirmed: true },
    oibEdition: { value: '2019', confirmed: false },
    sharedTraits: ['Niederösterreich', 'GK 4', 'Holzbau'],
    decisions: [
      {
        id: 'd1',
        kind: 'constraint',
        content:
          'Brandsperre je Geschoß aus 1 mm Stahlblech, weil die Holzwand nach OIB-RL 2 die Brandabschnitte nicht selbst trennt.',
        origin: 'person',
        sources: [],
      },
      {
        id: 'd2',
        kind: 'decision',
        content:
          'Fluchttreppe außen in Stahl statt eines zweiten Stiegenhauses, weil das Grundstück die Breite nicht hergibt.',
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
          {
            kind: 'nachforderung',
            content: 'Nachweis der Stellplätze nach NÖ Bauordnung ergänzen.',
          },
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
    sharedTraits: ['Niederösterreich'],
    decisions: [],
    permits: [],
  },
]
