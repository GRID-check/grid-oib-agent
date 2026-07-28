'use client'

/**
 * Dev preview for the platform CitationHealth card. Renders the REAL card with
 * fixture data so the stat tiles, the stacked defect trend, the reason /
 * source breakdowns, the per-organization table and the recent-findings list
 * can be reviewed and screenshotted without a backend. A module-scope fetch
 * shim (browser + dev only) serves `/api/platform/citation-health`. Not linked
 * from anywhere and 404s outside development.
 */

import { notFound } from 'next/navigation'
import { CitationHealth } from '@/features/platform/components/citation-health'

const WINDOW_DAYS = 30

/**
 * A deterministic 30-day series: a mostly-healthy baseline with a visible
 * incident in the middle of the window, so the stack shows several kinds at
 * once instead of a single flat series.
 */
const DAILY = Array.from({ length: WINDOW_DAYS }, (_, index) => {
  const day = new Date(Date.UTC(2026, 5, 28))
  day.setUTCDate(day.getUTCDate() + index)
  const incident = index >= 14 && index <= 18
  const byKind: Record<string, number> = {}
  if (index % 3 === 0 || incident) byKind.citations_removed = incident ? 9 + (index % 3) : 2
  if (incident) byKind.answer_ungrounded = 4 + (index % 2)
  if (index % 5 === 0 || incident) byKind.quote_unverified = incident ? 3 : 1
  if (incident && index === 16) byKind.registry_empty = 2
  if (index % 7 === 0) byKind.citation_fallback = 1
  const defectTurns = Math.max(0, ...Object.values(byKind))
  return { day: day.toISOString().slice(0, 10), turns: 40 + (index % 11), defectTurns, byKind }
})

