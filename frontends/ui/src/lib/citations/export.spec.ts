/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./repository', () => ({
  EXPORT_ROW_CAP: 3,
  listEventsForExport: vi.fn(),
  insertCitationEvents: vi.fn(),
  countObservedTurns: vi.fn(),
  countDefectiveTurns: vi.fn(),
  aggregateByKind: vi.fn(),
  aggregateDailyByKind: vi.fn(),
  aggregateDailyTurns: vi.fn(),
  aggregateReasons: vi.fn(),
  aggregateDefectiveSourceMix: vi.fn(),
  aggregateUnavailableTools: vi.fn(),
  aggregateFailedTargets: vi.fn(),
  countTurnsForTargets: vi.fn(),
  aggregateByOrganization: vi.fn(),
  listRecentDefects: vi.fn(),
}))

vi.mock('@/lib/organizations/display-names', () => ({ getOrganizationDisplayNames: vi.fn() }))

vi.mock('@/lib/knowledge/service', () => ({
  getKnowledgeBaseStatus: vi.fn().mockResolvedValue({ files: [] }),
}))

vi.mock('@/lib/norms/service', () => ({
  getNormRegistry: vi.fn().mockResolvedValue({ registry: { entries: [] } }),
}))

import * as repository from './repository'
import { getOrganizationDisplayNames } from '@/lib/organizations/display-names'
import { getCitationExport } from './service'
import type { CitationEvent } from '@/lib/db/schema'
import type { QualityScope } from '@/lib/quality/scope'

/** The last 7 days ending on the frozen "today", every organization and project. */
const LAST_7: QualityScope = {
  from: '2026-07-22',
  to: '2026-07-28',
  organizationIds: [],
  projectIds: [],
}

const listEventsForExport = vi.mocked(repository.listEventsForExport)

