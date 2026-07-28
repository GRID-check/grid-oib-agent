import { describe, expect, it, vi } from 'vitest'

vi.mock('./repository', () => ({}))
vi.mock('@/lib/workos/client', () => ({ getWorkOS: vi.fn() }))
vi.mock('@/lib/knowledge/service', () => ({ getKnowledgeBaseStatus: vi.fn() }))
vi.mock('@/lib/norms/service', () => ({ getNormRegistry: vi.fn() }))

import { buildFindings, type CitationKindTotal, type CitationOrganizationTotal, type CitationReasonTotal } from './service'

/**
 * The findings engine IS the actionable half of the feature — an operator acts
 * on what it says. These tests pin the rules, the thresholds, and the ordering.
 */

const kind = (k: string, turns: number, items = turns): CitationKindTotal =>
  ({ kind: k, turns, items, share: 0 }) as CitationKindTotal

const reason = (r: string, share: number): CitationReasonTotal =>
  ({ kind: 'citations_removed', reason: r, occurrences: Math.round(share * 100), share }) as CitationReasonTotal

const org = (overrides: Partial<CitationOrganizationTotal>): CitationOrganizationTotal => ({
  organizationId: 'org_1',
  name: 'Tenant',
  turns: 100,
  defectTurns: 10,
  errorTurns: 0,
  defectRate: 0.1,
  ...overrides,
})

const base = {
  turns: 1000,
  defectTurns: 0,
  byKind: [] as CitationKindTotal[],
  reasons: [] as CitationReasonTotal[],
  organizations: [] as CitationOrganizationTotal[],
  unavailableTools: [] as { tool: string; turns: number }[],
}

const ids = (findings: { id: string }[]): string[] => findings.map((finding) => finding.id)

