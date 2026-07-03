// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronsUpDown, FolderKanban, Plus } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface ProjectSwitcherProject {
  id: string
  name: string
}

export interface ProjectSwitcherProps {
  projects: ProjectSwitcherProject[]
  activeProjectId?: string
  collapsed?: boolean
}

export function ProjectSwitcher({ projects, activeProjectId, collapsed }: ProjectSwitcherProps) {
  const router = useRouter()
  const active = projects.find((p) => p.id === activeProjectId)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-sm font-medium',
          'transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
          collapsed && 'justify-center px-0',
        )}
        aria-label={active ? `Switch project (current: ${active.name})` : 'Select project'}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <FolderKanban className="size-3.5" />
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate">{active?.name ?? 'Select project'}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="w-60">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Projects</DropdownMenuLabel>
        {projects.map((project) => (
          <DropdownMenuItem
            key={project.id}
            onSelect={() => router.push(`/projects/${project.id}`)}
            className="gap-2"
          >
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {project.id === activeProjectId && <Check className="size-4 shrink-0" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push('/projects')} className="gap-2">
          <FolderKanban className="size-4 text-muted-foreground" />
          All projects
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push('/projects?new=1')} className="gap-2">
          <Plus className="size-4 text-muted-foreground" />
          New project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
