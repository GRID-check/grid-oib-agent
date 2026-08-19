/**
 * The guard that every card type in the union actually DRAWS something.
 *
 * A chain of tests already keeps a new card type honest on the way in — the
 * schema is synced with `models.py`, `CARD_INTERACTIVITY` is exhaustive over
 * the union so `tsc` rejects an unclassified type, and `preview-fixtures.spec`
 * demands a fixture or a stated exclusion. Not one of them asks the only
 * question the reader cares about: does anything appear on screen?
 *
 * `GridCardItem` is a flat chain of `if (card.type === '…')` tests ending in
 * `return null`, so a type that clears every guard above and has no branch
 * renders NOTHING — no warning, no dropped card, no red test. The agent says it
 * made a finding, the answer shows an empty gap, and the only place that is
 * visible is production. This file closes that hole: it mounts one card of
 * every type through the real dispatcher and fails when the container comes
 * back empty.
 *
 * Two instances of each type are mounted:
 *
 *   1. the gallery fixture, which carries the card's rich state;
 *   2. the MINIMAL card — the fixture stripped to the fields the canonical
 *      schema actually requires — because a renderer that only paints when an
 *      optional field happens to be present is a card that renders nothing on
 *      the day the model omits it, and that failure belongs here rather than in
 *      a thread.
 *
 * The seven `PREVIEW_EXCLUDED` types are MOCKED, not skipped. The gallery
 * cannot invent a building, but "we cannot preview it" is not "it may render
 * nothing": `IfcModelPickerCard` returns `null` without a project or a ready
 * model, so the model list and the surfaced-document index are stubbed here
 * with exactly the one row each of them needs to have something to draw.
 *
 * Runs in the DOM environment (the config default) rather than `node` — the
 * assertion IS the mount.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { render } from '@/test-utils'
import { gridCardSchema, type GridCard } from '@/shared/cards/schemas'
import { PREVIEW_EXCLUDED, previewFixtureFor } from '../preview-fixtures'
import { GridCardItem } from './GridCards'
// The canonical card JSON Schema, generated from `models.py` and the input the
// Zod mirror is generated FROM. Reached by path because it lives above the app
// root; `scripts/generate-card-schemas.mjs` reads the same file the same way.
import cardJsonSchema from '../../../../../../shared/cards/schemas.json'

/**
 * One ready model, for every card that resolves a file name against the
 * project's models. `status: 'ready'` is the load-bearing part — a `pending`
 * model is exactly the state in which the picker draws nothing.
 */
const READY_MODEL = {
  id: 'model-1',
  documentId: 'doc-1',
  projectId: 'p1',
  filename: 'haus-a.ifc',
  displayName: null,
  status: 'ready',
  schemaVersion: 'IFC4',
  elementCount: 120,
  errorMessage: null,
  summary: null,
  updatedAt: '2026-02-11T09:00:00.000Z',
}

vi.mock('@/features/bim/hooks/use-bim-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/bim/hooks/use-bim-model')>()
  return {
    ...actual,
    useProjectBimModels: () => ({
      data: [READY_MODEL],
      isLoading: false,
      error: null,
      reload: () => {},
    }),
  }
})

/** The live document row a surfaced file name resolves to. */
const RESOLVED_FILE = {
  id: 'file-1',
  filename: 'einreichplan.pdf',
  displayName: null,
  fileSize: 1024,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-01-01T00:00:00Z',
  errorMessage: null,
  summary: 'Einreichplan mit Fluchtwegen.',
  pageCount: 3,
  chunkCount: 7,
  contentTypes: null,
  tags: null,
}

vi.mock('@/features/documents/hooks/use-surfaced-documents', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/features/documents/hooks/use-surfaced-documents')
  >()
  return {
    ...actual,
    useSurfacedDocuments: (documents: { file_name: string }[]) => ({
      resolved: documents.map((surfaced, position) => ({
        key: `${surfaced.file_name}-${position}`,
        surfaced,
        file: { ...RESOLVED_FILE, filename: surfaced.file_name },
        docSource: 'projekt' as const,
      })),
      isLoading: false,
      error: false,
      retry: () => {},
    }),
  }
})

type CardInput = z.input<typeof gridCardSchema>

/** Only the corner of the JSON Schema this file reads. */
interface JsonSchemaDocument {
  $defs: Record<
    string,
    {
      required?: string[]
      properties?: { type?: { const?: string; default?: string } }
    }
  >
}

/**
 * Sample cards for the types the gallery refuses to preview.
 *
 * They live here rather than in `preview-fixtures.ts` on purpose: the gallery's
 * exclusions are about not showing a platform owner a building that does not
 * exist, and this file shows nobody anything — it only asks whether the
 * component paints. Each carries the minimum the schema demands plus nothing
 * invented, since the numbers come from the mocked model, not from the card.
 */
const EXCLUDED_FIXTURES: Record<string, CardInput> = {
  ifc_viewer: { type: 'ifc_viewer', title: 'Modell ansehen' },
  ifc_compliance: { type: 'ifc_compliance', title: 'Prüfbuch' },
  ifc_schedule: { type: 'ifc_schedule', title: 'Raumbuch' },
  ifc_element: { type: 'ifc_element', title: 'Wand W-01', global_id: '2O2Fr$t4X7Zf8NOew3FLKU' },
  ifc_diff: { type: 'ifc_diff', title: 'Änderungen gegenüber Vorabzug', base_model_file: 'haus-a.ifc' },
  ifc_model_picker: { type: 'ifc_model_picker', title: 'Welches Modell?' },
  document_grid: {
    type: 'document_grid',
    title: 'Passende Dokumente',
    query: 'Fluchtwege',
    documents: [{ file_name: 'einreichplan.pdf', summary: 'Einreichplan' }],
  },
}

