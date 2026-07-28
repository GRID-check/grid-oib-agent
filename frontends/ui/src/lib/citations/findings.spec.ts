import { describe, expect, it, vi } from 'vitest'

vi.mock('./repository', () => ({}))
vi.mock('@/lib/workos/client', () => ({ getWorkOS: vi.fn() }))
vi.mock('@/lib/knowledge/service', () => ({ getKnowledgeBaseStatus: vi.fn() }))
vi.mock('@/lib/norms/service', () => ({ getNormRegistry: vi.fn() }))

import { buildFindings, type CitationKindTotal, type CitationOrganizationTotal, type CitationReasonTotal } from './service'
import type { MissingSourceCandidate } from './missing-sources'

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

const candidate = (overrides: Partial<MissingSourceCandidate>): MissingSourceCandidate => ({
  target: 'oib-rl_2_ausgabe_mai_2023.pdf, p.4',
  kind: 'document',
  reason: 'citation_key_not_in_registry',
  turns: 1,
  organizations: 1,
  lastSeenAt: '2026-07-28T17:09:40.000Z',
  present: true,
  action: 'investigate_retrieval',
  fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
  documentNumber: null,
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

  it('flags ungrounded answers above the 1 % share, unattributed', () => {
    const findings = buildFindings({
      ...base,
      defectTurns: 20,
      byKind: [kind('answer_ungrounded', 20)],
      organizations: [org({ name: 'Bauwerk', defectTurns: 18 })],
    })
    const ungrounded = findings.find((f) => f.id === 'answers_ungrounded')
    expect(ungrounded?.severity).toBe('error')
    expect(ungrounded?.metrics.share).toBe(2)
    // Must NOT borrow the worst org from the overall defect rollup: that org's
    // 18 defects may be removals with zero ungrounded answers among them, and
    // naming it would send an operator to audit the wrong tenant's corpus.
    expect(ungrounded?.subject).toBeNull()
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

  it('does not accuse the model of inventing sources the platform actually holds', () => {
    // The regression this guards: `citation_key_not_in_registry` means "not
    // among the sources RETRIEVED on that turn", not "unknown to the platform".
    // Reading it as invention produced two contradictory diagnoses for the same
    // removals — "tighten the prompt" next to "check your indexing".
    const findings = buildFindings({
      ...base,
      turns: 1,
      defectTurns: 1,
      byKind: [kind('citations_removed', 1, 3)],
      reasons: [reason('citation_key_not_in_registry', 1)],
      missingSources: [
        candidate({ target: 'erlaeuterungen_oib-rl_2.1_ausgabe_mai_2023.pdf' }),
        candidate({ target: 'erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf' }),
        candidate({ target: 'oib-rl_2_ausgabe_mai_2023.pdf' }),
      ],
      missingSourceTurns: { held: 1, addable: 0 },
    })
    expect(ids(findings)).not.toContain('citations_invented')
    expect(ids(findings)).toContain('sources_unretrievable')
  })

  it('counts a cited web page as invention even though it cannot be added', () => {
    // `action: 'none'` means "no remedy", not "the platform has it" — a web URL
    // retrieval never returned is the clearest case of a source written from
    // memory, and gating on addability would have hidden it.
    const findings = buildFindings({
      ...base,
      defectTurns: 80,
      byKind: [kind('citations_removed', 80, 240)],
      reasons: [reason('url_not_in_registry', 1)],
      missingSources: [
        candidate({ target: 'https://example.test/leitfaden', kind: 'web', present: false, action: 'none', fileName: null }),
      ],
    })
    expect(findings.find((f) => f.id === 'citations_invented')?.metrics.unheld).toBe(1)
    expect(ids(findings)).not.toContain('sources_missing')
  })

  it('still blames invention when a rejected source is held nowhere', () => {
    const findings = buildFindings({
      ...base,
      defectTurns: 80,
      byKind: [kind('citations_removed', 80, 240)],
      reasons: [reason('citation_key_not_in_registry', 1)],
      missingSources: [
        candidate({ target: 'erfundene_norm.pdf', present: false, action: 'upload_to_base_knowledge' }),
        candidate({ target: 'oib-rl_2_ausgabe_mai_2023.pdf' }),
      ],
      missingSourceTurns: { held: 40, addable: 50 },
    })
    const invented = findings.find((f) => f.id === 'citations_invented')
    expect(invented?.metrics.unheld).toBe(1)
  })

  it('never reports more affected turns than the window flagged', () => {
    // Three sources rejected on ONE turn are three candidate rows, each with
    // turns: 1. Summing them claimed three turns in a window that had one.
    const findings = buildFindings({
      ...base,
      turns: 1,
      defectTurns: 1,
      byKind: [kind('citations_removed', 1, 3)],
      missingSources: [
        candidate({ target: 'a.pdf' }),
        candidate({ target: 'b.pdf' }),
        candidate({ target: 'c.pdf' }),
      ],
      missingSourceTurns: { held: 1, addable: 0 },
    })
    const unretrievable = findings.find((f) => f.id === 'sources_unretrievable')
    expect(unretrievable?.metrics).toEqual({ sources: 3, turns: 1 })
  })

  it('falls back to the flagged-turn ceiling when the exact union is unavailable', () => {
    const findings = buildFindings({
      ...base,
      turns: 10,
      defectTurns: 2,
      byKind: [kind('citations_removed', 2, 6)],
      missingSources: [candidate({ target: 'a.pdf' }), candidate({ target: 'b.pdf' }), candidate({ target: 'c.pdf' })],
    })
    expect(findings.find((f) => f.id === 'sources_unretrievable')?.metrics.turns).toBe(2)
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

  it('never names the unattributed bucket as the outlier', () => {
    // organizationId null is "events we could not attribute", not a tenant an
    // operator can go look at — and it would render an empty subject label.
    const findings = buildFindings({
      ...base,
      defectTurns: 100,
      organizations: [
        org({ organizationId: null, name: null, turns: 200, defectTurns: 80, defectRate: 0.4 }),
      ],
    })
    expect(ids(findings)).not.toContain('organization_outlier')
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
