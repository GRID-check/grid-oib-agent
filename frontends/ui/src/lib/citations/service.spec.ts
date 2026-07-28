import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./repository', () => ({
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
  listEventsForExport: vi.fn(),
  EXPORT_ROW_CAP: 5000,
  aggregateByOrganization: vi.fn(),
  listRecentDefects: vi.fn(),
}))

vi.mock('@/lib/workos/client', () => ({
  getWorkOS: vi.fn(),
}))

vi.mock('@/lib/knowledge/service', () => ({
  getKnowledgeBaseStatus: vi.fn().mockResolvedValue({ files: [] }),
}))

vi.mock('@/lib/norms/service', () => ({
  getNormRegistry: vi.fn().mockResolvedValue({ registry: { entries: [] } }),
}))

import * as repository from './repository'
import { getWorkOS } from '@/lib/workos/client'
import { clampWindowDays, getCitationHealth, recordCitationEvents } from './service'
import type { CitationEvent } from '@/lib/db/schema'

const mocked = {
  insert: vi.mocked(repository.insertCitationEvents),
  observed: vi.mocked(repository.countObservedTurns),
  defective: vi.mocked(repository.countDefectiveTurns),
  byKind: vi.mocked(repository.aggregateByKind),
  dailyKind: vi.mocked(repository.aggregateDailyByKind),
  dailyTurns: vi.mocked(repository.aggregateDailyTurns),
  reasons: vi.mocked(repository.aggregateReasons),
  sourceMix: vi.mocked(repository.aggregateDefectiveSourceMix),
  unavailableTools: vi.mocked(repository.aggregateUnavailableTools),
  failedTargets: vi.mocked(repository.aggregateFailedTargets),
  targetTurns: vi.mocked(repository.countTurnsForTargets),
  byOrg: vi.mocked(repository.aggregateByOrganization),
  recent: vi.mocked(repository.listRecentDefects),
}
const mockGetWorkOS = vi.mocked(getWorkOS)

/** Every repository call resolves empty unless a test overrides it. */
function withEmptyRepository(): void {
  mocked.observed.mockResolvedValue(0)
  mocked.defective.mockResolvedValue(0)
  mocked.byKind.mockResolvedValue([])
  mocked.dailyKind.mockResolvedValue([])
  mocked.dailyTurns.mockResolvedValue([])
  mocked.reasons.mockResolvedValue([])
  mocked.sourceMix.mockResolvedValue([])
  mocked.unavailableTools.mockResolvedValue([])
  mocked.failedTargets.mockResolvedValue([])
  mocked.targetTurns.mockResolvedValue(0)
  mocked.byOrg.mockResolvedValue([])
  mocked.recent.mockResolvedValue([])
  mockGetWorkOS.mockReturnValue({
    organizations: { listOrganizations: vi.fn().mockResolvedValue({ data: [] }) },
  } as unknown as ReturnType<typeof getWorkOS>)
}

