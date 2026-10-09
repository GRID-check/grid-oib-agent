'use client'

/**
 * Dev preview for the platform AgentProfiler (Answer quality → timing). Renders
 * the REAL organism over a module-scope fetch shim serving
 * `/api/platform/profiler/conversations` (list, `?q=` filters by title or id)
 * and `/api/platform/profiler/conversations/<id>` (timeline), in the shapes
 * `lib/profiler/service.ts` returns.
 *
 * The fixture carries the cases the view exists to tell apart: a nested turn
 * (step → model call → tool call), a failed tool call, a turn whose root span
 * never reached the ledger (the server's synthetic root), a capped timeline, a long list that has to scroll, and a conversation
 * without an organization. The first conversation is preselected the way a
 * citation-health link does it (`?conversation=`), unless the URL names another.
 *
 * The list is read in a scope like on the real page (`from`, `to`, repeatable
 * `org` and `project` on the URL; default the 30 days to 8 Oct 2026). The shim
 * answers by query: rows whose last activity falls in the range and whose
 * organization is named, and `selected` for the asked-about conversation.
 *
 * Variants: `?error` fails the first list load; `?empty` returns no
 * conversations; `?none` starts with nothing selected; `?narrow` reads two
 * organizations.
 *
 * Not linked from anywhere; 404s outside development. Pinned to German.
 */

import type { JSX } from 'react'
import { Suspense } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { AgentProfiler } from '@/features/platform/components/agent-profiler'
import { I18nProvider } from '@/i18n'
import { readQualityScope, type QualityScope } from '@/lib/quality/scope'

const BASE = Date.parse('2026-10-08T09:30:00Z')
const at = (offsetMs: number): string => new Date(BASE + offsetMs).toISOString()

const ORGS = [
  { id: 'org_01HZ', name: 'Bauwerk Consulting' },
  { id: 'org_02KP', name: 'Statik Nord' },
  { id: 'org_03QT', name: 'Architektur Huber & Partner' },
]

const TITLES = [
  'Brandabschnitte Tiefgarage Linz',
  'Fluchtweglängen Bürogeschoss nach OIB-RL 2',
  'Stellplatzschlüssel Wohnanlage Graz',
  'Barrierefreie Rampe Eingang Nord',
  'Schallschutz Trennwand Reihenhaus',
  'Absturzsicherung Dachterrasse',
  'Belichtung Aufenthaltsräume Souterrain',
  'U-Wert Nachweis Sanierung Altbau',
  'Abstandsflächen Zubau Wien 19',
  'Rauchableitung Stiegenhaus',
  'Tragwerk Holzdecke Spannweite',
  'Löschwasserversorgung Gewerbehalle',
  'Fensterflächen Kinderzimmer',
  'Aufzugspflicht ab drei Geschoßen',
]

const CONVERSATIONS = TITLES.map((title, index) => {
  const org = index === 5 ? null : ORGS[index % ORGS.length]
  return {
    conversationId: `c0f${index.toString(16).padStart(5, '0')}-4a1e-4b6d-9e2f-7d3c${(1000 + index).toString()}b2a1`,
    organizationId: org?.id ?? null,
    organizationName: org?.name ?? null,
    title: index === 9 ? null : title,
    turnCount: 1 + ((index * 3) % 7),
    totalDurationMs: 4200 + index * 9731,
    lastActiveAt: at(-index * 47 * 60_000),
  }
})

interface Span {
  spanId: string
  kind: 'turn' | 'node' | 'llm' | 'tool'
  name: string
  startedAt: string
  endedAt: string
  durationMs: number
  status: 'ok' | 'error'
  errorMessage: string | null
  metadata: { synthetic: true } | null
  children: Span[]
}

let spanSeq = 0
const span = (
  kind: Span['kind'],
  name: string,
  start: number,
  duration: number,
  children: Span[] = [],
  error: string | null = null
): Span => ({
  spanId: `span-${++spanSeq}`,
  kind,
  name,
  startedAt: at(start),
  endedAt: at(start + duration),
  durationMs: duration,
  status: error === null ? 'ok' : 'error',
  errorMessage: error,
  metadata: null,
  children,
})

