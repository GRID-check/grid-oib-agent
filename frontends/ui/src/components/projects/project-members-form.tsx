// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { Button, Flex, Select, Text, TextInput } from '@/adapters/ui'
import { Search, Users } from '@/adapters/ui/icons'

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
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
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
    setUpdatingId(organizationMembershipId)
    setError(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationMembershipId, roleSlug }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to update role')
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
    } finally {
      setUpdatingId(null)
    }
  }

  const filteredMembers = members.filter((member) => {
    const haystack = `${member.name} ${member.email ?? ''}`.toLowerCase()
    return haystack.includes(query.toLowerCase())
  })

  const activeCount = members.filter((member) => member.role).length

  if (isLoading) {
    return (
      <Flex direction="col" gap="3" className="rounded-[1.5rem] border border-base bg-surface-raised-30 p-5">
        {[0, 1, 2].map((item) => (
          <div key={item} className="h-16 animate-pulse rounded-2xl bg-surface-raised-50" />
        ))}
      </Flex>
    )
  }

  return (
    <Flex direction="col" gap="5">
      <div className="rounded-[1.75rem] border border-base bg-surface-raised-30 p-5 shadow-[0_24px_70px_-50px_rgba(15,23,42,0.55)]">
        <Flex direction="col" gap="4">
          <Flex align="start" justify="between" gap="4">
            <Flex gap="3" align="center">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-base bg-surface-raised-50 text-brand">
                <Users className="h-5 w-5" />
              </div>
              <Flex direction="col" gap="1">
                <Text kind="label/bold/md" className="text-primary">
                  Organization roster
                </Text>
                <Text kind="body/regular/sm" className="text-subtle">
                  Assign project access to existing organization members.
                </Text>
              </Flex>
            </Flex>
            <div className="rounded-2xl border border-base bg-surface-sunken px-4 py-3 text-right">
              <Text kind="label/bold/md" className="text-primary">
                {activeCount}/{members.length}
              </Text>
              <Text kind="body/regular/xs" className="text-subtle uppercase tracking-[0.18em]">
                active
              </Text>
            </div>
          </Flex>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
            <TextInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search members by name or email"
              aria-label="Search project members"
              className="w-full pl-9"
            />
          </div>
        </Flex>
      </div>

      {error && (
        <div className="rounded-2xl border border-status-error bg-status-error-muted p-4">
          <Text kind="label/semibold/sm" className="text-status-error">
            Access update failed
          </Text>
          <Text kind="body/regular/sm" className="mt-1 text-primary">
            {error}
          </Text>
        </div>
      )}

      <Flex direction="col" gap="3">
        {filteredMembers.map((member) => {
          const isUpdating = updatingId === member.organizationMembershipId
          return (
            <Flex
              key={member.organizationMembershipId}
              align="center"
              justify="between"
              gap="4"
              className="rounded-[1.25rem] border border-base bg-surface-raised-30 p-4 transition hover:-translate-y-[1px] hover:bg-surface-raised-50"
            >
              <Flex align="center" gap="3" className="min-w-0">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-surface-sunken text-sm font-semibold text-primary">
                  {member.name.slice(0, 2).toUpperCase()}
                </div>
                <Flex direction="col" gap="1" className="min-w-0">
                  <Text kind="label/regular/md" className="truncate text-primary">
                    {member.name}
                  </Text>
                  <Text kind="body/regular/sm" className="truncate text-subtle">
                    {member.email ?? member.userId}
                  </Text>
                </Flex>
              </Flex>

              <div className="flex min-w-[220px] items-center justify-end gap-3">
                {isUpdating && (
                  <Text kind="body/regular/xs" className="text-subtle uppercase tracking-[0.18em]">
                    saving
                  </Text>
                )}
                <Select
                  value={member.role ?? ''}
                  onValueChange={(value) => updateRole(member.organizationMembershipId, value)}
                  items={[
                    { value: '', children: 'No project access' },
                    ...ROLE_OPTIONS.map((option) => ({
                      value: option.value,
                      children: option.label,
                    })),
                  ]}
                />
              </div>
            </Flex>
          )
        })}
      </Flex>

      {filteredMembers.length === 0 && (
        <div className="rounded-[1.25rem] border border-dashed border-base p-8 text-center">
          <Text kind="label/semibold/md" className="text-primary">
            No matching members
          </Text>
          <Text kind="body/regular/sm" className="mt-2 text-subtle">
            Clear the search to see the full organization roster.
          </Text>
          <Button kind="secondary" size="small" className="mt-4" onClick={() => setQuery('')}>
            Clear search
          </Button>
        </div>
      )}
    </Flex>
  )
}
