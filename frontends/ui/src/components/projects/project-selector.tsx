// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Folder } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface Project {
  id: string
  name: string
  collectionName: string
}

interface PreferencesResponse {
  prefs: Record<string, unknown>
}

export function ProjectSelector(): JSX.Element | null {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)
  const activeProject = projects.find((project) => project.id === activeProjectId)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [projectsResponse, preferencesResponse] = await Promise.all([
          fetch('/api/projects'),
          fetch('/api/user/preferences'),
        ])

        if (!projectsResponse.ok || !preferencesResponse.ok) {
          throw new Error('Failed to load project selector data')
        }

        const projectRows: Project[] = await projectsResponse.json()
        const preferences: PreferencesResponse = await preferencesResponse.json()

        if (cancelled) return

        setProjects(projectRows)
        setActiveProjectId(
          typeof preferences.prefs.active_project_id === 'string'
            ? preferences.prefs.active_project_id
            : '',
        )
      } catch (error) {
        console.error('[ProjectSelector] Failed to load projects:', error)
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [])

  const handleValueChange = async (projectId: string) => {
    if (!projectId) return

    try {
      const response = await fetch('/api/user/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prefs: { active_project_id: projectId },
        }),
      })

      if (!response.ok) {
        throw new Error('Failed to save preferences')
      }

      router.push(window.location.pathname)
      router.refresh()
    } catch (error) {
      console.error('[ProjectSelector] Failed to save active project:', error)
    }
  }

  if (isLoading || projects.length === 0) {
    return null
  }

  return (
    <div className="hidden items-center gap-3 rounded-md border bg-card px-3 py-1.5 md:flex">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-primary">
        <Folder className="h-4 w-4" />
      </div>
      <div className="flex min-w-[120px] flex-col">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">workspace</span>
        <span className="max-w-[150px] truncate text-sm font-medium">
          {activeProject?.name ?? 'Select project'}
        </span>
      </div>
      <Select value={activeProjectId} onValueChange={handleValueChange}>
        <SelectTrigger size="sm" aria-label="Select project">
          <SelectValue placeholder="Select a project" />
        </SelectTrigger>
        <SelectContent>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
