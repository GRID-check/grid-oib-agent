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
  aggregateByOrganization: vi.fn(),
  listRecentDefects: vi.fn(),
  getEventsForTurn: vi.fn(),
}))

vi.mock('@/lib/workos/client', () => ({ getWorkOS: vi.fn() }))

vi.mock('@/lib/knowledge/service', () => ({
  getKnowledgeBaseStatus: vi.fn().mockResolvedValue({ files: [] }),
}))

vi.mock('@/lib/norms/service', () => ({
  getNormRegistry: vi.fn().mockResolvedValue({ registry: { entries: [] } }),
}))

import * as repository from './repository'
import { getWorkOS } from '@/lib/workos/client'
import { getCitationExport } from './service'
import type { CitationEvent } from '@/lib/db/schema'

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
  vi.mocked(repository.aggregateUnavailableTools).mockResolvedValue([])
  vi.mocked(repository.aggregateFailedTargets).mockResolvedValue([])
  vi.mocked(repository.aggregateByOrganization).mockResolvedValue([
    { organizationId: 'org_1', turns: 2, defectTurns: 1, errorTurns: 0 },
  ])
  vi.mocked(repository.listRecentDefects).mockResolvedValue([])
  vi.mocked(getWorkOS).mockReturnValue({
    organizations: { listOrganizations: vi.fn().mockResolvedValue({ data: [{ id: 'org_1', name: 'Bauwerk' }] }) },
  } as unknown as ReturnType<typeof getWorkOS>)
  listEventsForExport.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getCitationExport', () => {
  it('carries a self-describing schema, window and glossary', async () => {
    const bundle = await getCitationExport({ days: 7 })
    expect(bundle.schema).toBe('grid.citation-health.export/v1')
    expect(bundle.windowDays).toBe(7)
    expect(bundle.windowStart).toBe('2026-07-22T00:00:00.000Z')
    expect(bundle.generatedAt).toBe('2026-07-28T12:00:00.000Z')
    // An agent reading the file cold must be able to interpret every kind.
    expect(Object.keys(bundle.glossary)).toContain('answer_ungrounded')
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

    const bundle = await getCitationExport()
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
      event({ id: 'c', kind: 'quote_unverified', severity: 'warn', detail: { cited_sources: ['OIB-RL6.pdf, p.3'] } }),
    ])

    const turn = (await getCitationExport()).turns[0]
    expect(turn.retrievedSources).toEqual(['OIB-RL6.pdf, p.3', 'https://ris.bka.gv.at/x'])
    expect(turn.citedSources).toEqual(['OIB-RL6.pdf, p.3'])
  })

  it('omits clean turns — the export exists to be diagnosed, not counted', async () => {
    listEventsForExport.mockResolvedValue([
      event({ id: 'clean', turnId: 'turn_clean' }),
      event({ id: 'a', turnId: 'turn_bad' }),
      event({ id: 'b', turnId: 'turn_bad', kind: 'registry_empty', severity: 'error' }),
    ])

    const bundle = await getCitationExport()
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

    const turn = (await getCitationExport()).turns[0]
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

    const bundle = await getCitationExport()
    expect(bundle.truncated).toBe(true)
    expect(bundle.turns).toHaveLength(3)
  })

  it('does not flag truncation when the window fits', async () => {
    listEventsForExport.mockResolvedValue([event({ kind: 'citations_removed', severity: 'warn' })])
    expect((await getCitationExport()).truncated).toBe(false)
  })

  it('ignores malformed target entries rather than failing the export', async () => {
    listEventsForExport.mockResolvedValue([
      event({
        kind: 'citations_removed',
        severity: 'warn',
        detail: { targets: [{ reason: 'unverifiable' }, 'junk', { target: 'ok.pdf' }] },
      }),
    ])

    const turn = (await getCitationExport()).turns[0]
    expect(turn.problems[0].failedSources).toEqual([{ target: 'ok.pdf', reason: 'unverifiable' }])
  })
})
