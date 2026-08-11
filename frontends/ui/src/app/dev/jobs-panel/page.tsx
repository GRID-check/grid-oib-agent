'use client'

/**
 * Dev preview for the Jobs tab, list mode. Renders the REAL JobsPanel with a
 * fetch shim serving the project's jobs (`/api/projects/…/jobs`), so every card
 * variant is reviewable without a backend: a job with no skill and one with a
 * skill attached, both output kinds (chat / Bericht), a disabled job, and one
 * with no cron that only ever runs on demand.
 *
 * Timestamps are relative to load so "next run" is genuinely in the future —
 * a fixed date would render the next run in the past, which is a fixture bug
 * masquerading as a UI bug.
 * Not linked from anywhere and 404s outside development (see ../layout.tsx).
 */

import { I18nProvider } from '@/i18n'
import { JobsPanel } from '@/features/jobs/components/jobs-panel'

const NOW = Date.now()
const at = (offsetHours: number): string => new Date(NOW + offsetHours * 3600_000).toISOString()

const REPORT_SKILL = {
  name: 'schallschutz-bericht',
  description: 'Verfasst den Schallschutz-Nachweis nach OIB-Richtlinie 5.',
  body: 'Erstelle einen strukturierten Bericht zum Schallschutz nach OIB-Richtlinie 5.',
  metadata: { 'grid-agents': 'deep_researcher' },
  origin: 'org' as const,
}

const FIRE_SKILL = {
  name: 'oib-brandschutz-check',
  description: 'Prüft das Projekt gegen die OIB-Richtlinie 2 (Brandschutz).',
  body: 'Handle als Brandschutz-Prüfer und nenne jede Abweichung mit ihrer Klausel.',
  metadata: { 'grid-agents': 'shallow_researcher' },
  origin: 'platform' as const,
}

const base = {
  projectId: 'p1',
  dataSources: null,
  scheduleTimezone: 'Europe/Vienna',
  createdBy: 'user_1',
  createdByEmail: 'anna@example.com',
  createdAt: at(-24 * 40),
  updatedAt: at(-24 * 3),
}

const JOBS = [
  {
    ...base,
    id: 'j1',
    name: 'Wöchentlicher Brandschutz-Check',
    prompt:
      'Prüfe die aktuellen Projektunterlagen auf offene Brandschutzpunkte und nenne jede Abweichung mit der zugehörigen OIB-Klausel.',
    skillName: null,
    skillSnapshot: null,
    output: 'chat' as const,
    enabled: true,
    scheduleCron: '0 6 * * 1',
    nextRunAt: at(52),
    lastRunAt: at(-116),
  },
  {
    ...base,
    id: 'j2',
    name: 'Monatlicher Schallschutz-Nachweis',
    prompt:
      'Fasse den Stand des Schallschutz-Nachweises zusammen: welche Bauteile sind belegt, welche fehlen, und welche Annahmen sind noch offen?',
    skillName: REPORT_SKILL.name,
    skillSnapshot: REPORT_SKILL,
    output: 'deep-research' as const,
    enabled: true,
    scheduleCron: '0 6 1 * *',
    nextRunAt: at(24 * 11),
    lastRunAt: at(-24 * 19),
  },
  {
    ...base,
    id: 'j3',
    name: 'Täglicher Einreichplan-Abgleich',
    prompt:
      'Vergleiche die neuesten Einreichpläne mit dem Bescheid und melde jede Abweichung, die eine Auflage berührt.',
    skillName: FIRE_SKILL.name,
    skillSnapshot: FIRE_SKILL,
    output: 'chat' as const,
    enabled: false,
    scheduleCron: '0 6 * * *',
    nextRunAt: null,
    lastRunAt: at(-24 * 6),
  },
  {
    ...base,
    id: 'j4',
    name: 'Bescheid-Auflagen auf Zuruf',
    prompt:
      'Liste alle Auflagen des Baubescheids auf, die noch nicht durch ein Dokument im Projekt belegt sind.',
    skillName: null,
    skillSnapshot: null,
    output: 'deep-research' as const,
    enabled: true,
    scheduleCron: null,
    nextRunAt: null,
    lastRunAt: null,
  },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __jobsPanelShim?: boolean }
  if (!w.__jobsPanelShim) {
    w.__jobsPanelShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/jobs') && !url.includes('/runs') && !url.includes('/async/')) {
        return Response.json({ jobs: JOBS })
      }
      return real(input, init)
    }
  }
}

export default function JobsPanelDevPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      {/* The project layout the Jobs tab really renders inside, minus its fixed
          height: that layout owns the theme colours and clips the panel to the
          viewport, and a screenshot of a clipped scroller would only ever show
          its first screen. */}
      <main
        data-testid="jobs-panel-preview"
        className="flex min-h-dvh flex-col bg-background text-foreground"
      >
        <JobsPanel projectId="p1" projectCollection="proj_1" canManage />
      </main>
    </I18nProvider>
  )
}
