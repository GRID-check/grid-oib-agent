/**
 * The schedule fixtures both Zeitplan previews run on.
 *
 * One project's week as it actually looks once somebody has been using the
 * section for a month: a weekday-morning scan, a Monday research report, a
 * monthly certificate, one paused schedule and one that only runs by hand. The
 * two morning schedules deliberately COLLIDE at 06:00 — that is the thing the
 * timetable exists to make visible, and a fixture where nothing overlaps would
 * be evidence of the easy case only.
 *
 * Shared rather than copied into each page: two fixtures drifting apart is how
 * two screenshots of one surface stop being comparable.
 */

import type { Job } from '@/adapters/api/jobs-client'

const base = {
  projectId: 'p1',
  skillName: null,
  skillSnapshot: null,
  dataSources: null,
  scheduleTimezone: 'Europe/Vienna',
  lastRunAt: null,
  createdBy: 'user_1',
  createdByEmail: 'anna@example.com',
  createdAt: '2026-07-01T09:00:00Z',
  updatedAt: '2026-08-01T09:00:00Z',
} satisfies Omit<
  Job,
  'id' | 'name' | 'prompt' | 'output' | 'enabled' | 'scheduleCron' | 'nextRunAt'
>

export const SCHEDULE_SKILL = {
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

export const SCHEDULES: Job[] = [
  {
    ...base,
    id: 'j1',
    name: 'Täglicher Brandschutz-Scan',
    prompt:
      'Prüfe die aktuellen Projektunterlagen auf offene Brandschutzpunkte und nenne jede Abweichung mit der OIB-Fundstelle.',
    output: 'chat',
    enabled: true,
    scheduleCron: '0 6 * * *',
    nextRunAt: null,
  },
  {
    ...base,
    id: 'j2',
    name: 'Monatlicher Schallschutz-Nachweis',
    prompt: [
      'Fasse den Stand des Schallschutz-Nachweises für dieses Projekt zusammen.',
      '',
      'Gehe dabei Geschoss für Geschoss vor und nenne für jedes trennende Bauteil,',
      'welche Unterlage den Nachweis belegt — und wo noch keine vorliegt.',
    ].join('\n'),
    skillName: SCHEDULE_SKILL.name,
    skillSnapshot: SCHEDULE_SKILL,
    dataSources: ['ris'],
    output: 'deep-research',
    enabled: true,
    scheduleCron: '0 6 1 * *',
    nextRunAt: null,
  },
  {
    ...base,
    id: 'j3',
    // Fires at the same minute as j1 — the collision the grid is for.
    name: 'Einreichcheck Montagfrüh',
    prompt: 'Was fehlt noch für die Einreichung? Liste jeden offenen Punkt mit Zuständigem.',
    output: 'deep-research',
    enabled: true,
    scheduleCron: '0 6 * * 1',
    nextRunAt: null,
  },
  {
    ...base,
    id: 'j4',
    name: 'Nachmittags-Statusnotiz',
    prompt: 'Fasse zusammen, was sich heute in den Projektunterlagen geändert hat.',
    output: 'chat',
    enabled: true,
    scheduleCron: '30 16 * * 2,4',
    nextRunAt: null,
  },
  {
    ...base,
    id: 'j5',
    name: 'Bestandsplan-Abgleich (pausiert)',
    prompt: 'Gleiche den Bestandsplan mit dem eingereichten Einreichplan ab.',
    output: 'chat',
    enabled: false,
    scheduleCron: '0 9 * * 3',
    nextRunAt: null,
  },
  {
    ...base,
    id: 'j6',
    name: 'Normprüfung auf Zuruf',
    prompt: 'Prüfe die aktuelle Planung gegen die geltenden OIB-Richtlinien.',
    output: 'deep-research',
    enabled: true,
    scheduleCron: null,
    nextRunAt: null,
  },
]

/** The fetch shim both previews install: schedules, skills and data sources. */
export function installScheduleShim(flag: string): void {
  if (typeof window === 'undefined' || process.env.NODE_ENV !== 'development') return
  const w = window as unknown as Record<string, boolean | undefined>
  if (w[flag]) return
  w[flag] = true
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/skills/attachable')) {
      // The picker must be able to offer the attached skill, otherwise the
      // wizard detaches it on mount and the preview loses its skill block.
      return Response.json({ skills: [SCHEDULE_SKILL] })
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
      return Response.json({ jobs: SCHEDULES })
    }
    return real(input, init)
  }
}
