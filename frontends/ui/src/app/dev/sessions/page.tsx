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
 * The page renders a stand-in nav bar because DockedPanel docks BELOW the app
 * header (`top-[var(--header-height)]`). A preview without that chrome shows the
 * offset as an unexplained gap above the panel — a screenshot that invents a
 * layout bug. Keep any preview of a docked/overlaid surface host-accurate.
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
    <div className="min-h-dvh bg-background" data-testid="sessions-preview">
      {/* A stand-in for the app nav bar.
          DockedPanel is `fixed top-[var(--header-height)] … md:top-12`, i.e. it
          deliberately starts BELOW the header. Without a header in the preview
          that offset floats over an empty page and reads as a stray top margin
          on the panel — evidence that would send someone hunting a layout bug
          that does not exist in the product. The bar is inert; it exists only so
          the screenshot occupies the same space the real chrome does. */}
      <header
        className="bg-background sticky top-0 z-50 flex h-[var(--header-height)] items-center gap-2 border-b px-4 md:h-12"
        aria-hidden="true"
      >
        <span className="font-mono text-xs text-muted-foreground">
          /dev/sessions — nav bar stand-in (the panel docks beneath it)
        </span>
      </header>

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
  )
}