const SNAPSHOT = {
  windowDays: WINDOW_DAYS,
  totals: {
    turns: 1348,
    defectTurns: 173,
    cleanTurns: 1175,
    cleanRate: 1175 / 1348,
    citationsRemoved: 412,
    unverifiedQuotes: 37,
    ungroundedAnswers: 26,
    emptyRegistries: 2,
  },
  findings: [
    {
      id: 'retrieval_unavailable',
      severity: 'error',
      subject: { type: 'tool', label: 'ris_search_tool' },
      metrics: { turns: 2, tools: 1 },
    },
    {
      id: 'answers_ungrounded',
      severity: 'error',
      subject: { type: 'organization', label: 'Bauwerk Consulting' },
      metrics: { turns: 26, share: 1.9 },
    },
    {
      id: 'sources_missing',
      severity: 'warn',
      subject: { type: 'tool', label: 'OIB-RL6-2023.pdf' },
      metrics: { sources: 2, turns: 55, automatic: 1 },
    },
    {
      id: 'sources_unretrievable',
      severity: 'warn',
      subject: { type: 'tool', label: 'OIB-RL2-2023.pdf' },
      metrics: { sources: 1, turns: 12 },
    },
    {
      id: 'citations_invented',
      severity: 'warn',
      subject: null,
      metrics: { turns: 121, citations: 412, share: 68, unheld: 3 },
    },
    {
      id: 'organization_outlier',
      severity: 'warn',
      subject: { type: 'organization', label: 'Bauwerk Consulting' },
      metrics: { share: 15.7, platformShare: 12.8, turns: 96 },
    },
  ],
  unavailableTools: [{ tool: 'ris_search_tool', turns: 2 }],
  missingSources: [
    {
      target: 'OIB-RL6-2023.pdf, p.12',
      kind: 'document',
      reason: 'citation_key_not_in_registry',
      turns: 34,
      organizations: 3,
      lastSeenAt: '2026-07-28T11:00:00Z',
      present: false,
      action: 'upload_to_base_knowledge',
      fileName: 'OIB-RL6-2023.pdf',
      documentNumber: null,
    },
    {
      target: 'https://ris.bka.gv.at/Dokument.wxe?Dokumentnummer=NOR40021234',
      kind: 'ris',
      reason: 'url_not_in_registry',
      turns: 21,
      organizations: 2,
      lastSeenAt: '2026-07-28T09:20:00Z',
      present: false,
      action: 'add_to_norm_catalog',
      fileName: null,
      documentNumber: 'NOR40021234',
    },
    {
      target: 'OIB-RL2-2023.pdf',
      kind: 'document',
      reason: 'citation_key_not_in_registry',
      turns: 12,
      organizations: 2,
      lastSeenAt: '2026-07-27T15:00:00Z',
      present: true,
      action: 'investigate_retrieval',
      fileName: 'OIB-RL2-2023.pdf',
      documentNumber: null,
    },
    {
      target: 'https://example.test/leitfaden',
      kind: 'web',
      reason: 'url_not_in_registry',
      turns: 6,
      organizations: 1,
      lastSeenAt: '2026-07-26T08:00:00Z',
      present: false,
      action: 'none',
      fileName: null,
      documentNumber: null,
    },
  ],
  byKind: [
    { kind: 'citations_removed', turns: 121, items: 412, share: 121 / 1348 },
    { kind: 'quote_unverified', turns: 31, items: 37, share: 31 / 1348 },
    { kind: 'answer_ungrounded', turns: 26, items: 26, share: 26 / 1348 },
    { kind: 'citation_fallback', turns: 14, items: 14, share: 14 / 1348 },
    { kind: 'registry_empty', turns: 2, items: 2, share: 2 / 1348 },
  ],
  dailyTrend: DAILY,
  reasons: [
    { kind: 'citations_removed', reason: 'url_not_in_registry', occurrences: 186, share: 0.41 },
    { kind: 'citations_removed', reason: 'citation_key_not_in_registry', occurrences: 121, share: 0.27 },
    { kind: 'citations_removed', reason: 'duplicate', occurrences: 68, share: 0.15 },
    { kind: 'citations_removed', reason: 'unverifiable', occurrences: 37, share: 0.08 },
    { kind: 'confidence_capped', reason: 'ungrounded', occurrences: 26, share: 0.06 },
    { kind: 'confidence_capped', reason: 'quote_unverified', occurrences: 14, share: 0.03 },
  ],
  sourceMix: [
    { dimension: 'tool', label: 'oib_knowledge_search', turns: 118 },
    { dimension: 'origin', label: 'kb', turns: 104 },
    { dimension: 'tool', label: 'ris_search_tool', turns: 74 },
    { dimension: 'origin', label: 'ris', turns: 69 },
    { dimension: 'tool', label: 'web_search', turns: 41 },
    { dimension: 'origin', label: 'web', turns: 38 },
  ],
  organizations: [
    {
      organizationId: 'org_01HZ',
      name: 'Bauwerk Consulting',
      turns: 612,
      defectTurns: 96,
      errorTurns: 11,
      defectRate: 96 / 612,
    },
    { organizationId: 'org_02KP', name: 'Statik Nord', turns: 431, defectTurns: 54, errorTurns: 8, defectRate: 54 / 431 },
    { organizationId: 'org_03QT', name: 'GRID Platform', turns: 218, defectTurns: 19, errorTurns: 5, defectRate: 19 / 218 },
    { organizationId: null, name: null, turns: 87, defectTurns: 4, errorTurns: 2, defectRate: 4 / 87 },
  ],
  recent: [
    {
      id: 'evt-1',
      createdAt: '2026-07-28T13:41:00Z',
      kind: 'answer_ungrounded',
      severity: 'error',
      agent: 'shallow',
      count: 1,
      reasons: null,
      organizationId: 'org_01HZ',
      conversationId: 'conv-8821',
      turnId: '5f3c9a12-7b41-4d0e-9f6a-2c8e1b47d903',
    },
    {
      id: 'evt-2',
      createdAt: '2026-07-28T13:22:00Z',
      kind: 'citations_removed',
      severity: 'warn',
      agent: 'shallow',
      count: 3,
      reasons: { url_not_in_registry: 2, duplicate: 1 },
      organizationId: 'org_01HZ',
      conversationId: 'conv-8820',
      turnId: 'a1d4e6b8-33c7-45f2-b0aa-91d5e2f77c48',
    },
    {
      id: 'evt-3',
      createdAt: '2026-07-28T12:58:00Z',
      kind: 'quote_unverified',
      severity: 'warn',
      agent: 'deep',
      count: 2,
      reasons: null,
      organizationId: 'org_02KP',
      conversationId: 'conv-8814',
      turnId: 'c9b2f107-64de-4a35-8e11-7d0a6c3f92b5',
    },
    {
      id: 'evt-4',
      createdAt: '2026-07-28T11:04:00Z',
      kind: 'registry_empty',
      severity: 'error',
      agent: 'deep',
      count: 1,
      reasons: null,
      organizationId: 'org_02KP',
      conversationId: null,
      turnId: '2e77a940-15bc-4c68-9d3f-0b8e4a1c567d',
    },
    {
      id: 'evt-5',
      createdAt: '2026-07-28T09:37:00Z',
      kind: 'citation_fallback',
      severity: 'info',
      agent: 'shallow',
      count: 1,
      reasons: null,
      organizationId: 'org_03QT',
      conversationId: 'conv-8790',
      turnId: '7a0e5c31-8f92-4b17-a6d4-3e5b9c0f2184',
    },
  ],
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __citationHealthShim?: boolean }
  if (!w.__citationHealthShim) {
    w.__citationHealthShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/platform/citation-health')) {
        return Response.json(SNAPSHOT)
      }
      return real(input, init)
    }
  }
}

export default function CitationHealthDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <div>
        <h1 className="text-lg font-semibold">Platform — Citation health</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Platform-owner surface: how often citation verification had to intervene, what it caught, and where.
        </p>
      </div>
      <CitationHealth />
    </main>
  )
}