function event(overrides: Partial<CitationEvent> = {}): CitationEvent {
  return {
    id: 'row',
    organizationId: 'org_1',
    conversationId: 'conv_1',
    turnId: 'turn_1',
    jobId: null,
    agent: 'shallow',
    kind: 'turn_verified',
    severity: 'ok',
    count: 1,
    reasons: null,
    detail: null,
    createdAt: new Date('2026-07-27T08:00:00.000Z'),
    ...overrides,
  } as CitationEvent
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'))

  vi.mocked(repository.countObservedTurns).mockResolvedValue(2)
  vi.mocked(repository.countDefectiveTurns).mockResolvedValue(1)
  vi.mocked(repository.aggregateByKind).mockResolvedValue([])
  vi.mocked(repository.aggregateDailyByKind).mockResolvedValue([])
  vi.mocked(repository.aggregateDailyTurns).mockResolvedValue([])
  vi.mocked(repository.aggregateReasons).mockResolvedValue([])
  vi.mocked(repository.aggregateDefectiveSourceMix).mockResolvedValue([])
  vi.mocked(repository.aggregateUnavailableTools).mockResolvedValue({ rows: [], total: 0 })
  vi.mocked(repository.aggregateFailedTargets).mockResolvedValue({ rows: [], total: 0 })
  vi.mocked(repository.countTurnsForTargets).mockResolvedValue(0)
  vi.mocked(repository.aggregateByOrganization).mockResolvedValue({
    rows: [{ organizationId: 'org_1', turns: 2, defectTurns: 1, errorTurns: 0 }],
    total: 1,
  })
  vi.mocked(repository.listRecentDefects).mockResolvedValue([])
  vi.mocked(getOrganizationDisplayNames).mockImplementation(async (ids) => {
    const known: Record<string, string> = { org_1: 'Bauwerk', org_far: 'Fernbau' }
    return new Map(
      [...ids].flatMap((id) => (id && known[id] ? [[id, known[id]] as [string, string]] : []))
    )
  })
  listEventsForExport.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getCitationExport', () => {
  it('carries a self-describing schema, scope, window and glossary', async () => {
    const bundle = await getCitationExport(LAST_7)
    expect(bundle.schema).toBe('grid.citation-health.export/v1')
    expect(bundle.scope).toEqual(LAST_7)
    expect(bundle.windowDays).toBe(7)
    expect(bundle.windowStart).toBe('2026-07-22T00:00:00.000Z')
    expect(bundle.windowEnd).toBe('2026-07-29T00:00:00.000Z')
    expect(bundle.generatedAt).toBe('2026-07-28T12:00:00.000Z')
    // An agent reading the file cold must be able to interpret every kind,
    // and what the scope it was taken in includes.
    expect(Object.keys(bundle.glossary)).toEqual(
      expect.arrayContaining(['answer_ungrounded', 'scope'])
    )
  })

  it('reads the events and the summary in the same scope, organizations and projects included', async () => {
    const scoped: QualityScope = {
      from: '2026-07-01',
      to: '2026-07-10',
      organizationIds: ['org_1'],
      projectIds: ['0f0f0f0f-0000-4000-8000-0000000000a1'],
    }
    await getCitationExport(scoped)
    const filter = {
      start: new Date('2026-07-01T00:00:00.000Z'),
      endExclusive: new Date('2026-07-11T00:00:00.000Z'),
      organizationIds: ['org_1'],
      projectIds: ['0f0f0f0f-0000-4000-8000-0000000000a1'],
    }
    expect(listEventsForExport).toHaveBeenCalledWith(filter)
    expect(repository.countObservedTurns).toHaveBeenCalledWith(filter)
  })

  it('explains every confidence reason the emitter can write', async () => {
    // The five `CappedReason` values in agents/piloti/markers.py. The glossary
    // used to say there were two, so an agent reading `measurement_only` had
    // nothing to interpret it with.
    const { glossary } = await getCitationExport(LAST_7)
    for (const reason of [
      'ungrounded',
      'quote_unverified',
      'normative_claim_uncited',
      'measurement_only',
      'citation_fallback',
    ]) {
      expect(glossary[`confidence.${reason}`]).toBeTruthy()
    }
  })

  it('carries every field its glossary describes', async () => {
    // The glossary described retrieval_precision counts and registry_empty's
    // unavailable tools, but the export carried neither.
    listEventsForExport.mockResolvedValue([
      event({
        id: 'p',
        kind: 'retrieval_precision',
        severity: 'info',
        detail: {
          retrieved_count: 5,
          cited_count: 2,
          uncited_count: 3,
          uncited_sources: ['a.pdf', 'b.pdf', 'c.pdf'],
        },
      }),
      event({
        id: 'e',
        kind: 'registry_empty',
        severity: 'error',
        detail: { unavailable_tools: ['ris_search_tool'] },
      }),
    ])

    const bundle = await getCitationExport(LAST_7)
    const turn = bundle.turns[0]
    expect(turn.precision).toEqual({
      retrievedCount: 5,
      citedCount: 2,
      uncitedCount: 3,
      uncitedSources: ['a.pdf', 'b.pdf', 'c.pdf'],
    })
    expect(turn.problems[0].unavailableTools).toEqual(['ris_search_tool'])
    expect(bundle.glossary.precision).toContain('turns[].precision')
    expect(bundle.glossary.registry_empty).toContain('problems[].unavailableTools')
  })

  it('reports no precision for a turn that recorded none', async () => {
    listEventsForExport.mockResolvedValue([event({ kind: 'citations_removed', severity: 'warn' })])
    expect((await getCitationExport(LAST_7)).turns[0].precision).toBeNull()
  })

  it('names organizations outside the dashboard top list', async () => {
    // The name used to come from the snapshot's organization list, so a turn
    // from an organization outside it exported with organization: null.
    listEventsForExport.mockResolvedValue([
      event({ organizationId: 'org_far', kind: 'citations_removed', severity: 'warn' }),
    ])
    expect((await getCitationExport(LAST_7)).turns[0].organization).toBe('Fernbau')
  })

  it('joins each flagged turn to its sources and its problems', async () => {
    listEventsForExport.mockResolvedValue([
      event({
        id: 'a',
        detail: { source_count: 4, cited_count: 1, origins: { kb: 4 } },
      }),
      event({
        id: 'b',
        kind: 'citations_removed',
        severity: 'warn',
        count: 2,
        reasons: { url_not_in_registry: 2 },
        detail: {
          targets: [
            { target: 'https://example.test/a', reason: 'url_not_in_registry' },
            { target: 'OIB-RL6.pdf, p.12', reason: 'url_not_in_registry' },
          ],
        },
      }),
    ])

    const bundle = await getCitationExport(LAST_7)
    expect(bundle.turns).toHaveLength(1)
    const turn = bundle.turns[0]
    expect(turn).toMatchObject({
      turnId: 'turn_1',
      conversationId: 'conv_1',
      organizationId: 'org_1',
      organization: 'Bauwerk',
      agent: 'shallow',
      sourceCount: 4,
      citedCount: 1,
    })
    // The whole point: WHICH source failed, and WHY.
    expect(turn.problems[0].failedSources).toEqual([
      { target: 'https://example.test/a', reason: 'url_not_in_registry' },
      { target: 'OIB-RL6.pdf, p.12', reason: 'url_not_in_registry' },
    ])
    expect(turn.problems[0].reasons).toEqual({ url_not_in_registry: 2 })
  })

  it('collects retrieved and cited source identities from any event of the turn', async () => {
    listEventsForExport.mockResolvedValue([
      event({ id: 'a', detail: { source_count: 2, cited_count: 0 } }),
      event({
        id: 'b',
        kind: 'answer_ungrounded',
        severity: 'error',
        detail: { retrieved_sources: ['OIB-RL6.pdf, p.3', 'https://ris.bka.gv.at/x'] },
      }),
      event({
        id: 'c',
        kind: 'quote_unverified',
        severity: 'warn',
        detail: { cited_sources: ['OIB-RL6.pdf, p.3'] },
      }),
    ])

    const turn = (await getCitationExport(LAST_7)).turns[0]
    expect(turn.retrievedSources).toEqual(['OIB-RL6.pdf, p.3', 'https://ris.bka.gv.at/x'])
    expect(turn.citedSources).toEqual(['OIB-RL6.pdf, p.3'])
  })

  it('omits clean turns — the export exists to be diagnosed, not counted', async () => {
    listEventsForExport.mockResolvedValue([
      event({ id: 'clean', turnId: 'turn_clean' }),
      event({ id: 'a', turnId: 'turn_bad' }),
      event({ id: 'b', turnId: 'turn_bad', kind: 'registry_empty', severity: 'error' }),
    ])

    const bundle = await getCitationExport(LAST_7)
    expect(bundle.turns.map((turn) => turn.turnId)).toEqual(['turn_bad'])
    // The window's counts still cover every turn.
    expect(bundle.summary.turns).toBe(2)
  })

  it('reports a defect turn that never wrote a baseline row', async () => {
    // registry_empty fails before verification, so it has no turn_verified row.
    listEventsForExport.mockResolvedValue([
      event({
        id: 'only',
        kind: 'registry_empty',
        severity: 'error',
        detail: { available_tools: 0, unavailable_tools: ['ris_search_tool'] },
      }),
    ])

    const turn = (await getCitationExport(LAST_7)).turns[0]
    expect(turn.problems[0].kind).toBe('registry_empty')
    expect(turn.sourceCount).toBeNull()
  })

  it('flags truncation instead of silently returning a prefix', async () => {
    // EXPORT_ROW_CAP is mocked to 3; the repository returns cap + 1.
    listEventsForExport.mockResolvedValue([
      event({ id: '1', turnId: 't1', kind: 'citations_removed', severity: 'warn' }),
      event({ id: '2', turnId: 't2', kind: 'citations_removed', severity: 'warn' }),
      event({ id: '3', turnId: 't3', kind: 'citations_removed', severity: 'warn' }),
      event({ id: '4', turnId: 't4', kind: 'citations_removed', severity: 'warn' }),
    ])

    const bundle = await getCitationExport(LAST_7)
    expect(bundle.truncated).toBe(true)
    expect(bundle.turns).toHaveLength(3)
  })

  it('does not flag truncation when the window fits', async () => {
    listEventsForExport.mockResolvedValue([event({ kind: 'citations_removed', severity: 'warn' })])
    expect((await getCitationExport(LAST_7)).truncated).toBe(false)
  })

  it('ignores malformed target entries rather than failing the export', async () => {
    listEventsForExport.mockResolvedValue([
      event({
        kind: 'citations_removed',
        severity: 'warn',
        detail: { targets: [{ reason: 'unverifiable' }, 'junk', { target: 'ok.pdf' }] },
      }),
    ])

    const turn = (await getCitationExport(LAST_7)).turns[0]
    expect(turn.problems[0].failedSources).toEqual([{ target: 'ok.pdf', reason: 'unverifiable' }])
  })
})
