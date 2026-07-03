// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '@tanstack/react-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { Lock, Search, UserPlus, Users } from 'lucide-react'
import { useAppForm } from '@/components/form'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'

type ProjectRole = 'project-viewer' | 'project-editor' | 'project-admin'

interface Member {
  organizationMembershipId: string
  userId: string
  email: string | null
  name: string
  role: ProjectRole | null
}

interface ProjectMembersFormProps {
  projectId: string
  /** Whether the current user may change roles / add members. */
  canManage: boolean
}

const ROLE_OPTIONS: Array<{ value: ProjectRole; label: string }> = [
  { value: 'project-viewer', label: 'Viewer' },
  { value: 'project-editor', label: 'Editor' },
  { value: 'project-admin', label: 'Admin' },
]

const roleLabel = (role: ProjectRole): string =>
  ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role

/** Radix Select items cannot use an empty-string value; sentinel for "no access". */
const NO_ACCESS = 'none'

const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase())
  return letters.join('') || '?'
}

const searchSchema = z.object({
  query: z.string(),
})

const inviteSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  roleSlug: z.enum(['project-viewer', 'project-editor', 'project-admin']),
})

export function ProjectMembersForm({ projectId, canManage }: ProjectMembersFormProps): JSX.Element {
  const [members, setMembers] = useState<Member[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)

  // Keep a live reference so the invite form's onSubmit resolves against the
  // current roster rather than a stale closure.
  const membersRef = useRef<Member[]>([])
  membersRef.current = members

  const searchForm = useAppForm({
    defaultValues: { query: '' },
    validators: { onChange: searchSchema },
  })
  const query = useStore(searchForm.store, (state) => state.values.query)

  const load = useCallback(async () => {
    setIsLoading(true)
    setLoadError(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/members`)
      if (!response.ok) {
        throw new Error('Failed to load members')
      }
      const data = await response.json()
      setMembers(data.members ?? [])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load members'
      setLoadError(message)
      toast.error(message)
    } finally {
      setIsLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const assignRole = useCallback(
    async (organizationMembershipId: string, roleSlug: ProjectRole | ''): Promise<boolean> => {
      setUpdatingId(organizationMembershipId)
      setActionError(null)
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
          prev.map((member) =>
            member.organizationMembershipId === organizationMembershipId
              ? { ...member, role: roleSlug || null }
              : member,
          ),
        )
        return true
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update role'
        setActionError(message)
        toast.error(message)
        return false
      } finally {
        setUpdatingId(null)
      }
    },
    [projectId],
  )

  const inviteForm = useAppForm({
    defaultValues: { email: '', roleSlug: 'project-viewer' as ProjectRole },
    validators: { onChange: inviteSchema },
    onSubmit: async ({ value, formApi }) => {
      setInviteError(null)
      const email = value.email.trim().toLowerCase()
      const match = membersRef.current.find((member) => (member.email ?? '').toLowerCase() === email)

      if (!match) {
        setInviteError(
          'No organization member uses that email. They need to join the organization before they can be added to this project.',
        )
        return
      }

      const ok = await assignRole(match.organizationMembershipId, value.roleSlug)
      if (ok) {
        toast.success(`${match.name} now has ${roleLabel(value.roleSlug)} access to this project.`)
        formApi.reset()
      }
    },
  })

  const filteredMembers = members.filter((member) => {
    const haystack = `${member.name} ${member.email ?? ''}`.toLowerCase()
    return haystack.includes(query.toLowerCase())
  })

  const activeCount = members.filter((member) => member.role).length

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-5">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="h-14 rounded-md" />
        ))}
      </div>
    )
  }

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load members</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      {canManage ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void inviteForm.handleSubmit()
          }}
          className="flex flex-col gap-4 rounded-lg border bg-card p-6"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted text-primary">
              <UserPlus className="h-4 w-4" />
            </div>
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold">Add a member</h2>
              <p className="text-sm text-muted-foreground">
                Grant an existing organization member access to this project.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <inviteForm.AppField name="email">
              {(field) => (
                <field.TextField
                  label="Email"
                  type="email"
                  autoComplete="off"
                  placeholder="name@studio.at"
                  containerClassName="flex-1"
                />
              )}
            </inviteForm.AppField>
            <inviteForm.AppField name="roleSlug">
              {(field) => (
                <field.SelectField
                  label="Role"
                  options={ROLE_OPTIONS}
                  containerClassName="sm:w-44"
                  triggerClassName="w-full"
                />
              )}
            </inviteForm.AppField>
          </div>

          {inviteError && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {inviteError}
            </p>
          )}

          <div className="flex justify-end">
            <inviteForm.AppForm>
              <inviteForm.SubmitButton>Add member</inviteForm.SubmitButton>
            </inviteForm.AppForm>
          </div>
        </form>
      ) : (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertTitle>Read-only access</AlertTitle>
          <AlertDescription>
            You can see everyone on this project. Only project admins can change roles or add
            members.
          </AlertDescription>
        </Alert>
      )}

      {actionError && (
        <Alert variant="destructive">
          <AlertTitle>Access update failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <div className="rounded-lg border bg-card">
        <div className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted text-primary">
              <Users className="h-4 w-4" />
            </div>
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold">Members</h2>
              <p className="text-xs text-muted-foreground">
                {activeCount} with access · {members.length} in organization
              </p>
            </div>
          </div>

          <searchForm.AppField name="query">
            {(field) => (
              <div className="relative w-full sm:max-w-xs">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  placeholder="Search by name or email"
                  aria-label="Search project members"
                  className="pl-9"
                />
              </div>
            )}
          </searchForm.AppField>
        </div>

        {members.length === 0 ? (
          <EmptyState
            variant="bare"
            icon={Users}
            title="No members yet"
            description="Organization members you add will appear here with their project role."
          />
        ) : filteredMembers.length === 0 ? (
          <EmptyState
            variant="bare"
            icon={Search}
            title="No matching members"
            description="No one matches your search. Clear it to see the full roster."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => searchForm.setFieldValue('query', '')}
              >
                Clear search
              </Button>
            }
          />
        ) : (
          <div className="divide-y">
            {filteredMembers.map((member) => {
              const isUpdating = updatingId === member.organizationMembershipId
              return (
                <div
                  key={member.organizationMembershipId}
                  className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-accent/40"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar className="size-9">
                      <AvatarFallback className="text-xs font-semibold">
                        {initials(member.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <p className="truncate text-sm font-medium">{member.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {member.email ?? member.userId}
                      </p>
                    </div>
                  </div>

                  {canManage ? (
                    <div className="flex min-w-[220px] items-center justify-end gap-3">
                      {isUpdating && (
                        <span className="text-xs uppercase tracking-wider text-muted-foreground">
                          saving
                        </span>
                      )}
                      <Select
                        value={member.role || NO_ACCESS}
                        onValueChange={(value) =>
                          assignRole(
                            member.organizationMembershipId,
                            value === NO_ACCESS ? '' : (value as ProjectRole),
                          )
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
                  ) : member.role ? (
                    <Badge variant="secondary" className="shrink-0">
                      {roleLabel(member.role)}
                    </Badge>
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground">No access</span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
