/**
 * @vitest-environment node
 */
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

vi.mock('@/lib/organizations/display-names', () => ({
  getOrganizationDisplayNames: vi.fn(),
}))

vi.mock('@/lib/knowledge/service', () => ({
  getKnowledgeBaseStatus: vi.fn().mockResolvedValue({ files: [] }),
}))

vi.mock('@/lib/norms/service', () => ({
  getNormRegistry: vi.fn().mockResolvedValue({ registry: { entries: [] } }),
}))

import * as repository from './repository'
import { getOrganizationDisplayNames } from '@/lib/organizations/display-names'
import { getKnowledgeBaseStatus } from '@/lib/knowledge/service'
import { getNormRegistry } from '@/lib/norms/service'
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
const mockNames = vi.mocked(getOrganizationDisplayNames)

/** Resolve names from a fixed directory, the way the real resolver would. */
function withNames(directory: Record<string, string>): void {
  mockNames.mockImplementation(async (ids) => {
    const names = new Map<string, string>()
    for (const id of ids) if (id && directory[id]) names.set(id, directory[id])
    return names
  })
}

/** Every repository call resolves empty unless a test overrides it. */
function withEmptyRepository(): void {
  mocked.observed.mockResolvedValue(0)
  mocked.defective.mockResolvedValue(0)
  mocked.byKind.mockResolvedValue([])
  mocked.dailyKind.mockResolvedValue([])
  mocked.dailyTurns.mockResolvedValue([])
  mocked.reasons.mockResolvedValue([])
  mocked.sourceMix.mockResolvedValue([])
  mocked.unavailableTools.mockResolvedValue({ rows: [], total: 0 })
  mocked.failedTargets.mockResolvedValue({ rows: [], total: 0 })
  mocked.targetTurns.mockResolvedValue(0)
  mocked.byOrg.mockResolvedValue({ rows: [], total: 0 })
  mocked.recent.mockResolvedValue([])
  withNames({})
  vi.mocked(getKnowledgeBaseStatus).mockResolvedValue({ files: [] } as never)
  vi.mocked(getNormRegistry).mockResolvedValue({ registry: { entries: [] } } as never)
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
    expect(snapshot.byKind.map((row) => row.kind)).toEqual([
      'citations_removed',
      'quote_unverified',
    ])
    expect(snapshot.byKind[0].share).toBeCloseTo(11 / 50)
  })

  it('zero-fills the daily trend and excludes the baseline row from the stack', async () => {
    mocked.dailyTurns.mockResolvedValue([{ day: '2026-07-27', turns: 12, defectTurns: 5 }])
    mocked.dailyKind.mockResolvedValue([
      { day: '2026-07-27', kind: 'turn_verified', turns: 12 },
      { day: '2026-07-27', kind: 'citations_removed', turns: 4 },
      { day: '2026-07-27', kind: 'quote_unverified', turns: 2 },
    ])

    const snapshot = await getCitationHealth({ days: 3 })
    expect(snapshot.dailyTrend.map((point) => point.day)).toEqual([
      '2026-07-26',
      '2026-07-27',
      '2026-07-28',
    ])
    expect(snapshot.dailyTrend[0]).toEqual({
      day: '2026-07-26',
      turns: 0,
      defectTurns: 0,
      byKind: {},
    })
    const busy = snapshot.dailyTrend[1]
    expect(busy.byKind).toEqual({ citations_removed: 4, quote_unverified: 2 })
    expect(busy.defectTurns).toBe(5)
  })

  it('reports the distinct defective turns per day, not a bound from the per-kind counts', async () => {
    // Regression: the day's figure was max(per-kind turns), a lower bound shown
    // as exact. Four removal turns and two quote turns that are different turns
    // are six bad turns, which only the database can know.
    mocked.dailyTurns.mockResolvedValue([{ day: '2026-07-28', turns: 10, defectTurns: 6 }])
    mocked.dailyKind.mockResolvedValue([
      { day: '2026-07-28', kind: 'citations_removed', turns: 4 },
      { day: '2026-07-28', kind: 'quote_unverified', turns: 2 },
    ])

    const snapshot = await getCitationHealth({ days: 1 })
    expect(snapshot.dailyTrend[0].defectTurns).toBe(6)
  })

  it('computes each reason’s share of its own kind’s items', async () => {
    mocked.byKind.mockResolvedValue([{ kind: 'citations_removed', turns: 10, items: 40 }])
    mocked.reasons.mockResolvedValue([
      { kind: 'citations_removed', reason: 'url_not_in_registry', occurrences: 30 },
      { kind: 'citations_removed', reason: 'duplicate', occurrences: 10 },
    ])

    const snapshot = await getCitationHealth()
    expect(snapshot.reasons[0].share).toBeCloseTo(0.75)
    expect(snapshot.reasons[1].share).toBeCloseTo(0.25)
  })

  it('does not let confidence_capped reasons dilute the removed-citation shares', async () => {
    // Regression: shares were taken over every reason of every kind, so 60
    // capped answers turned "75 % of removals were invented" into 30 % and
    // suppressed the citations_invented finding.
    mocked.observed.mockResolvedValue(100)
    mocked.defective.mockResolvedValue(80)
    mocked.byKind.mockResolvedValue([
      { kind: 'citations_removed', turns: 40, items: 40 },
      { kind: 'confidence_capped', turns: 60, items: 60 },
    ])
    mocked.reasons.mockResolvedValue([
      { kind: 'confidence_capped', reason: 'ungrounded', occurrences: 60 },
      { kind: 'citations_removed', reason: 'url_not_in_registry', occurrences: 30 },
      { kind: 'citations_removed', reason: 'duplicate', occurrences: 10 },
    ])

    const snapshot = await getCitationHealth()
    const removed = snapshot.reasons.find((row) => row.reason === 'url_not_in_registry')
    expect(removed?.share).toBeCloseTo(0.75)
    expect(snapshot.reasons.find((row) => row.kind === 'confidence_capped')?.share).toBeCloseTo(1)
    const invented = snapshot.findings.find((finding) => finding.id === 'citations_invented')
    expect(invented?.metrics.share).toBeCloseTo(0.75)
  })

  it('resolves organization names and sorts by defect volume before rate', async () => {
    mocked.byOrg.mockResolvedValue({
      rows: [
        { organizationId: 'org_big', turns: 500, defectTurns: 50, errorTurns: 4 },
        { organizationId: 'org_small', turns: 2, defectTurns: 2, errorTurns: 0 },
      ],
      total: 2,
    })
    withNames({ org_big: 'Bauwerk' })

    const snapshot = await getCitationHealth()
    // A single bad turn at 100 % must not outrank 50 bad turns at 10 %.
    expect(snapshot.organizations.map((org) => org.organizationId)).toEqual([
      'org_big',
      'org_small',
    ])
    expect(snapshot.organizations[0].name).toBe('Bauwerk')
    expect(snapshot.organizations[0].defectRate).toBeCloseTo(0.1)
    // Unknown to the resolver — degrades to a null name, never throws.
    expect(snapshot.organizations[1].name).toBeNull()
    expect(snapshot.organizationsTotal).toBe(2)
  })

  it('lists the top 50 organizations, reports the total, and still finds the outlier below them', async () => {
    // Regression: the SQL list stopped at 50, so an organization at five times
    // the platform rate but with few defect turns never reached the outlier
    // rule; and names came from the first WorkOS page of 100 organizations.
    const busy = Array.from({ length: 60 }, (_, index) => ({
      organizationId: `org_${index}`,
      turns: 1000,
      defectTurns: 100,
      errorTurns: 0,
    }))
    const outlier = { organizationId: 'org_outlier', turns: 40, defectTurns: 30, errorTurns: 0 }
    mocked.observed.mockResolvedValue(60_040)
    mocked.defective.mockResolvedValue(6_030)
    mocked.byOrg.mockResolvedValue({ rows: [...busy, outlier], total: 61 })
    withNames({ org_outlier: 'Statik Nord' })

    const snapshot = await getCitationHealth()
    expect(snapshot.organizations).toHaveLength(50)
    expect(snapshot.organizationsTotal).toBe(61)
    const finding = snapshot.findings.find((entry) => entry.id === 'organization_outlier')
    expect(finding?.subject).toEqual({ type: 'organization', label: 'Statik Nord' })
    // Only the listed organizations and the outlier are resolved.
    const requested = [...(mockNames.mock.calls[0][0] as Iterable<string>)]
    expect(requested).toHaveLength(51)
    expect(requested).toContain('org_outlier')
  })

  it('lists the top 25 missing sources but counts every scanned one in the findings', async () => {
    // Regression: only 25 targets were read, and the finding's "{sources}
    // sources" was the length of that list, worded as a total.
    const rows = Array.from({ length: 30 }, (_, index) => ({
      target: `missing-${index}.pdf`,
      reason: 'citation_key_not_in_registry',
      turns: 30 - index,
      organizations: 1,
      lastSeenAt: new Date('2026-07-27T10:00:00.000Z'),
    }))
    mocked.observed.mockResolvedValue(100)
    mocked.defective.mockResolvedValue(40)
    mocked.failedTargets.mockResolvedValue({ rows, total: 1200 })
    mocked.targetTurns.mockResolvedValue(40)

    const snapshot = await getCitationHealth()
    expect(snapshot.missingSources).toHaveLength(25)
    expect(snapshot.missingSourcesTotal).toBe(1200)
    const missing = snapshot.findings.find((entry) => entry.id === 'sources_missing')
    expect(missing?.metrics.sources).toBe(30)
  })

  it('counts every unavailable tool, not just the listed ones', async () => {
    mocked.observed.mockResolvedValue(10)
    mocked.defective.mockResolvedValue(3)
    mocked.byKind.mockResolvedValue([{ kind: 'registry_empty', turns: 3, items: 3 }])
    mocked.unavailableTools.mockResolvedValue({
      rows: [{ tool: 'ris_search_tool', turns: 3 }],
      total: 11,
    })

    const snapshot = await getCitationHealth()
    expect(
      snapshot.findings.find((entry) => entry.id === 'retrieval_unavailable')?.metrics.tools
    ).toBe(11)
  })

  describe('platform inventory', () => {
    const heldDocument = {
      target: 'OIB-RL6-2023.pdf, p.12',
      reason: 'citation_key_not_in_registry',
      turns: 9,
      organizations: 2,
      lastSeenAt: new Date('2026-07-27T10:00:00.000Z'),
    }

    it('reports a known inventory when both backends answer', async () => {
      vi.mocked(getKnowledgeBaseStatus).mockResolvedValue({
        files: [{ fileName: 'OIB-RL6-2023.pdf' }],
      } as never)
      mocked.failedTargets.mockResolvedValue({ rows: [heldDocument], total: 1 })

      const snapshot = await getCitationHealth()
      expect(snapshot.inventoryKnown).toBe(true)
      expect(snapshot.missingSources[0]).toMatchObject({
        present: true,
        action: 'investigate_retrieval',
      })
    })

    it('fails closed when the corpus cannot be read: no upload is offered for a document it may hold', async () => {
      // Regression: an unreachable knowledge backend read as an empty corpus,
      // so every held document was offered for upload again.
      vi.mocked(getKnowledgeBaseStatus).mockRejectedValue(new Error('backend down'))
      mocked.observed.mockResolvedValue(10)
      mocked.defective.mockResolvedValue(9)
      mocked.failedTargets.mockResolvedValue({ rows: [heldDocument], total: 1 })

      const snapshot = await getCitationHealth()
      expect(snapshot.inventoryKnown).toBe(false)
      expect(snapshot.missingSources[0]).toMatchObject({
        present: null,
        action: 'inventory_unknown',
      })
      expect(snapshot.findings.map((entry) => entry.id)).not.toContain('sources_missing')
      expect(snapshot.findings.map((entry) => entry.id)).not.toContain('sources_unretrievable')
    })

    it('still classifies RIS pointers when only the corpus is down', async () => {
      vi.mocked(getKnowledgeBaseStatus).mockRejectedValue(new Error('backend down'))
      mocked.failedTargets.mockResolvedValue({
        rows: [
          {
            ...heldDocument,
            target: 'https://ris.bka.gv.at/Dokument.wxe?Dokumentnummer=NOR40021234',
          },
        ],
        total: 1,
      })

      const snapshot = await getCitationHealth()
      expect(snapshot.inventoryKnown).toBe(false)
      expect(snapshot.missingSources[0]).toMatchObject({
        present: false,
        action: 'add_to_norm_catalog',
      })
    })
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
