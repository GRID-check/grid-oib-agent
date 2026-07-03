// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useStore } from '@tanstack/react-form'
import { z } from 'zod'
import { Search, Users } from 'lucide-react'
import { useAppForm } from '@/components/form'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'

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

/** Radix Select items cannot use an empty-string value; sentinel for "no access". */
const NO_ACCESS = 'none'

const searchSchema = z.object({
  query: z.string(),
})

export function ProjectMembersForm({ projectId }: ProjectMembersFormProps): JSX.Element {
  const [members, setMembers] = useState<Member[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const form = useAppForm({
    defaultValues: { query: '' },
    validators: { onChange: searchSchema },
  })
  const query = useStore(form.store, (state) => state.values.query)

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
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-5">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="h-16 rounded-md" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-lg border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-muted text-primary">
              <Users className="h-5 w-5" />
            </div>
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold">Organization roster</h2>
              <p className="text-sm text-muted-foreground">
                Assign project access to existing organization members.
              </p>
            </div>
          </div>
          <div className="rounded-md border bg-muted px-4 py-2 text-right">
            <p className="text-sm font-semibold">
              {activeCount}/{members.length}
            </p>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">active</p>
          </div>
        </div>

        <form.AppField name="query">
          {(field) => (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
                placeholder="Search members by name or email"
                aria-label="Search project members"
                className="pl-9"
              />
            </div>
          )}
        </form.AppField>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Access update failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        {filteredMembers.map((member) => {
          const isUpdating = updatingId === member.organizationMembershipId
          return (
            <div
              key={member.organizationMembershipId}
              className="flex items-center justify-between gap-4 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">
                  {member.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="truncate text-sm font-medium">{member.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {member.email ?? member.userId}
                  </p>
                </div>
              </div>

              <div className="flex min-w-[220px] items-center justify-end gap-3">
                {isUpdating && (
                  <span className="text-xs uppercase tracking-wider text-muted-foreground">
                    saving
                  </span>
                )}
                <Select
                  value={member.role || NO_ACCESS}
                  onValueChange={(value) =>
                    updateRole(member.organizationMembershipId, value === NO_ACCESS ? '' : value)
                  }
                >
                  <SelectTrigger
                    className="w-[180px]"
                    aria-label={`Project role for ${member.name}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_ACCESS}>No project access</SelectItem>
                    {ROLE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )
        })}
      </div>

      {filteredMembers.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <h3 className="text-sm font-semibold">No matching members</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Clear the search to see the full organization roster.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => form.setFieldValue('query', '')}
          >
            Clear search
          </Button>
        </div>
      )}
    </div>
  )
}
