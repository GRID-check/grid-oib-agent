// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link'
import type { ProjectOverviewData } from '../types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatFileSize } from '@/lib/utils/format-file-size'

interface ProjectOverviewProps {
  data: ProjectOverviewData
}

function statusClasses(status: string | null): string {
  if (status === 'uploaded' || status === 'ready') {
    return 'bg-[var(--background-color-feedback-success-subtle)] text-[var(--text-color-feedback-success)]'
  }
  if (status === 'pending' || status === 'ingesting') {
    return 'bg-[var(--background-color-feedback-info-subtle)] text-[var(--text-color-feedback-info)]'
  }
  if (status === 'failed') {
    return 'bg-[var(--background-color-feedback-danger-subtle)] text-[var(--text-color-feedback-danger)]'
  }
  return 'bg-muted text-muted-foreground'
}

export function ProjectOverview({ data }: ProjectOverviewProps) {
  const hasProfile =
    data.profileDisplay && (data.profileDisplay.title || data.profileDisplay.summary)
  const hasDocuments = data.documentCount > 0

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-8 md:px-8">
      {/* Project Identity */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{data.name}</h1>
        {data.profileDisplay?.summary && (
          <p className="mt-2 text-sm text-muted-foreground">{data.profileDisplay.summary}</p>
        )}
      </div>

      {/* Project Brief — the context the agent works from, owned by the architect */}
      {hasProfile && data.profileDisplay?.keyFacts && data.profileDisplay.keyFacts.length > 0 && (
        <div className="rounded-lg border bg-card p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Project Brief
            </h2>
            <Link
              href={`/projects/${data.id}/intake`}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Edit brief
            </Link>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
            {data.profileDisplay.keyFacts.map((fact, i) => (
              <div key={i}>
                <dt className="text-xs text-muted-foreground">{fact.label}</dt>
                <dd className="mt-0.5 text-sm font-medium">{fact.value}</dd>
              </div>
            ))}
          </dl>
          {data.profileDisplay.missingInfo && data.profileDisplay.missingInfo.length > 0 && (
            <div className="mt-5 border-t pt-4">
              <p className="text-xs text-muted-foreground">
                Grid still doesn&apos;t know:{' '}
                {data.profileDisplay.missingInfo.join(' · ')}
                {' — '}
                <Link
                  href={`/projects/${data.id}/intake`}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  complete the brief
                </Link>
              </p>
            </div>
          )}
        </div>
      )}

      {/* Setup Prompt */}
      {!hasProfile && (
        <div className="rounded-lg border bg-muted/40 p-6">
          <p className="text-sm text-muted-foreground">
            Tell Grid about this project to get personalized assistance. Project context helps the
            AI understand your goals, requirements, and constraints.
          </p>
          <Button asChild className="mt-3">
            <Link href={`/projects/${data.id}/intake`}>Set up project context</Link>
          </Button>
        </div>
      )}

      {/* Quick Actions */}
      <div className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href={`/projects/${data.id}/chat`}>Ask Grid</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`/projects/${data.id}/files`}>Upload Files</Link>
        </Button>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-5">
          <p className="text-2xl font-semibold tracking-tight">{data.documentCount}</p>
          <p className="mt-1 text-sm text-muted-foreground">Files</p>
        </div>
        <div className="rounded-lg border bg-card p-5">
          <p className="text-2xl font-semibold tracking-tight">
            {formatFileSize(data.totalFileSize)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Total size</p>
        </div>
        <div className="rounded-lg border bg-card p-5">
          <p className="truncate text-2xl font-semibold tracking-tight">{data.collectionName}</p>
          <p className="mt-1 text-sm text-muted-foreground">Knowledge base</p>
        </div>
      </div>

      {/* Recent Documents */}
      {hasDocuments && (
        <div>
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Recent Files
            </h2>
            <Link
              href={`/projects/${data.id}/files`}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              View all
            </Link>
          </div>
          <div className="mt-3 divide-y rounded-lg border bg-card">
            {data.recentDocuments.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="truncate text-sm">{doc.filename}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatFileSize(doc.fileSize)}
                  </span>
                </div>
                <Badge className={cn('border-transparent', statusClasses(doc.status))}>
                  {doc.status ?? 'unknown'}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {!hasDocuments && (
        <div className="rounded-lg border border-dashed bg-muted/40 p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No files yet. Upload your first document to get started.
          </p>
          <Button asChild className="mt-3">
            <Link href={`/projects/${data.id}/files`}>Upload Files</Link>
          </Button>
        </div>
      )}
    </div>
  )
}
