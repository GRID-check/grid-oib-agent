// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle } from 'lucide-react'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { listResearchRuns, type ResearchRun } from '@/adapters/api/research-runs-client'

const DEFAULT_LIMIT = 50

interface ResearchRunsListProps {
  projectId: string
  projectCollection: string
}

const STATUS_BADGE_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  running: 'warning',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'secondary',
}

const shortJobId = (jobId: string): string => jobId.slice(0, 8)

const formatRelativeTime = (isoDate: string): string => {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return isoDate

  const diffMs = date.getTime() - Date.now()
  const diffSeconds = Math.round(diffMs / 1000)
  const absSeconds = Math.abs(diffSeconds)

  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

  const thresholds: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [2592000, 'day'],
    [31536000, 'month'],
    [Infinity, 'year'],
  ]

  const divisors: Record<Intl.RelativeTimeFormatUnit, number> = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
    month: 2592000,
    year: 31536000,
    quarter: 7776000,
  }

  for (const [limit, unit] of thresholds) {
    if (absSeconds < limit) {
      const divisor = divisors[unit]
      const value = Math.round(diffSeconds / divisor)
      return rtf.format(value, unit)
    }
  }

  return rtf.format(Math.round(diffSeconds / divisors.year), 'year')
}

export function ResearchRunsList({ projectId, projectCollection }: ResearchRunsListProps): JSX.Element {
  const [jobs, setJobs] = useState<ResearchRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    setJobs(null)
    setError(null)

    listResearchRuns({ projectCollection, limit: DEFAULT_LIMIT })
      .then((response) => {
        if (cancelled) return
        setJobs(response.jobs)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load research runs')
      })

    return () => {
      cancelled = true
    }
  }, [projectCollection])

  if (error) {
    return (
      <Alert variant="destructive" className="mt-6">
        <AlertCircle />
        <AlertTitle>Couldn&apos;t load research runs</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  if (jobs === null) {
    return (
      <div className="mt-6 flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-16 w-full" />
        ))}
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <p className="mt-6 text-sm text-muted-foreground">
        No research runs yet. Start one by asking Grid a deep question in Chat.
      </p>
    )
  }

  return (
    <div className="mt-6 flex flex-col gap-3">
      {jobs.map((job) => (
        <div
          key={job.job_id}
          className="flex items-center justify-between gap-4 rounded-md border px-4 py-3"
        >
          <div className="flex items-center gap-3">
            <Badge variant={STATUS_BADGE_VARIANT[job.status] ?? 'secondary'}>{job.status}</Badge>
            <span className="font-mono text-sm text-muted-foreground">{shortJobId(job.job_id)}</span>
            <span className="text-sm text-muted-foreground">{formatRelativeTime(job.created_at)}</span>
          </div>
          {job.status === 'completed' && (
            <Link
              href={`/projects/${projectId}/chat?job=${job.job_id}`}
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              View report
            </Link>
          )}
        </div>
      ))}
    </div>
  )
}
