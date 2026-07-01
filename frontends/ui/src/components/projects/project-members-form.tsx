// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { Flex, Select, Spinner, Text } from '@/adapters/ui'

interface Member {
  organizationMembershipId: string
  userId: string
  email: string | null
  name: string
  role: 'project-viewer' | 'project-editor' | 'project-admin' | null
}

interface ProjectMembersFormProps {
  projectId: string
}

const ROLE_OPTIONS = [
  { value: 'project-viewer', label: 'Viewer' },
  { value: 'project-editor', label: 'Editor' },
  { value: 'project-admin', label: 'Admin' },
]

export function ProjectMembersForm({ projectId }: ProjectMembersFormProps): JSX.Element {
  const [members, setMembers] = useState<Member[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const response = await fetch(`/api/projects/${projectId}/members`)
        if (!response.ok) {
          throw new Error('Failed to load members')
        }
        const data = await response.json()
        if (!cancelled) {
          setMembers(data.members ?? [])
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load members')
        }
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
  }, [projectId])

  const updateRole = async (organizationMembershipId: string, roleSlug: string) => {
    try {
      const response = await fetch(`/api/projects/${projectId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationMembershipId, roleSlug }),
      })

      if (!response.ok) {
        throw new Error('Failed to update role')
      }

      setMembers((prev) =>
        prev.map((m) =>
          m.organizationMembershipId === organizationMembershipId
            ? { ...m, role: roleSlug as Member['role'] }
            : m
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role')
    }
  }

  if (isLoading) {
    return (
      <Flex align="center" gap="2" className="py-8">
        <Spinner size="small" description="Loading members" />
        <Text kind="body/regular/md" className="text-subtle">Loading members...</Text>
      </Flex>
    )
  }

  if (error) {
    return (
      <Text kind="body/regular/md" className="py-4 text-red-500">
        {error}
      </Text>
    )
  }

  return (
    <Flex direction="col" gap="3">
      {members.map((member) => (
        <Flex
          key={member.organizationMembershipId}
          align="center"
          justify="between"
          className="rounded-lg border p-3"
        >
          <Flex direction="col" gap="1">
            <Text kind="label/regular/md" className="text-primary">
              {member.name}
            </Text>
            {member.email && (
              <Text kind="body/regular/sm" className="text-subtle">
                {member.email}
              </Text>
            )}
          </Flex>

          <Select
            value={member.role ?? ''}
            onValueChange={(value) => updateRole(member.organizationMembershipId, value)}
            items={[
              { value: '', children: 'No access' },
              ...ROLE_OPTIONS.map((option) => ({
                value: option.value,
                children: option.label,
              })),
            ]}
          />
        </Flex>
      ))}
    </Flex>
  )
}
