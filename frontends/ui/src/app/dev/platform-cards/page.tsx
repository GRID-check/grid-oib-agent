'use client'

/**
 * Dev preview for Platform → cards. Renders the REAL gallery with a fixture
 * catalog so the states that matter can be reviewed and screenshotted without
 * a backend:
 *
 *  - a schematic card previewed as it appears in an answer (`parking_requirement`),
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

import { notFound } from 'next/navigation'
import { PlatformCards } from '@/app/app/(shell)/platform/cards/platform-cards'

const FIELDS = {
  parking_requirement: [
    {
      name: 'car_spaces',
      type: 'DimensionCheck',
      required: true,
      description: "Provided vs required Kfz-Stellplätze (comparator '>=')",
      constraints: [],
    },
    {
      name: 'basis',
      type: 'string',
      required: false,
      description: "How the requirement is derived, e.g. '1 Stpl. je 100 m² BGF'",
      constraints: [],
    },
    {
      name: 'reference',
      type: 'NormReference',
      required: true,
      description: 'Source of the parking requirement (Bauordnung / StPl-VO)',
      constraints: [],
    },
  ],
  legal_basis: [
    {
      name: 'law',
      type: 'string',
      required: true,
      description: 'Name of the law, regulation, or OIB Richtlinie',
      constraints: ['non-empty'],
    },
    { name: 'article', type: 'string', required: false, description: 'Relevant article or paragraph number', constraints: [] },
    {
      name: 'original_text',
      type: 'string',
      required: false,
      description: 'Literal excerpt from the source, if available',
      constraints: [],
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
  cardCount: 27,
  buildingBlocks: {},
  featureRequest: {
    repository: 'https://github.com/GRID-check/grid-oib-agent',
    url: 'https://github.com/GRID-check/grid-oib-agent/issues/new?template=02-enhancement.yml',
    label: 'Missing a card, or a value on one? Open a feature request.',
  },
  cards: [
    {
      type: 'parking_requirement',
      model: 'ParkingRequirementCard',
      summary: 'A parking-provision (Stellplatznachweis) card: required vs provided count.',
      emittedBy: 'agent',
      interaction: 'presentational',
      fields: FIELDS.parking_requirement,
    },
    {
      type: 'legal_basis',
      model: 'LegalBasisCard',
      summary: 'A legal norm, regulation, or OIB Richtlinie that grounds the answer.',
      emittedBy: 'agent',
      interaction: 'presentational',
      fields: FIELDS.legal_basis,
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
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (window.location.pathname.startsWith(PREVIEW_PATH) && url.includes('/api/platform/cards')) {
      return Response.json(CATALOG)
    }
    return real(input, init)
  }
}

installShim()

export default function PlatformCardsDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8" data-testid="platform-cards-preview">
      <div>
        <h1 className="text-lg font-semibold">Platform — Card catalog</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Platform-owner surface: every card the agent can render, shown rendered, with the values it carries
          and a way to ask for one that is missing.
        </p>
      </div>
      <PlatformCards />
    </main>
  )
}
