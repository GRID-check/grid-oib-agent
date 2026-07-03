// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Folder, LayoutDashboard, FileText, MessageSquare, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import type { Project } from '@/lib/db/schema'

interface ProjectCardProps {
  project: Project
}

export function ProjectCard({ project }: ProjectCardProps): JSX.Element {
  const createdAt = new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(project.createdAt)

  return (
    <Card className="gap-5 p-5 transition-colors hover:bg-accent/30">
      <div className="flex items-start justify-between gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-muted text-primary">
          <Folder className="h-5 w-5" />
        </div>
        <Badge variant="outline" className="uppercase tracking-wider text-muted-foreground">
          Project
        </Badge>
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold tracking-tight">{project.name}</h3>
        <p className="truncate font-mono text-xs text-muted-foreground">{project.collectionName}</p>
      </div>

      <div className="flex flex-col gap-4 border-t pt-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">created</span>
          <span className="text-sm">{createdAt}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <a href={`/projects/${project.id}`}>
              <LayoutDashboard className="h-4 w-4" />
              Open overview
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={`/projects/${project.id}/files`}>
              <FileText className="h-4 w-4" />
              Files
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={`/projects/${project.id}/chat`}>
              <MessageSquare className="h-4 w-4" />
              Ask Grid
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={`/projects/${project.id}/members`}>
              <Users className="h-4 w-4" />
              Members
            </a>
          </Button>
        </div>
      </div>
    </Card>
  )
}
