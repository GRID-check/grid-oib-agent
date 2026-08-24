/**
 * @vitest-environment node
 */
/**
 * Cross-language contract: the payload that decides what the fleet runs.
 *
 * `GET /api/internal/skills/resolve` is the seam where a word in a migration
 * becomes fleet policy. `delivery: 'standard'` on a `platform_skills` row makes
 * `resolveSkillsForAgent` mark the served row `standard: true`; the backend's
 * `SkillResolver._build_org_skills` reads that key to set `Skill.standard`,
 * which is what makes `SkillRuntime` FORCE the skill instead of merely offering
 * its one-line description. The same payload carries the row's `metadata`
 * verbatim, and three reserved keys ride it: `grid-hidden` routes the
 * activation off the live line, `grid-cards` inlines the card shapes with the
 * body, and `grid-agents` decides which agent may run it at all.
 *
 * `ce47667b` pinned the Python half of that — the real resolver over a faked
 * BFF payload. This is the other half, and until it existed the crossing was
 * open in both directions:
 *
 *   - renaming `standard` here (with `service.spec.ts` renamed along with it,
 *     as a refactor would) left this suite and all 3,909 backend tests green
 *     while `piloti-voice` and `piloti-cards` silently stopped being forced;
 *   - replacing `metadata: { ...skill.metadata }` with `metadata: {}` in
 *     `resolveAll` — the exact regression the comment there records — was
 *     caught by nothing at all, and it takes `grid-hidden` and `grid-cards`
 *     down with it.
 *
 * A process boundary cannot be crossed inside one test, so both sides assert
 * against the SAME checked-in fixture, `tests/fixtures/skills_resolve/
 * resolve_payload.json` — the device `citation-wire-contract.spec.ts` uses for
 * the citation formats. This file proves the fixture is still a faithful sample
 * of what the real `resolveSkillsForAgent` emits; the Python counterpart,
 * `tests/aiq_agent/skills/test_resolve_payload_contract.py`, proves the real
 * `SkillResolver` still reads it as fleet policy. Rename or drop a field and
 * exactly one of the two fails.
 *
 * "Faithful sample", not "identical bytes": ADDING a field to the payload is
 * invisible to the consumer and must not break the build, while renaming,
 * removing or re-valuing one of the fields the backend reads must.
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
  listPublishedStandardRows: vi.fn(),
  findStandardPlatformSkillRowByName: vi.fn(),
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

const AGENT = 'shallow_researcher'
const ORG = 'org_1'

/**
 * The house voice: the shape the crossing exists for. Published, `standard`,
 * hidden from the live line, and declaring the cards its answers prefer.
 */
const STANDARD_ROW: PlatformSkillRow = {
  id: 'ps-std',
  name: 'piloti-voice',
  description: 'Schreibt jede Antwort in der Hausstimme.',
  body: 'Kein Vorbehalt vor der Aussage.',
  metadata: {
    'grid-title': 'Piloti-Stimme',
    'grid-hidden': 'true',
    'grid-cards': 'summary,calculation',
  },
  published: true,
  delivery: 'standard',
  createdBy: 'owner',
  createdByEmail: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

/** An offer the org took up — platform origin, but nobody's policy. */
const OFFER_ROW: PlatformSkillRow = {
  ...STANDARD_ROW,
  id: 'ps-offer',
  name: 'oib-fire-check',
  description: 'Prüft das Projekt gegen den OIB-Brandschutz.',
  body: 'Handle als Brandschutzprüfer.',
  metadata: { 'grid-catalog': 'curated' },
  delivery: 'offer',
}

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
  vi.mocked(platformRepository.listPublishedOfferRows).mockResolvedValue([OFFER_ROW])
  vi.mocked(platformRepository.listPublishedStandardRows).mockResolvedValue([STANDARD_ROW])
  vi.mocked(platformRepository.findStandardPlatformSkillRowByName).mockImplementation(
    async (name) => (name === STANDARD_ROW.name ? STANDARD_ROW : null)
  )
  vi.mocked(repository.listSkillsInOrg).mockResolvedValue([ORG_ROW])
  vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
    {
      organizationId: ORG,
      skillName: OFFER_ROW.name,
      enabled: true,
      updatedBy: 'user_1',
      updatedByEmail: null,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
  ])
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
      expect(row, sampled.name as string).toMatchObject(sampled)
    }
  })

  it('marks the standard row and only the standard row', async () => {
    // `standard` is the key `_build_org_skills` reads to set `Skill.standard`,
    // which is the whole difference between a skill that is APPLIED and one
    // that is merely offered. It is not derivable from `origin`, which the
    // machinery and a taken-up offer also carry.
    const live = await served()
    expect(live.get('piloti-voice')?.standard).toBe(true)
    for (const name of ['data-table-analysis', 'oib-fire-check', 'buero-detailpruefung']) {
      expect(live.get(name)?.standard, name).toBeUndefined()
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
      'grid-cards': 'summary,calculation',
    })
  })

  it('carries a body, because a description alone cannot shape an answer', async () => {
    const live = await served()
    expect(live.get('piloti-voice')?.body).toBe(STANDARD_ROW.body)
  })
})
