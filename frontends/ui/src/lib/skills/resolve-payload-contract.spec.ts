/**
 * @vitest-environment node
 */
/**
 * Cross-language contract: the payload that says what an agent may load.
 *
 * `GET /api/internal/skills/resolve` is the seam where a row in `skills` or
 * `platform_skills` becomes something the model can reach for. The payload
 * carries each row's `metadata` VERBATIM, and three reserved keys ride it:
 * `grid-hidden` routes the activation off the live line, `grid-cards` inlines
 * the card shapes with the body, and `grid-agents` decides which agent may run
 * the skill at all.
 *
 * `ce47667b` pinned the Python half — the real resolver over a faked BFF
 * payload. This is the other half, and until it existed replacing
 * `metadata: { ...skill.metadata }` with `metadata: {}` in `resolveAll` — the
 * exact regression the comment there records — was caught by nothing, and it
 * takes `grid-hidden` and `grid-cards` down with it.
 *
 * A process boundary cannot be crossed inside one test, so both sides assert
 * against the SAME checked-in fixture, `tests/fixtures/skills_resolve/
 * resolve_payload.json` — the device `citation-wire-contract.spec.ts` uses for
 * the citation formats. This file proves the fixture is still a faithful sample
 * of what the real `resolveSkillsForAgent` emits; the Python counterpart,
 * `tests/aiq_agent/skills/test_resolve_payload_contract.py`, proves the real
 * `SkillResolver` still reads it. Rename or drop a field and exactly one of the
 * two fails.
 *
 * "Faithful sample", not "identical bytes": ADDING a field to the payload is
 * invisible to the consumer and must not break the build, while renaming,
 * removing or re-valuing one of the fields the backend reads must.
 *
 * ## The one field this file now asserts is GONE
 *
 * `standard`. It marked a published `delivery: 'standard'` row so
 * `SkillRuntime` would FORCE the skill rather than offer its description, and
 * migration 0088 retired the tier together with the composer's `skills` array:
 * an instruction that always applies is not a capability. The key is therefore
 * pinned by its ABSENCE below — a payload that grew it back would mean the tier
 * came back with it.
 *
 * The shared fixture still carries `standard: true` on `piloti-voice` until the
 * backend half of this change lands (it owns the Python side of the same
 * fixture), so the row-for-row comparison drops the retired key rather than
 * asserting against a value neither side produces any more. When the fixture
 * loses the key, {@link RETIRED_KEYS} stops matching anything and can go.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./repository', () => ({
  insertSkill: vi.fn(),
  listSkillsInOrg: vi.fn(),
  findSkill: vi.fn(),
  findSkillByName: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  listCuratedSkillActivations: vi.fn(),
  upsertCuratedSkillActivation: vi.fn(),
}))

vi.mock('./platform-skills', () => ({
  listPlatformSkills: vi.fn(),
  findPlatformSkill: vi.fn(),
}))

vi.mock('./platform-repository', () => ({
  listPublishedOfferRows: vi.fn(),
}))

import * as repository from './repository'
import * as platformRepository from './platform-repository'
import { findPlatformSkill, listPlatformSkills } from './platform-skills'
import { resolveSkillsForAgent } from './service'
import type { PlatformSkillRow, Skill } from '@/lib/db/schema'

// frontends/ui/src/lib/skills → repo root is five levels up.
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolvePath(HERE, '../../../../../tests/fixtures/skills_resolve/resolve_payload.json')
const SAMPLE = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as Array<Record<string, unknown>>

const AGENT = 'researcher'
const ORG = 'org_1'

/**
 * The house voice — the row the retired `standard` tier existed for, and now an
 * ordinary offer. Hidden from the live line, and declaring the cards its
 * answers prefer: the two reserved keys the payload must carry verbatim.
 */
