// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Flex, Select, Text } from '@/adapters/ui'
import { Folder } from '@/adapters/ui/icons'

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
    <div className="hidden items-center gap-3 rounded-full border border-base bg-surface-raised-30 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] md:flex">
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-sunken text-brand">
        <Folder className="h-4 w-4" />
      </div>
      <Flex direction="col" gap="0" className="min-w-[120px]">
        <Text kind="body/regular/xs" className="text-subtle uppercase tracking-[0.18em]">
          workspace
        </Text>
        <Text kind="label/semibold/sm" className="max-w-[150px] truncate text-primary">
          {activeProject?.name ?? 'Select project'}
        </Text>
      </Flex>
      <Select
        value={activeProjectId}
        onValueChange={handleValueChange}
        side="bottom"
        items={[
          { value: '', children: 'Select a project' },
          ...projects.map((project) => ({
            value: project.id,
            children: project.name,
          })),
        ]}
      />
    </div>
  )
}
