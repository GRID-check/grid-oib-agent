'use client'

/**
 * Dev preview for the Agent Skills tab. Renders the REAL SkillsPanel (toolbox
 * + schedule list + run history) with fetch shims serving every endpoint the
 * surface reads: the merged toolbox (`/api/skills`), the project's schedules
 * (`/api/projects/…/skill-schedules`), a schedule's run history
 * (`…/runs`), the backend job list (`/api/v1/jobs/async/jobs`, live job
 * state) and the data sources (`/api/v1/data_sources`) — so all row variants
 * are reviewable without a backend: builtin/org/cloned skills, a scheduled +
 * a manual-only schedule, a run in flight and a finished one.
 * Not linked from anywhere and 404s outside development.
 */

import { notFound } from 'next/navigation'
import { SkillsPanel } from '@/features/skills/components/skills-panel'

const SKILLS = [
  {
    id: null,
    name: 'oib-fire-check',
    description: 'Checks a project against the OIB fire-safety guideline (OIB-Richtlinie 2).',
    body: 'Act as a fire-safety reviewer.\n\n1. Read the project brief and identify every fire-safety relevant building part.\n2. Verify each against OIB-Richtlinie 2 (brandschutztechnische Anforderungen).\n3. List deviations with the exact clause number and a suggested fix.',
    metadata: { 'grid-execution': 'chat' },
    origin: 'platform',
    enabled: true,
    clonedFrom: null,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: 'skill-1',
    name: 'acoustic-report',
    description: 'Drafts the acoustic compliance report (OIB-Richtlinie 5).',
    body: 'Draft a report on sound insulation per OIB-Richtlinie 5.\n\nUse the project documents as the source of truth for the building’s construction.',
    metadata: { 'grid-execution': 'deep-research', 'grid-schedulable': 'false' },
    origin: 'org',
    enabled: true,
    clonedFrom: null,
    createdAt: '2026-07-10T09:00:00Z',
    updatedAt: '2026-07-16T09:00:00Z',
  },
  {
    id: 'skill-2',
    name: 'oib-fire-check-adapt',
    description: 'Adapted fire check that also verifies escape routes against OIB 2.3.',
    body: 'Like the built-in fire check, plus:\n\n4. Verify every escape route’s width and length against OIB-Richtlinie 2.3.',
    metadata: { 'grid-execution': 'chat' },
    origin: 'platform-clone',
    enabled: false,
    clonedFrom: 'oib-fire-check',
    createdAt: '2026-07-12T10:00:00Z',
    updatedAt: '2026-07-12T10:00:00Z',
  },
]

const SCHEDULES = [
  {
    id: 's1',
    projectId: 'p1',
    name: 'Weekly OIB fire-safety scan',
    skillName: 'oib-fire-check',
    skillSnapshot: {
      name: 'oib-fire-check',
      description: 'Checks a project against the OIB fire-safety guideline (OIB-Richtlinie 2).',
      body: 'Act as a fire-safety reviewer.',
      metadata: { 'grid-execution': 'chat' },
      origin: 'platform',
    },
    execution: 'chat',
    dataSources: null,
    enabled: true,
    scheduleCron: '0 6 * * 1',
    scheduleTimezone: 'Europe/Vienna',
    nextRunAt: '2026-07-20T06:00:00Z',
    lastRunAt: '2026-07-13T06:00:00Z',
    createdBy: 'user_1',
    createdByEmail: 'anna@example.com',
    createdAt: '2026-07-01T09:00:00Z',
    updatedAt: '2026-07-16T09:00:00Z',
  },
  {
    id: 's2',
    projectId: 'p1',
    name: 'Acoustic pre-check on demand',
    skillName: 'acoustic-report',
    skillSnapshot: {
      name: 'acoustic-report',
      description: 'Drafts the acoustic compliance report (OIB-Richtlinie 5).',
      body: 'Draft a report on sound insulation per OIB-Richtlinie 5.',
      metadata: { 'grid-execution': 'deep-research', 'grid-schedulable': 'false' },
      origin: 'org',
    },
    execution: 'deep-research',
    dataSources: ['ris', 'web_search'],
    enabled: true,
    scheduleCron: null,
    scheduleTimezone: 'Europe/Vienna',
    nextRunAt: null,
    lastRunAt: null,
    createdBy: 'user_1',
    createdByEmail: 'anna@example.com',
    createdAt: '2026-07-14T09:00:00Z',
    updatedAt: '2026-07-14T09:00:00Z',
  },
]

const RUNS = [
  {
    id: 'r1',
    scheduleId: 's1',
    jobId: 'job-running',
    trigger: 'schedule',
    status: 'submitted',
    detail: null,
    skillSnapshot: SCHEDULES[0].skillSnapshot,
    triggeredBy: 'scheduler',
    createdAt: '2026-07-13T06:00:00Z',
  },
  {
    id: 'r2',
    scheduleId: 's1',
    jobId: 'job-done',
    trigger: 'manual',
    status: 'submitted',
    detail: null,
    skillSnapshot: SCHEDULES[0].skillSnapshot,
    triggeredBy: 'user_1',
    createdAt: '2026-07-06T06:00:00Z',
  },
  {
    id: 'r3',
    scheduleId: 's1',
    jobId: null,
    trigger: 'schedule',
    status: 'skipped',
    detail: 'Active-job cap reached for this organization.',
    skillSnapshot: SCHEDULES[0].skillSnapshot,
    triggeredBy: 'scheduler',
    createdAt: '2026-06-29T06:00:00Z',
  },
]

const JOBS = [
  { job_id: 'job-running', status: 'running', created_at: '2026-07-13T06:00:00Z', conversation_id: null, project_collection: 'proj_1' },
  { job_id: 'job-done', status: 'completed', created_at: '2026-07-06T06:00:00Z', conversation_id: null, project_collection: 'proj_1' },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __skillsPanelShim?: boolean }
  if (!w.__skillsPanelShim) {
    w.__skillsPanelShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/skills') {
        return Response.json({ skills: SKILLS })
      }
      if (url.includes('/skill-schedules')) {
        if (url.includes('/runs')) {
          return Response.json({ runs: RUNS })
        }
        return Response.json({ schedules: SCHEDULES })
      }
      if (url.includes('/jobs/async/jobs')) {
        return Response.json({ jobs: JOBS, total: JOBS.length })
      }
      if (url.includes('/data_sources')) {
        return Response.json({
          data_sources: [
            { id: 'web_search', name: 'Web search', description: 'Search the web' },
            { id: 'ris', name: 'RIS legal texts', description: 'Current Austrian law' },
          ],
          knowledge_layer: true,
          vlm_available: false,
        })
      }
      return real(input, init)
    }
  }
}

export default function SkillsDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex flex-col gap-6 p-8" data-testid="skills-panel-preview">
      <SkillsPanel
        projectId="p1"
        projectCollection="proj_1"
        canManageOrgSkills
        canManageProjectSkills
      />
    </main>
  )
}