/**
 * Every card type, read off the union itself — never a list.
 *
 * `optionsMap` is keyed by the discriminator value zod resolved, so it is
 * right even for `project_profile_patch`, whose `type` literal is wrapped in a
 * `.default()`.
 */
const ALL_TYPES = [...gridCardSchema.optionsMap.keys()].filter(
  (type): type is string => typeof type === 'string'
)

/** The card of `type` to mount: the gallery's fixture, or the stand-in above. */
function fixtureFor(type: string): GridCard | undefined {
  const preview = previewFixtureFor(type)
  if (preview) return preview
  const excluded = EXCLUDED_FIXTURES[type]
  return excluded ? gridCardSchema.parse(excluded) : undefined
}

/**
 * `required` per card type, read off the canonical JSON Schema.
 *
 * NOT read off the Zod mirror, though that is the schema everything else here
 * uses. The generator flattens every nested `$ref` to `z.any()`, and `z.any()`
 * accepts a missing key — so Zod believes `energy_performance.hwb` and every
 * other object-valued field is optional, when `models.py` requires them. A
 * minimal instance built from Zod's answer is a card the backend could never
 * emit, and the eight schematic cards it produced crashed on a field that is
 * required in the only place that decides: the Pydantic models. `schemas.json`
 * is generated from those models and pinned to them by `test_schema_sync.py`,
 * so it is the honest source for this question. Zod still does the PARSING, so
 * the stripped card comes back with its defaults filled.
 */
const REQUIRED_FIELDS: Record<string, string[]> = Object.fromEntries(
  Object.values((cardJsonSchema as JsonSchemaDocument).$defs)
    .map((definition) => {
      // The discriminator is a `const` on most cards and a `default` on the two
      // that let the backend fill it in.
      const literal = definition.properties?.type?.const ?? definition.properties?.type?.default
      if (typeof literal !== 'string') return null
      // `type` is added back because a card that defaults its discriminator
      // does not list it, and a minimal instance without one is not a card.
      return [literal, [...new Set(['type', ...(definition.required ?? [])])]] as const
    })
    .filter((entry): entry is readonly [string, string[]] => entry !== null)
)

/**
 * The fixture reduced to its required fields and re-parsed, so the schema's
 * defaults fill the rest — the leanest card the agent is allowed to emit.
 */
function minimalFrom(card: GridCard): GridCard {
  const keep = new Set(REQUIRED_FIELDS[card.type] ?? ['type'])
  const stripped = Object.fromEntries(
    Object.entries(card).filter(([name]) => keep.has(name))
  )
  return gridCardSchema.parse(stripped)
}

/** Mount one card through the real dispatcher and report what it painted. */
function drawn(card: GridCard): { text: string; elements: number } {
  const { container } = render(
    <GridCardItem card={card} index={0} projectId="p1" messageId="message-1" />
  )
  return {
    text: (container.textContent ?? '').trim(),
    elements: container.querySelectorAll('*').length,
  }
}

/** The assertion itself, so both cases fail with the same diagnosis. */
function expectDrawsSomething(card: GridCard, shape: 'fixture' | 'minimal'): void {
  const { text, elements } = drawn(card)
  const blame =
    `card type "${card.type}" (${shape}) rendered nothing — ` +
    'GridCardItem has no branch for it, or its renderer bailed out on a field ' +
    'the schema does not require'
  expect(elements, blame).toBeGreaterThan(0)
  expect(text, blame).not.toBe('')
}

/**
 * Answer every request with an empty payload.
 *
 * The mocked hooks cover the data a card needs to have something to draw; what
 * is left is incidental (thumbnails, rule facts, a model query) and would
 * otherwise leave the run to reach a dev server that is not there, printing a
 * wall of ECONNREFUSED for cards that render their empty state perfectly well.
 * The question here is whether the component paints, not what the network says.
 */
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('every card type renders', () => {
  it('has a card to mount for every member of the union', () => {
    const missing = ALL_TYPES.filter((type) => !fixtureFor(type))
    expect(
      missing,
      'add a fixture to preview-fixtures.ts (or, if the gallery cannot preview the type, ' +
        'name it in PREVIEW_EXCLUDED and add a stand-in to EXCLUDED_FIXTURES here)'
    ).toEqual([])
  })

  it('knows what every type requires, so a minimal card is really minimal', () => {
    // Without an entry the stripped card would keep only `type` — which parses
    // for nothing and would turn this file into noise rather than a guard.
    const unknown = ALL_TYPES.filter((type) => !REQUIRED_FIELDS[type])
    expect(
      unknown,
      'card type is in the Zod union but not in shared/cards/schemas.json — regenerate the schema'
    ).toEqual([])
  })

  it('mounts every excluded type rather than skipping it', () => {
    // The exclusions are a gallery decision; renderability is not negotiable,
    // so each one must have a stand-in here.
    const unmocked = Object.keys(PREVIEW_EXCLUDED).filter((type) => !(type in EXCLUDED_FIXTURES))
    expect(unmocked, 'a type excluded from the gallery still has to render').toEqual([])
  })

  it.each(ALL_TYPES)('%s draws its fixture', (type) => {
    const card = fixtureFor(type)
    expect(card, `no fixture for card type "${type}"`).toBeDefined()
    expectDrawsSomething(card as GridCard, 'fixture')
  })

  it.each(ALL_TYPES)('%s draws with only its required fields', (type) => {
    const card = fixtureFor(type)
    expect(card, `no fixture for card type "${type}"`).toBeDefined()
    expectDrawsSomething(minimalFrom(card as GridCard), 'minimal')
  })
})