const VOICE_ROW: PlatformSkillRow = {
  id: 'ps-voice',
  name: 'piloti-voice',
  description: 'Schreibt jede Antwort in der Hausstimme.',
  body: 'Kein Vorbehalt vor der Aussage.',
  metadata: {
    'grid-title': 'Piloti-Stimme',
    'grid-hidden': 'true',
    'grid-cards': 'legal_basis,calculation',
  },
  published: true,
  delivery: 'offer',
  createdBy: 'owner',
  createdByEmail: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

/** A second offer the org took up. */
const OFFER_ROW: PlatformSkillRow = {
  ...VOICE_ROW,
  id: 'ps-offer',
  name: 'oib-fire-check',
  description: 'Prüft das Projekt gegen den OIB-Brandschutz.',
  body: 'Handle als Brandschutzprüfer.',
  metadata: { 'grid-catalog': 'curated' },
}

/** Keys the fixture still carries that this payload no longer emits. */
const RETIRED_KEYS = ['standard'] as const

/** The pipeline's own machinery: a builtin file, no `grid-catalog`. */
const MACHINERY = {
  name: 'data-table-analysis',
  description: 'Analysiert Tabellen deterministisch.',
  body: '# Data Table Analysis\n\nRechne deterministisch.',
  metadata: {},
  origin: 'platform' as const,
  collection: 'research' as const,
}

/** The tenant's own skill, scoped to the chat agent. */
const ORG_ROW: Skill = {
  id: 'skill-1',
  organizationId: ORG,
  name: 'buero-detailpruefung',
  description: 'Prüft ein Detail gegen die Büroregeln.',
  body: 'Vergleiche das Detail mit dem Regeldetail.',
  metadata: { 'grid-agents': AGENT },
  origin: 'org',
  clonedFrom: null,
  enabled: true,
  createdBy: 'user_1',
  createdByEmail: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

beforeEach(() => {
  vi.mocked(listPlatformSkills).mockReturnValue([MACHINERY])
  vi.mocked(findPlatformSkill).mockImplementation(
    (name) => [MACHINERY].find((skill) => skill.name === name) ?? null
  )
  vi.mocked(platformRepository.listPublishedOfferRows).mockResolvedValue([OFFER_ROW, VOICE_ROW])
  vi.mocked(repository.listSkillsInOrg).mockResolvedValue([ORG_ROW])
  vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue(
    [OFFER_ROW.name, VOICE_ROW.name].map((skillName) => ({
      organizationId: ORG,
      skillName,
      enabled: true,
      updatedBy: 'user_1',
      updatedByEmail: null,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    }))
  )
})

const served = async (): Promise<Map<string, Record<string, unknown>>> => {
  const { skills } = await resolveSkillsForAgent(ORG, AGENT)
  return new Map(skills.map((skill) => [skill.name, skill as unknown as Record<string, unknown>]))
}

describe('the resolve payload the backend reads', () => {
  it('is still what this service emits, row for row', async () => {
    const live = await served()
    expect([...live.keys()].sort()).toEqual(SAMPLE.map((row) => row.name as string).sort())
    for (const sampled of SAMPLE) {
      const row = live.get(sampled.name as string)
      expect(row, sampled.name as string).toBeDefined()
      const expected = { ...sampled }
      for (const key of RETIRED_KEYS) delete expected[key]
      expect(row, sampled.name as string).toMatchObject(expected)
    }
  })

  it('marks no row as fleet policy, because there is no such tier', async () => {
    // `standard` was the key `_build_org_skills` read to set `Skill.standard`,
    // and it was the whole difference between a skill that is FORCED and one
    // the model may choose. Migration 0088 retired the tier; a row that grew
    // the key back would mean the tier came back with it.
    const live = await served()
    for (const row of live.values()) {
      expect(Object.keys(row)).not.toContain('standard')
    }
  })

  it('carries the reserved metadata verbatim rather than an empty object', async () => {
    // The regression `resolveAll` documents: sending `{}` here dropped the
    // reserved `grid-*` keys, and the backend merges this payload OVER its own
    // filesystem copy — so the house voice loses `grid-hidden` (a live line on
    // every answer) and `grid-cards` (no card shapes in front of the model).
    const live = await served()
    expect(live.get('piloti-voice')?.metadata).toEqual({
      'grid-title': 'Piloti-Stimme',
      'grid-hidden': 'true',
      'grid-cards': 'legal_basis,calculation',
    })
  })

  it('carries a body, because a description alone cannot shape an answer', async () => {
    const live = await served()
    expect(live.get('piloti-voice')?.body).toBe(VOICE_ROW.body)
  })
})
