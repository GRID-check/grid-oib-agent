// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { Flex, Select, Text } from '@/adapters/ui'

interface Project {
  id: string
  name: string
  collectionName: string
}

interface PreferencesResponse {
  prefs: Record<string, unknown>
}

export function ProjectSelector(): JSX.Element | null {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)

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

      window.location.reload()
    } catch (error) {
      console.error('[ProjectSelector] Failed to save active project:', error)
    }
  }

  if (isLoading || projects.length === 0) {
    return null
  }

  return (
    <Flex align="center" gap="2" className="hidden md:flex">
      <Text kind="label/regular/sm" className="text-subtle whitespace-nowrap">
        Project
      </Text>
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
    </Flex>
  )
}
