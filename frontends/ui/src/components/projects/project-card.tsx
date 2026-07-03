// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link'
import { FileText, Folder } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import type { Project } from '@/lib/db/schema'

interface ProjectCardProps {
  project: Project
  /** Number of documents ingested into the project corpus. */
  docCount?: number
}

const formatDate = (date: Date) =>
  new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(date)

export function ProjectCard({ project, docCount = 0 }: ProjectCardProps): JSX.Element {
  const summary =
    project.profileDisplay?.summary?.trim() ||
    'OIB/RIS building-compliance workspace. Add documents and a brief to ground Grid.'

  const activityDate = project.profileUpdatedAt ?? project.createdAt
  const activityLabel = project.profileUpdatedAt
    ? `Updated ${formatDate(activityDate)}`
    : `Created ${formatDate(activityDate)}`

  const isActive = docCount > 0
  const docLabel = `${docCount} ${docCount === 1 ? 'document' : 'documents'}`

  return (
    <Link
      href={`/projects/${project.id}`}
      className="group rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label={`Open ${project.name}`}
    >
      <Card className="h-full gap-4 p-5 transition-colors group-hover:border-primary/30 group-hover:bg-accent/30">
        <div className="flex items-start justify-between gap-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-primary">
            <Folder className="size-4" />
          </div>
          <Badge variant={isActive ? 'success' : 'secondary'}>
            {isActive ? 'Active' : 'Draft'}
          </Badge>
        </div>

        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold tracking-tight">{project.name}</h3>
          <p className="line-clamp-2 text-sm text-muted-foreground">{summary}</p>
        </div>

        <div className="mt-auto flex items-center justify-between gap-4 border-t pt-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <FileText className="size-3.5" />
            {docLabel}
          </span>
          <span className="tabular-nums">{activityLabel}</span>
        </div>
      </Card>
    </Link>
  )
}
