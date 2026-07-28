'use client'

/**
 * Dev preview for a workflow's run history with LIVE job statuses. Renders the
 * REAL RunHistory with a fetch shim serving both of its sources — the BFF run
 * list (`/api/projects/…/runs`, submission outcomes) and the backend research
 * runs (`/api/v1/jobs/async/jobs`, live job state) — so every row variant is
 * reviewable without a backend: a run in flight (progress link), a finished one
 * (report link), a failed one (thinking link), and a skipped one (no job).
 * Not linked from anywhere and 404s outside development.
 */

import { notFound } from 'next/navigation'
import { RunHistory } from '@/features/workflows/components/run-history'

const RUNS = [
  {
    id: 'r1',
    jobId: 'job-running',
    trigger: 'manual',
    status: 'submitted',
    detail: null,
    triggeredBy: 'user_1',
    createdAt: '2026-07-16T08:20:00Z',
  },
  {
    id: 'r2',
    jobId: 'job-done',
    trigger: 'schedule',
    status: 'submitted',
    detail: null,
    triggeredBy: 'scheduler',
    createdAt: '2026-07-15T06:00:00Z',
  },
  {
    id: 'r3',
    jobId: 'job-failed',
    trigger: 'schedule',
    status: 'submitted',
    detail: null,
    triggeredBy: 'scheduler',
    createdAt: '2026-07-14T06:00:00Z',
  },
  {
    id: 'r4',
    jobId: null,
    trigger: 'schedule',
    status: 'skipped',
    detail: 'Active-job cap reached for this organization.',
    triggeredBy: 'scheduler',
    createdAt: '2026-07-13T06:00:00Z',
  },
]

const JOBS = [
  { job_id: 'job-running', status: 'running', created_at: '2026-07-16T08:20:00Z', conversation_id: null, project_collection: 'proj_1' },
  { job_id: 'job-done', status: 'completed', created_at: '2026-07-15T06:00:00Z', conversation_id: null, project_collection: 'proj_1' },
  { job_id: 'job-failed', status: 'failed', created_at: '2026-07-14T06:00:00Z', conversation_id: null, project_collection: 'proj_1' },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __runHistoryShim?: boolean }
  if (!w.__runHistoryShim) {
    w.__runHistoryShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/workflows/') && url.includes('/runs')) {
        return Response.json({ runs: RUNS })
      }
      if (url.includes('/jobs/async/jobs')) {
        return Response.json({ jobs: JOBS, total: JOBS.length })
      }
      return real(input, init)
    }
  }
}

export default function WorkflowRunHistoryDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8" data-testid="run-history-preview">
      <div>
        <h1 className="text-lg font-semibold">Workflows — run history with live job status</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Each run shows what the job is actually doing, and the link matches that
          state: follow a run in progress, open a finished run’s report, inspect a
          failed run’s thinking.
        </p>
      </div>
      <RunHistory projectId="p1" workflowId="w1" projectCollection="proj_1" />
    </main>
  )
}