const TIMELINE_TURNS = [
  {
    turnId: '5f3c9a12-7b41-4d0e-9f6a-2c8e1b47d903',
    jobId: 'job_8f21c7a04e',
    startedAt: at(0),
    durationMs: 18_420,
    status: 'ok',
    spanCount: 9,
    root: span('turn', 'piloti_turn', 0, 18_420, [
      span('node', 'route_question', 40, 820, [span('llm', 'gpt-5.1-mini · classify', 60, 760)]),
      span('node', 'retrieve', 900, 6_300, [
        span('tool', 'oib_knowledge_search', 920, 2_480),
        span('tool', 'ris_search_tool', 940, 5_910),
      ]),
      span('node', 'answer', 7_260, 11_100, [
        span('llm', 'claude-opus · write answer', 7_280, 9_850),
        span('tool', 'verify_citations', 17_160, 1_180),
      ]),
    ]),
  },
  {
    turnId: 'a1d4e6b8-33c7-45f2-b0aa-91d5e2f77c48',
    jobId: null,
    startedAt: at(120_000),
    durationMs: 9_640,
    status: 'error',
    spanCount: 6,
    root: span('turn', 'piloti_turn', 120_000, 9_640, [
      span('node', 'retrieve', 120_030, 4_100, [
        span('tool', 'oib_knowledge_search', 120_050, 1_920),
        span('tool', 'web_search', 120_060, 4_050, [], 'Timeout nach 4 s (HTTP 504)'),
      ]),
      span('node', 'answer', 124_200, 5_400, [
        span('llm', 'claude-opus · write answer', 124_220, 5_360),
      ]),
    ]),
  },
  {
    turnId: '2e77a940-15bc-4c68-9d3f-0b8e4a1c567d',
    jobId: null,
    startedAt: at(300_000),
    durationMs: 3_120,
    status: 'ok',
    spanCount: 3,
    // The server's stand-in for a root span that never reached the ledger.
    root: {
      ...span('turn', 'turn', 300_000, 3_120, [
        span('node', 'retrieve', 300_000, 1_240, [
          span('tool', 'oib_knowledge_search', 300_010, 1_200),
        ]),
        span('node', 'answer', 301_300, 1_820),
      ]),
      spanId: '2e77a940-15bc-4c68-9d3f-0b8e4a1c567d:root',
      metadata: { synthetic: true },
    },
  },
]

const params =
  typeof window === 'undefined'
    ? new URLSearchParams()
    : new URLSearchParams(window.location.search)

/** The page's scope: the URL's, else the fixture's 30 days; `?narrow` names two organizations. */
function previewScope(url: URLSearchParams): QualityScope {
  const read = new URLSearchParams(url)
  if (!read.has('from') && !read.has('days')) {
    read.set('from', '2026-09-09')
    read.set('to', '2026-10-08')
  }
  if (url.has('narrow')) {
    read.append('org', ORGS[0].id)
    read.append('org', ORGS[1].id)
  }
  return readQualityScope(read)
}

/** The fixture rows a scope holds, the way the server filters them. */
function inScope(scope: QualityScope): typeof CONVERSATIONS {
  return CONVERSATIONS.filter((row) => {
    const day = row.lastActiveAt.slice(0, 10)
    if (day < scope.from || day > scope.to) return false
    return (
      scope.organizationIds.length === 0 ||
      (row.organizationId !== null && scope.organizationIds.includes(row.organizationId))
    )
  })
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __agentProfilerShim?: boolean }
  if (!w.__agentProfilerShim) {
    w.__agentProfilerShim = true
    const real = window.fetch.bind(window)
    // Fails for the first seconds, so a dev StrictMode double mount still
    // sees the failure and a later Retry recovers.
    const failUntil = params.has('error') ? Date.now() + 2500 : 0
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const url = new URL(raw, window.location.origin)
      if (url.pathname === '/api/platform/profiler/conversations') {
        if (Date.now() < failUntil) {
          return new Response('{}', { status: 500 })
        }
        const q = url.searchParams.get('q')?.toLowerCase() ?? ''
        const scoped = params.has('empty') ? [] : inScope(readQualityScope(url.searchParams))
        const rows = scoped.filter(
          (row) =>
            !q || row.conversationId.includes(q) || (row.title ?? '').toLowerCase().includes(q)
        )
        const asked = url.searchParams.get('conversation')
        return Response.json({
          conversations: rows,
          capped: !q && rows.length > 0,
          ...(asked
            ? { selected: scoped.find((row) => row.conversationId === asked) ?? null }
            : {}),
        })
      }
      if (url.pathname.startsWith('/api/platform/profiler/conversations/')) {
        const conversationId = decodeURIComponent(url.pathname.split('/').pop() ?? '')
        // Capped like the server: the newest turns of a longer conversation.
        return Response.json({
          conversationId,
          turns: TIMELINE_TURNS,
          totalTurns: 57,
          capped: true,
        })
      }
      return real(input, init)
    }
  }
}

/**
 * The organism in the URL's scope. Read through `useSearchParams`, not the
 * module-scope `params`, so the server render and the client agree on it.
 */
function ScopedAgentProfiler({ initial }: { initial?: string }): JSX.Element {
  return (
    <AgentProfiler
      scope={previewScope(new URLSearchParams(useSearchParams()))}
      initialConversationId={initial}
    />
  )
}

export default function AgentProfilerDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  const initial =
    params.has('none') || params.has('empty')
      ? undefined
      : (params.get('conversation') ?? CONVERSATIONS[0].conversationId)

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-8">
        <h1 className="text-xl font-semibold tracking-tight">Antwortqualität · Laufzeit</h1>
        <Suspense>
          <ScopedAgentProfiler initial={initial} />
        </Suspense>
      </main>
    </I18nProvider>
  )
}
