'use client'

/**
 * Sessions dev preview: renders the REAL SessionsPanel with fixture sessions,
 * so the history list can be reviewed and screenshotted (visual/registry.mjs →
 * `sessions`). Not linked anywhere and 404s outside development.
 *
 * The fixture deliberately spans several day-groups and overflows the panel
 * height — the two things the list gets wrong are only visible at length:
 * the group headers scrolling away, and the old per-row entrance stagger
 * leaving the lower rows offset and invisible while they waited their turn.
 *
 * `?variant=` selects the captured scenario:
 *   - (none)  → a full history: today / yesterday / older, one row selected.
 *   - empty   → no sessions at all (first run) — the empty state.
 *   - search  → a query that matches nothing, i.e. the no-results state.
 */

import { useEffect } from 'react'
import { notFound } from 'next/navigation'
import { SessionsPanel } from '@/features/layout/components/SessionsPanel'
import { useLayoutStore } from '@/features/layout/store'

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

export default function SessionsPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  const setSessionsPanelOpen = useLayoutStore((s) => s.setSessionsPanelOpen)
  useEffect(() => {
    // The panel renders its list against the open state (it is force-mounted),
    // so the preview has to open it explicitly.
    setSessionsPanelOpen(true)
  }, [setSessionsPanelOpen])

  return (
    <main className="min-h-dvh bg-background px-4 py-10" data-testid="sessions-preview">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <h1 className="font-mono text-xs text-muted-foreground">
          /dev/sessions — session history panel
        </h1>
        {/* Constrained to a realistic panel height so the list scrolls: the
            sticky day headers and the trailing-margin fix only show at length. */}
        <div className="h-[720px] w-[340px] overflow-hidden rounded-xl border">
          <SessionsPanel
            sessions={SESSIONS}
            selectedSessionId="s-2"
            onSelectSession={() => {}}
            onNewSession={() => {}}
            onDeleteSession={() => {}}
            onDeleteAllSessions={() => {}}
            onRenameSession={() => {}}
          />
        </div>
      </div>
    </main>
  )
}