function event(overrides: Partial<CitationEvent> = {}): CitationEvent {
  return {
    id: 'row_1',
    organizationId: 'org_1',
    conversationId: 'conv_1',
    turnId: 'turn_1',
    jobId: null,
    agent: 'shallow',
    kind: 'citations_removed',
    severity: 'warn',
    count: 3,
    reasons: { url_not_in_registry: 3 },
    detail: null,
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
    ...overrides,
  } as CitationEvent
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'))
  withEmptyRepository()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('clampWindowDays', () => {
  it('defaults to 30 for missing or non-numeric input', () => {
    expect(clampWindowDays(undefined)).toBe(30)
    expect(clampWindowDays(Number.NaN)).toBe(30)
  })

  it('clamps to the supported 1–90 day range', () => {
    expect(clampWindowDays(0)).toBe(1)
    expect(clampWindowDays(7)).toBe(7)
    expect(clampWindowDays(365)).toBe(90)
  })
})

describe('recordCitationEvents', () => {
  it('delegates straight to the repository', async () => {
    mocked.insert.mockResolvedValue(2)
    const rows = [{ turnId: 't', agent: 'shallow', kind: 'turn_verified', severity: 'ok' }] as never
    expect(await recordCitationEvents(rows)).toBe(2)
    expect(mocked.insert).toHaveBeenCalledWith(rows)
  })
})

describe('getCitationHealth', () => {
  it('reports a fully clean window when nothing was observed', async () => {
    const snapshot = await getCitationHealth()
    // No traffic must never read as "everything is broken".
    expect(snapshot.totals).toMatchObject({ turns: 0, defectTurns: 0, cleanTurns: 0, cleanRate: 1 })
    expect(snapshot.byKind).toEqual([])
  })

  it('queries the window starting at UTC midnight, windowDays-1 days back', async () => {
    await getCitationHealth({ days: 7 })
    // 2026-07-28 minus 6 days, at 00:00 UTC.
    expect(mocked.observed).toHaveBeenCalledWith(new Date('2026-07-22T00:00:00.000Z'))
  })

  it('derives the clean rate from distinct observed turns, not baseline rows', async () => {
    // A registry_empty turn never reaches verification, so it has no
    // turn_verified row — counting only baseline rows would understate traffic.
    mocked.observed.mockResolvedValue(100)
    mocked.defective.mockResolvedValue(20)
    mocked.byKind.mockResolvedValue([
      { kind: 'turn_verified', turns: 98, items: 98 },
      { kind: 'citations_removed', turns: 18, items: 44 },
      { kind: 'registry_empty', turns: 2, items: 2 },
    ])

    const snapshot = await getCitationHealth()
    expect(snapshot.totals.turns).toBe(100)
    expect(snapshot.totals.cleanTurns).toBe(80)
    expect(snapshot.totals.cleanRate).toBeCloseTo(0.8)
    expect(snapshot.totals.citationsRemoved).toBe(44)
    expect(snapshot.totals.emptyRegistries).toBe(2)
  })

  it('ranks defect kinds by affected turns and drops kinds with none', async () => {
    mocked.observed.mockResolvedValue(50)
    mocked.byKind.mockResolvedValue([
      { kind: 'turn_verified', turns: 50, items: 50 },
      { kind: 'quote_unverified', turns: 3, items: 4 },
      { kind: 'citations_removed', turns: 11, items: 30 },
    ])

    const snapshot = await getCitationHealth()
    expect(snapshot.byKind.map((row) => row.kind)).toEqual(['citations_removed', 'quote_unverified'])
    expect(snapshot.byKind[0].share).toBeCloseTo(11 / 50)
  })

  it('zero-fills the daily trend and excludes the baseline row from the stack', async () => {
    mocked.dailyTurns.mockResolvedValue([{ day: '2026-07-27', turns: 12 }])
    mocked.dailyKind.mockResolvedValue([
      { day: '2026-07-27', kind: 'turn_verified', turns: 12 },
      { day: '2026-07-27', kind: 'citations_removed', turns: 4 },
      { day: '2026-07-27', kind: 'quote_unverified', turns: 2 },
    ])

    const snapshot = await getCitationHealth({ days: 3 })
    expect(snapshot.dailyTrend.map((point) => point.day)).toEqual(['2026-07-26', '2026-07-27', '2026-07-28'])
    expect(snapshot.dailyTrend[0]).toEqual({ day: '2026-07-26', turns: 0, defectTurns: 0, byKind: {} })
    const busy = snapshot.dailyTrend[1]
    expect(busy.byKind).toEqual({ citations_removed: 4, quote_unverified: 2 })
    // Defects are not additive across kinds — one turn can carry several.
    expect(busy.defectTurns).toBe(4)
  })

  it('never reports more defective turns than turns observed that day', async () => {
    mocked.dailyTurns.mockResolvedValue([{ day: '2026-07-28', turns: 3 }])
    mocked.dailyKind.mockResolvedValue([{ day: '2026-07-28', kind: 'citations_removed', turns: 9 }])

    const snapshot = await getCitationHealth({ days: 1 })
    expect(snapshot.dailyTrend[0].defectTurns).toBe(3)
  })

  it('computes each reason’s share of all reason occurrences', async () => {
    mocked.reasons.mockResolvedValue([
      { kind: 'citations_removed', reason: 'url_not_in_registry', occurrences: 30 },
      { kind: 'citations_removed', reason: 'duplicate', occurrences: 10 },
    ])

    const snapshot = await getCitationHealth()
    expect(snapshot.reasons[0].share).toBeCloseTo(0.75)
    expect(snapshot.reasons[1].share).toBeCloseTo(0.25)
  })

  it('resolves organization names and sorts by defect volume before rate', async () => {
    mocked.byOrg.mockResolvedValue([
      { organizationId: 'org_big', turns: 500, defectTurns: 50, errorTurns: 4 },
      { organizationId: 'org_small', turns: 2, defectTurns: 2, errorTurns: 0 },
    ])
    mockGetWorkOS.mockReturnValue({
      organizations: {
        listOrganizations: vi.fn().mockResolvedValue({ data: [{ id: 'org_big', name: 'Bauwerk' }] }),
      },
    } as unknown as ReturnType<typeof getWorkOS>)

    const snapshot = await getCitationHealth()
    // A single bad turn at 100 % must not outrank 50 bad turns at 10 %.
    expect(snapshot.organizations.map((org) => org.organizationId)).toEqual(['org_big', 'org_small'])
    expect(snapshot.organizations[0].name).toBe('Bauwerk')
    expect(snapshot.organizations[0].defectRate).toBeCloseTo(0.1)
    // Unknown to WorkOS — degrades to a null name, never throws.
    expect(snapshot.organizations[1].name).toBeNull()
  })

  it('degrades to bare organization ids when WorkOS is unavailable', async () => {
    mocked.byOrg.mockResolvedValue([{ organizationId: 'org_1', turns: 10, defectTurns: 1, errorTurns: 0 }])
    mockGetWorkOS.mockReturnValue({
      organizations: { listOrganizations: vi.fn().mockRejectedValue(new Error('workos down')) },
    } as unknown as ReturnType<typeof getWorkOS>)

    const snapshot = await getCitationHealth()
    expect(snapshot.organizations[0].name).toBeNull()
  })

  it('serializes recent defects with ISO timestamps and the profiler turn id', async () => {
    mocked.recent.mockResolvedValue([event()])

    const snapshot = await getCitationHealth()
    expect(snapshot.recent[0]).toEqual({
      id: 'row_1',
      createdAt: '2026-07-20T10:00:00.000Z',
      kind: 'citations_removed',
      severity: 'warn',
      agent: 'shallow',
      count: 3,
      reasons: { url_not_in_registry: 3 },
      organizationId: 'org_1',
      conversationId: 'conv_1',
      turnId: 'turn_1',
    })
  })
})
