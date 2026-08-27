'use client'

/**
 * Sessions dev preview: renders the REAL SessionsPanel — the history sheet —
 * over the REAL app shell (`AppSidebar` rail + a chat-plane stand-in), so it
 * can be reviewed and screenshotted exactly as it rises in the product
 * (visual/registry.mjs → `sessions*`). Not linked anywhere and 404s outside
 * development.
 *
 * Why the real rail. The sheet dims the whole shell behind it, and whether
 * that scrim reads correctly is only visible over the product's own chrome.
 *
 * The rail is wrapped in `hidden md:contents` because the chat route (the only
 * host of this sheet) hides the mobile top bar and has no rail below `md` — its
 * navigation lives in the chat toolbar's hamburger. `contents` keeps the rail a
 * direct flex child of the shell row on desktop.
 *
 * Variants via `?variant=`:
 *   - default    — a long history. Deliberately spans several day-groups and
 *                  overflows the panel, because the things this list gets wrong
 *                  are only visible at length: day headings that scroll away, a
 *                  list that overflows its own footer.
 *   - `search`   — a live query: the trailing clear button, the "n of N" count,
 *                  and a filtered list.
 *   - `no-match` — the same query matching nothing: the search-specific empty
 *                  state, quoting the query, with the way back out.
 *   - `empty`    — a project with no chats at all: no search field, no
 *                  delete-all, one CTA rather than two.
 *   - `busy`     — a turn in flight. Every row is dimmed and unclickable, so the
 *                  panel says why instead of leaving the user to test rows.
 *   - `research` — the Deep Research section (open by default) plus the
 *                  per-row chips (FB-10). Runs come from a module-scope fetch
 *                  shim.
 *
 * The fetch shim is installed at MODULE SCOPE (browser + development only,
 * idempotent) so it is in place before any effect can fire — the panel fetches
 * its runs from an effect on open.
 */

import { useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
// Imported from the module, not the `@/components/shell` barrel: the barrel also
// re-exports `org-topbar`, which pulls in `i18n/server` (`server-only` +
// `next/headers`) and fails to compile into a client preview.
import { AppSidebar } from '@/components/shell/app-sidebar'
import { SessionsPanel } from '@/features/layout/components/SessionsPanel'
import { useLayoutStore } from '@/features/layout/store'
import { useChatStore } from '@/features/chat'

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000)

const SESSIONS = [
  { id: 's-1', title: 'Rettungswege Bürogebäude GK4 Wien', date: minutesAgo(4) },
  { id: 's-2', title: 'Fluchtweglänge im Erdgeschoss', date: minutesAgo(95) },
  { id: 's-3', title: 'Brandabschnitte Tiefgarage', date: minutesAgo(240), hasCompletedReport: true },
  { id: 's-4', title: 'Sicherheitstreppenhaus — Anforderungen GK5', date: daysAgo(1) },
  { id: 's-5', title: 'Barrierefreiheit Sanitärräume', date: daysAgo(1) },
  { id: 's-6', title: 'OIB-RL 6 Energieausweis Bestand', date: daysAgo(3), hasActiveDeepResearch: true },
  { id: 's-7', title: 'Schallschutz Trennwände Wohnbau', date: daysAgo(3) },
  { id: 's-8', title: 'Stellplatzverpflichtung Wien Bauordnung', date: daysAgo(6) },
  { id: 's-9', title: 'Belichtung Aufenthaltsräume', date: daysAgo(6) },
  { id: 's-10', title: 'Absturzsicherung Brüstungshöhen', date: daysAgo(11) },
  { id: 's-11', title: 'Aufzugsschacht Entrauchung', date: daysAgo(11), hasExpiredReport: true },
  { id: 's-12', title: 'Bauklasse und Gebäudehöhe Parzelle 1042', date: daysAgo(18) },
]

const PROJECTS = [
  { id: 'p-1', name: 'Wohnbau Seestadt Baufeld D12' },
  { id: 'p-2', name: 'Sanierung Amtshaus Favoriten' },
]

const RESEARCH_RUNS = {
  total: 3,
  jobs: [
    {
      job_id: 'job-a',
      status: 'running',
      created_at: minutesAgo(12).toISOString(),
      conversation_id: 's-6',
      project_collection: 'preview',
    },
    {
      job_id: 'job-b',
      status: 'completed',
      created_at: minutesAgo(240).toISOString(),
      conversation_id: 's-3',
      project_collection: 'preview',
    },
    {
      job_id: 'job-c',
      status: 'failed',
      created_at: daysAgo(11).toISOString(),
      conversation_id: null,
      project_collection: 'preview',
    },
  ],
}

// Module scope, browser + dev only, idempotent — see the header comment.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as Window & { __sessionsPreviewFetchShim?: boolean }
  if (!w.__sessionsPreviewFetchShim) {
    w.__sessionsPreviewFetchShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/jobs/async/jobs')) {
        return new Response(JSON.stringify(RESEARCH_RUNS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return real(input, init)
    }
  }
}

export default function SessionsPreviewPage() {
  const variant = useSearchParams()?.get('variant') ?? 'default'
  const setSessionsPanelOpen = useLayoutStore((s) => s.setSessionsPanelOpen)

  useEffect(() => {
    // The sheet mounts against the open state, so the preview opens it.
    setSessionsPanelOpen(true)
  }, [setSessionsPanelOpen])

  // `busy` reproduces a turn in flight by setting the one store field the panel
  // reads for it, rather than by faking the panel's own props.
  useEffect(() => {
    useChatStore.setState({ isStreaming: variant === 'busy' })
  }, [variant])

  // The search states are driven through the real field, so what is captured is
  // the component's own behaviour and not a prop that bypasses it.
  useEffect(() => {
    if (variant !== 'search' && variant !== 'no-match') return
    const input = document.querySelector<HTMLInputElement>('input[type="text"]')
    if (!input) return
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    setValue?.call(input, variant === 'search' ? 'brand' : 'zzzz')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, [variant])

  const sessions = variant === 'empty' ? [] : SESSIONS

  return (
    <div
      className="bg-background text-foreground flex h-dvh flex-col overflow-hidden md:flex-row"
      data-testid="sessions-preview"
    >
      {/* The real rail — the surface the panel overlays. `md:contents` so it
          stays a direct flex child on desktop; hidden below `md`, matching the
          chat route where the standalone mobile bar is suppressed. */}
      <div className="hidden md:contents">
        <AppSidebar
          projectId="p-1"
          projects={PROJECTS}
          user={{ name: 'Anna Berger', email: 'anna.berger@example.at' }}
          authRequired={false}
          // The state a signed-in member is actually in. Omitting this used to
          // default it to `false`, so the preview — whose entire job is to show
          // what the rail looks like — showed it without the Inbox entry.
          canAccessInbox
        />
      </div>

      {/* Chat-plane stand-in — the surface the sheet rises over. The sheet
          itself portals to <body>, so where it is rendered from matters only
          for props. */}
      <main className="relative min-w-0 flex-1 overflow-hidden">
        <p className="text-muted-foreground p-6 font-mono text-xs">
          /dev/sessions — chat plane stand-in (the history sheet rises above it)
        </p>

        <SessionsPanel
          sessions={sessions}
          selectedSessionId="s-2"
          onSelectSession={() => {}}
          onNewSession={() => {}}
          onDeleteSession={() => {}}
          onDeleteAllSessions={() => {}}
          onRenameSession={() => {}}
          showDeepResearchSection={variant === 'research'}
          projectId="p-1"
          projectCollection={variant === 'research' ? 'preview' : undefined}
        />
      </main>
    </div>
  )
}
