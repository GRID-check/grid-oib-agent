'use client'

/**
 * Dev preview for Platform → cards. Renders the REAL gallery with a fixture
 * catalog so the states that matter can be reviewed and screenshotted without
 * a backend:
 *
 *  - a schematic card previewed as it appears in an answer (`stair_diagram`),
 *  - a structured card with its values expanded is one click away,
 *  - an INTERACTIVE, system-emitted card (`memory_proposal`) carrying both
 *    badges — and inert, because a gallery must not be able to fire a write,
 *  - a card that needs real data (`ifc_viewer`), described rather than faked.
 *
 * The card bodies are the shared preview fixtures, not copies: what the
 * platform page renders is what this screenshot shows.
 *
 * A module-scope fetch shim (browser + dev only) serves the catalog payload —
 * see `/dev/platform-models` for why it is installed at module scope and never
 * torn down. Not linked from anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import { PlatformCards } from '@/app/app/(shell)/platform/cards/platform-cards'
import { PageHeader } from '@/components/ui/page-header'
import { useTranslations } from '@/i18n'

const FIELDS = {
  stair_diagram: [
    {
      name: 'riser_height',
      type: 'DimensionCheck',
      required: true,
      description: 'Steigung (cm) vs the limit for this stair',
      constraints: [],
    },
    {
      name: 'tread_depth',
      type: 'DimensionCheck',
      required: true,
      description: 'Auftritt (cm) vs the limit for this stair',
      constraints: [],
    },
    {
      name: 'reference',
      type: 'NormReference',
      required: true,
      description: 'Source of the stair limits (OIB 4)',
      constraints: [],
    },
  ],
  calculation: [
    {
      name: 'title',
      type: 'string',
      required: true,
      description: 'What is being computed',
      constraints: ['non-empty'],
    },
    {
      name: 'steps',
      type: '[CalculationStep]',
      required: true,
      description: 'The derivation in order; the renderer computes every result',
      constraints: ['1–4 items'],
    },
  ],
  memory_proposal: [
    {
      name: 'content',
      type: 'string',
      required: true,
      description: 'The finding to remember (shown to the user verbatim)',
      constraints: ['non-empty'],
    },
    {
      name: 'confidence',
      type: '"low" | "medium" | "high"',
      required: false,
      description: '',
      constraints: ['default "medium"'],
    },
  ],
  ifc_viewer: [
    {
      name: 'model_file',
      type: 'string',
      required: true,
      description: 'File name of the IFC model, exactly as ifc_query reported it',
      constraints: ['non-empty'],
    },
    {
      name: 'highlights',
      type: '[IfcHighlightGroup]',
      required: true,
      description: 'Element groups to highlight, by GlobalId',
      constraints: ['non-empty'],
    },
  ],
}

const CATALOG = {
  cardCount: 22,
  buildingBlocks: {},
  featureRequest: {
    repository: 'https://github.com/GRID-check/grid-oib-agent',
    url: 'https://github.com/GRID-check/grid-oib-agent/issues/new?template=02-enhancement.yml',
    label: 'Missing a card, or a value on one? Open a feature request.',
  },
  cards: [
    {
      type: 'stair_diagram',
      model: 'StairDiagramCard',
      summary: 'A stair drawn to scale with its riser, tread and width checked against the limits.',
      emittedBy: 'agent',
      interaction: 'presentational',
      fields: FIELDS.stair_diagram,
    },
    {
      type: 'calculation',
      model: 'CalculationCard',
      summary:
        'The arithmetic behind a number, computed by the renderer and checked against a limit.',
      emittedBy: 'agent',
      interaction: 'presentational',
      fields: FIELDS.calculation,
    },
    {
      type: 'memory_proposal',
      model: 'MemoryProposalCard',
      summary: 'A proposal to save a finding to long-term memory, confirmed by the user.',
      emittedBy: 'system',
      interaction: 'interactive',
      fields: FIELDS.memory_proposal,
    },
    {
      type: 'ifc_viewer',
      model: 'IfcViewerCard',
      summary: "The project's IFC model in 3D with findings highlighted on the real geometry.",
      emittedBy: 'agent',
      interaction: 'presentational',
      fields: FIELDS.ifc_viewer,
    },
  ],
}

const PREVIEW_PATH = '/dev/platform-cards'

function installShim(): void {
  if (typeof window === 'undefined' || process.env.NODE_ENV !== 'development') return
  const w = window as unknown as { __platformCardsShim?: boolean }
  if (w.__platformCardsShim) return
  w.__platformCardsShim = true
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (window.location.pathname.startsWith(PREVIEW_PATH) && url.includes('/api/platform/cards')) {
      return Response.json(CATALOG)
    }
    return real(input, init)
  }
}

installShim()

export default function PlatformCardsDevPage(): JSX.Element {
  const t = useTranslations('platform')
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main
      className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8 md:px-8"
      data-testid="platform-cards-preview"
    >
      <PageHeader title={t('sections.cards.title')} subtitle={t('sections.cards.subtitle')} />
      <PlatformCards />
    </main>
  )
}
