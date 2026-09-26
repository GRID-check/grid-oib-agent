'use client'

/**
 * Dev preview for a job's run history — the surface that has to answer, per
 * run, "where did this one end up?". Renders the REAL JobRunHistory with fetch
 * shims for both halves of the join: the recorded runs
 * (`/api/projects/…/jobs/…/runs`) and the live backend job states
 * (`/api/v1/jobs/async/jobs`) they are matched against.
 *
 * The fixture is one row per outcome, so every link target and badge is on the
 * same screen: a finished chat run that minted a CONVERSATION, a finished
 * deep-research run that produced a report, one still running, one that failed,
 * and one that never became a job at all (skipped, no job id — so no link).
 * Not linked from anywhere and 404s outside development (see ../layout.tsx).
 */

import type { JSX } from 'react'
import { I18nProvider } from '@/i18n'
import { JobRunHistory } from '@/features/jobs/components/job-run-history'

const NOW = Date.now()
const at = (offsetHours: number): string => new Date(NOW + offsetHours * 3600_000).toISOString()

const SKILL_SNAPSHOT = {
  name: 'oib-brandschutz-check',
  description: 'Prüft das Projekt gegen die OIB-Richtlinie 2 (Brandschutz).',
  body: 'Handle als Brandschutz-Prüfer.',
  metadata: {},
  origin: 'platform' as const,
}

const RUNS = [
  {
    id: 'r1',
    scheduleId: 'j1',
    jobId: 'job-running',
    trigger: 'manual' as const,
    status: 'submitted' as const,
    detail: null,
    conversationId: null,
    skillSnapshot: SKILL_SNAPSHOT,
    triggeredBy: 'user_1',
    createdAt: at(-0.3),
  },
  {
    id: 'r2',
    scheduleId: 'j1',
    jobId: 'job-chat',
    trigger: 'schedule' as const,
    status: 'submitted' as const,
    detail: null,
    // A chat-output run: it landed in a conversation you can open and continue.
    conversationId: 'conv-8f21',
    skillSnapshot: SKILL_SNAPSHOT,
    triggeredBy: 'scheduler',
    createdAt: at(-24 * 7),
  },
  {
    id: 'r3',
    scheduleId: 'j1',
    jobId: 'job-report',
    trigger: 'schedule' as const,
    status: 'submitted' as const,
    detail: null,
    conversationId: null,
    skillSnapshot: SKILL_SNAPSHOT,
    triggeredBy: 'scheduler',
    createdAt: at(-24 * 14),
  },
  {
    id: 'r4',
    scheduleId: 'j1',
    jobId: 'job-failed',
    trigger: 'schedule' as const,
    status: 'submitted' as const,
    detail: null,
    conversationId: null,
    skillSnapshot: SKILL_SNAPSHOT,
    triggeredBy: 'scheduler',
    createdAt: at(-24 * 21),
  },
  {
    id: 'r5',
    scheduleId: 'j1',
    jobId: null,
    trigger: 'schedule' as const,
    status: 'skipped' as const,
    detail: 'Die Organisation hatte bereits die maximale Anzahl aktiver Jobs.',
    conversationId: null,
    skillSnapshot: SKILL_SNAPSHOT,
    triggeredBy: 'scheduler',
    createdAt: at(-24 * 28),
  },
]

const BACKEND_JOBS = [
  { job_id: 'job-running', status: 'running', created_at: at(-0.3), conversation_id: null, project_collection: 'proj_1' },
  {
    job_id: 'job-chat',
    status: 'completed',
    created_at: at(-24 * 7),
    conversation_id: 'conv-8f21',
    project_collection: 'proj_1',
  },
  { job_id: 'job-report', status: 'completed', created_at: at(-24 * 14), conversation_id: null, project_collection: 'proj_1' },
  { job_id: 'job-failed', status: 'failed', created_at: at(-24 * 21), conversation_id: null, project_collection: 'proj_1' },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __jobRunHistoryShim?: boolean }
  if (!w.__jobRunHistoryShim) {
    w.__jobRunHistoryShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/jobs/async/jobs')) {
        return Response.json({ jobs: BACKEND_JOBS, total: BACKEND_JOBS.length })
      }
      if (url.includes('/runs')) {
        return Response.json({ runs: RUNS })
      }
      return real(input, init)
    }
  }
}

export default function JobRunHistoryDevPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="job-run-history-preview"
        // The history renders inside a job card's collapsible, so it is shown
        // here at that width and on that surface rather than full-bleed. The
        // page carries `bg-background text-foreground` and the card carries
        // `text-card-foreground` because the real project layout and the real
        // Card do — without them the rows inherit the UA default black and the
        // preview invents a dark-mode contrast bug the product does not have.
        className="min-h-dvh bg-background p-8 text-foreground"
      >
        <div className="mx-auto w-full max-w-[720px] rounded-xl border border-border bg-card p-4 text-card-foreground sm:p-5">
          <h2 className="mb-1 text-sm font-semibold text-foreground">Ausführungsverlauf</h2>
          <div className="border-t border-border pt-1">
            <JobRunHistory projectId="p1" projectCollection="proj_1" jobId="j1" />
          </div>
        </div>
      </main>
    </I18nProvider>
  )
}