describe('buildFindings', () => {
  it('returns nothing at all when no turns were observed', () => {
    // An empty window has no diagnosis — not even "all clear", which would
    // claim a health verdict the data cannot support.
    expect(buildFindings({ ...base, turns: 0 })).toEqual([])
  })

  it('reports an explicit all-clear when turns ran and nothing tripped', () => {
    const findings = buildFindings(base)
    expect(ids(findings)).toEqual(['all_clear'])
    expect(findings[0].metrics).toEqual({ turns: 1000, share: 100 })
  })

  it('names the unavailable tool when retrieval captured nothing', () => {
    const findings = buildFindings({
      ...base,
      defectTurns: 3,
      byKind: [kind('registry_empty', 3)],
      unavailableTools: [
        { tool: 'ris_search_tool', turns: 3 },
        { tool: 'web_search', turns: 1 },
      ],
    })
    const retrieval = findings.find((f) => f.id === 'retrieval_unavailable')
    expect(retrieval).toBeDefined()
    expect(retrieval?.severity).toBe('error')
    expect(retrieval?.subject).toEqual({ type: 'tool', label: 'ris_search_tool' })
    expect(retrieval?.metrics).toEqual({ turns: 3, tools: 2 })
  })

  it('still raises retrieval_unavailable without a named tool', () => {
    const findings = buildFindings({ ...base, defectTurns: 1, byKind: [kind('registry_empty', 1)] })
    expect(findings.find((f) => f.id === 'retrieval_unavailable')?.subject).toBeNull()
  })

  it('flags ungrounded answers above the 1 % share and points at the worst org', () => {
    const findings = buildFindings({
      ...base,
      defectTurns: 20,
      byKind: [kind('answer_ungrounded', 20)],
      organizations: [org({ name: 'Bauwerk', defectTurns: 18 })],
    })
    const ungrounded = findings.find((f) => f.id === 'answers_ungrounded')
    expect(ungrounded?.severity).toBe('error')
    expect(ungrounded?.subject).toEqual({ type: 'organization', label: 'Bauwerk' })
    expect(ungrounded?.metrics.share).toBe(2)
  })

  it('stays quiet on a single ungrounded answer in a busy window', () => {
    const findings = buildFindings({ ...base, defectTurns: 1, byKind: [kind('answer_ungrounded', 1)] })
    expect(ids(findings)).not.toContain('answers_ungrounded')
  })

  it('blames invention only when removals are both frequent AND registry misses', () => {
    const frequentAndInvented = buildFindings({
      ...base,
      defectTurns: 80,
      byKind: [kind('citations_removed', 80, 240)],
      reasons: [reason('url_not_in_registry', 0.5), reason('duplicate', 0.5)],
    })
    expect(ids(frequentAndInvented)).toContain('citations_invented')

    // Same volume, but the removals are duplicates — cosmetic, not invention.
    const frequentButCosmetic = buildFindings({
      ...base,
      defectTurns: 80,
      byKind: [kind('citations_removed', 80, 240)],
      reasons: [reason('duplicate', 0.9), reason('url_not_in_registry', 0.1)],
    })
    expect(ids(frequentButCosmetic)).not.toContain('citations_invented')
    expect(ids(frequentButCosmetic)).toContain('duplicates_only')

    // Invention-shaped, but far too rare to act on.
    const rare = buildFindings({
      ...base,
      defectTurns: 10,
      byKind: [kind('citations_removed', 10, 12)],
      reasons: [reason('url_not_in_registry', 1)],
    })
    expect(ids(rare)).not.toContain('citations_invented')
  })

  it('flags fabricated quotes above the 2 % share', () => {
    expect(
      ids(buildFindings({ ...base, defectTurns: 25, byKind: [kind('quote_unverified', 25, 40)] })),
    ).toContain('quotes_fabricated')
    expect(ids(buildFindings({ ...base, defectTurns: 15, byKind: [kind('quote_unverified', 15)] }))).not.toContain(
      'quotes_fabricated',
    )
  })

  it('flags a citation-format mismatch when the fallback keeps firing', () => {
    expect(ids(buildFindings({ ...base, defectTurns: 60, byKind: [kind('citation_fallback', 60)] }))).toContain(
      'citation_format_unparsed',
    )
  })

  it('singles out an organization at twice the platform rate, with enough volume', () => {
    const findings = buildFindings({
      ...base,
      defectTurns: 100,
      organizations: [org({ organizationId: 'org_bad', name: 'Statik Nord', turns: 50, defectTurns: 20, defectRate: 0.4 })],
    })
    const outlier = findings.find((f) => f.id === 'organization_outlier')
    expect(outlier?.subject).toEqual({ type: 'organization', label: 'Statik Nord' })
    expect(outlier?.metrics).toEqual({ share: 40, platformShare: 10, turns: 20 })
  })

  it('ignores a low-volume organization however bad its rate looks', () => {
    // 2 turns, both flagged, is noise — calling it out would send an operator
    // chasing a statistical artefact.
    const findings = buildFindings({
      ...base,
      defectTurns: 100,
      organizations: [org({ organizationId: 'org_tiny', turns: 2, defectTurns: 2, defectRate: 1 })],
    })
    expect(ids(findings)).not.toContain('organization_outlier')
  })

  it('orders errors before warnings before info, then by affected turns', () => {
    const findings = buildFindings({
      ...base,
      defectTurns: 200,
      byKind: [
        kind('citations_removed', 150, 400),
        kind('registry_empty', 2),
        kind('answer_ungrounded', 40),
        kind('quote_unverified', 30, 35),
      ],
      reasons: [reason('url_not_in_registry', 0.8), reason('duplicate', 0.2)],
    })
    expect(ids(findings)).toEqual([
      'answers_ungrounded', // error, 40 turns
      'retrieval_unavailable', // error, 2 turns
      'citations_invented', // warn, 150 turns
      'quotes_fabricated', // warn, 30 turns
    ])
  })

  it('does not claim all-clear once any rule fired', () => {
    const findings = buildFindings({ ...base, defectTurns: 3, byKind: [kind('registry_empty', 3)] })
    expect(ids(findings)).not.toContain('all_clear')
  })
})
