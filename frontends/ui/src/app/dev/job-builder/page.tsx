'use client'

/**
 * Dev preview for the definition builder, EDITING a populated schedule.
 *
 * It renders the REAL Aufgaben panel and drives the path a user takes: open the
 * fixture's template row, then press "Bearbeiten" in the drawer. The builder is
 * re-homed inside that tab and has no page chrome of its own, so a bare
 * JobBuilder would be a screenshot of a surface no user ever sees.
 *
 * Fetch shims cover everything the surface reads: the project's tasks and jobs,
 * the skills the chosen output kind may attach (`/api/skills/attachable?output=…`)
 * and the data sources (`/api/v1/data_sources`).
 *
 * The fixture is deliberately the fullest state of the form — a multi-line
 * prompt, an attached skill, `deep-research` output and a monthly cron —
 * because the thing worth looking at is the right-hand "Was der Agent erhält"
 * pane: it must show the composed fire prompt (the job's prompt, then the skill
 * block), which only has anything to show when a prompt AND a skill are there.
 * Not linked from anywhere and 404s outside development (see ../layout.tsx).
 */

import { useEffect } from 'react'
import { I18nProvider } from '@/i18n'
import { TasksPanel } from '@/features/tasks/components/tasks-panel'

const SKILL = {
  name: 'schallschutz-bericht',
  description: 'Verfasst den Schallschutz-Nachweis nach OIB-Richtlinie 5.',
  body: [
    'Handle als Bauphysiker und erstelle den Schallschutz-Nachweis nach OIB-Richtlinie 5.',
    '',
    '1. Ermittle aus den Projektunterlagen jedes trennende Bauteil und seine Aufbauten.',
    '2. Vergleiche die erreichten Werte mit den Anforderungen der OIB-Richtlinie 5.',
    '3. Nenne jede Unterschreitung mit Bauteil, Sollwert, Istwert und Fundstelle.',
  ].join('\n'),
  metadata: { 'grid-agents': 'deep_researcher' },
  origin: 'org' as const,
}

const JOB = {
  id: 'j2',
  projectId: 'p1',
  name: 'Monatlicher Schallschutz-Nachweis',
  prompt: [
    'Fasse den Stand des Schallschutz-Nachweises für dieses Projekt zusammen.',
    '',
    'Gehe dabei Geschoss für Geschoss vor und nenne für jedes trennende Bauteil,',
    'welche Unterlage den Nachweis belegt — und wo noch keine vorliegt.',
  ].join('\n'),
  skillName: SKILL.name,
  skillSnapshot: SKILL,
  output: 'deep-research' as const,
  dataSources: ['ris'],
  enabled: true,
  scheduleCron: '0 6 1 * *',
  scheduleTimezone: 'Europe/Vienna',
  nextRunAt: null,
  lastRunAt: null,
  createdBy: 'user_1',
  createdByEmail: 'anna@example.com',
  createdAt: '2026-07-01T09:00:00Z',
  updatedAt: '2026-08-01T09:00:00Z',
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __jobBuilderShim?: boolean }
  if (!w.__jobBuilderShim) {
    w.__jobBuilderShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/skills/attachable')) {
        // The picker must be able to offer the attached skill, otherwise the
        // builder detaches it on mount and the preview loses its skill block.
        return Response.json({ skills: [SKILL] })
      }
      if (url.includes('/data_sources')) {
        return Response.json({
          data_sources: [
            { id: 'web_search', name: 'Websuche', description: 'Aktuelle Treffer aus dem Web' },
            { id: 'ris', name: 'RIS-Rechtstexte', description: 'Geltendes österreichisches Recht' },
          ],
          knowledge_layer: true,
          vlm_available: false,
        })
      }
      if (url.includes('/tasks')) return Response.json({ tasks: [] })
      if (url.includes('/jobs') && !url.includes('/runs') && !url.includes('/async/')) {
        return Response.json({ jobs: [JOB] })
      }
      return real(input, init)
    }
  }
}

export default function JobBuilderDevPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      {/* `min-h-dvh`, not `h-dvh`: the real pane scrolls internally, and a
          screenshot of an internal scroller can only ever show its first
          screen. Letting the page grow keeps the real shell — panel over body —
          while putting the whole form in one shot. */}
      <main
        data-testid="job-builder-preview"
        className="flex min-h-dvh flex-col bg-background text-foreground"
      >
        <EditingPanel />
      </main>
    </I18nProvider>
  )
}

/**
 * Drives the two real clicks, one per frame until each lands: the template row
 * opens the drawer, the drawer's edit button opens the builder. Both elements
 * arrive after a fetch resolves, and the panel replaces itself at each step, so
 * the loop looks for the NEXT control each frame instead of holding a node.
 */
function EditingPanel(): JSX.Element {
  useEffect(() => {
    let stopped = false
    let openedDrawer = false
    const tick = (): void => {
      if (stopped) return
      const edit = document.querySelector<HTMLButtonElement>('[data-testid="task-detail-edit"]')
      if (edit) {
        edit.click()
        return
      }
      if (!openedDrawer) {
        const row = document.querySelector<HTMLButtonElement>('[data-testid="template-title"]')
        if (row) {
          row.click()
          openedDrawer = true
        }
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return () => {
      stopped = true
    }
  }, [])

  return <TasksPanel projectId="p1" projectCollection="proj_1" canManageJobs canChatInProject />
}
