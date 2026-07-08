'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useStore } from '@tanstack/react-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { Lock, Search, UserPlus, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FieldShell, useAppForm, useFieldContext } from '@/components/form'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
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
import { useTranslations } from '@/i18n'

type ProjectRole = 'project-viewer' | 'project-editor' | 'project-admin'

interface Member {
  organizationMembershipId: string
  userId: string
  email: string | null
  name: string
  profilePictureUrl: string | null
  role: ProjectRole | null
}

interface ProjectMembersFormProps {
  projectId: string
  /** Whether the current user may change roles / add members. */
  canManage: boolean
}

const ROLE_VALUES: ProjectRole[] = ['project-viewer', 'project-editor', 'project-admin']

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

/** Square with a slight radius to match the WorkOS members widget. */
function MemberAvatar({ member, className }: { member: Member; className?: string }): JSX.Element {
  return (
    <Avatar className={cn('rounded-md', className)}>
      {member.profilePictureUrl && <AvatarImage src={member.profilePictureUrl} alt="" />}
      <AvatarFallback className="rounded-md text-xs font-semibold">
        {initials(member.name)}
      </AvatarFallback>
    </Avatar>
  )
}

const MAX_SUGGESTIONS = 6

interface MemberSuggestFieldProps {
  label: string
  placeholder: string
  /** Full org roster to suggest from; picking one fills the field with their email. */
  members: Member[]
  roleLabel: (role: ProjectRole) => string
  containerClassName?: string
}

/**
 * Combobox over the already-loaded org roster. WorkOS has no member-search
 * API (listUsers only filters by exact email), so suggestions are filtered
 * client-side; the field's submitted value stays a plain email address.
 */
function MemberSuggestField({
  label,
  placeholder,
  members,
  roleLabel,
  containerClassName,
}: MemberSuggestFieldProps): JSX.Element {
  const t = useTranslations('members')
  const field = useFieldContext<string>()
  const listboxId = useId()
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)

  const query = (field.state.value ?? '').trim().toLowerCase()
  const suggestions = members
    .filter((member) => member.email)
    .filter((member) => `${member.name} ${member.email}`.toLowerCase().includes(query))
    .sort(
      (a, b) =>
        // Members without project access first — they're the ones being added.
        Number(Boolean(a.role)) - Number(Boolean(b.role)) || a.name.localeCompare(b.name),
    )
    .slice(0, MAX_SUGGESTIONS)

  const active = Math.min(highlight, Math.max(suggestions.length - 1, 0))
  const optionId = (index: number): string => `${listboxId}-option-${index}`

  const errors = field.state.meta.isTouched
    ? (field.state.meta.errors as Array<string | { message: string } | undefined>)
    : []

  const pick = (member: Member): void => {
    field.handleChange(member.email ?? '')
    setOpen(false)
  }

  return (
    <FieldShell label={label} htmlFor={field.name} errors={errors} className={containerClassName}>
      <div className="relative">
        <Input
          id={field.name}
          name={field.name}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={open && suggestions[active] ? optionId(active) : undefined}
          aria-invalid={errors.length > 0 || undefined}
          placeholder={placeholder}
          value={field.state.value ?? ''}
          onChange={(event) => {
            field.handleChange(event.target.value)
            setOpen(true)
            setHighlight(0)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            field.handleBlur()
            setOpen(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              setHighlight((value) => Math.min(value + 1, suggestions.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setHighlight((value) => Math.max(value - 1, 0))
            } else if (event.key === 'Enter') {
              if (open && suggestions[active]) {
                event.preventDefault()
                pick(suggestions[active])
              }
            } else if (event.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
        {open && (
          <div
            id={listboxId}
            role="listbox"
            aria-label={t('invite.suggestionsAria')}
            className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-xl border bg-popover shadow-md"
          >
            {suggestions.length === 0 ? (
              <p className="px-3 py-2.5 text-sm text-muted-foreground">
                {t('invite.noSuggestions')}
              </p>
            ) : (
              suggestions.map((member, index) => (
                <div
                  key={member.organizationMembershipId}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  // preventDefault keeps focus on the input so blur doesn't
                  // close the list before the click lands.
                  onMouseDown={(event) => {
                    event.preventDefault()
                    pick(member)
                  }}
                  onMouseEnter={() => setHighlight(index)}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 px-3 py-2',
                    index === active && 'bg-accent',
                  )}
                >
                  <MemberAvatar member={member} className="size-7" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{member.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{member.email}</span>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {member.role ? roleLabel(member.role) : t('roster.noAccess')}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </FieldShell>
  )
}

export function ProjectMembersForm({ projectId, canManage }: ProjectMembersFormProps): JSX.Element {
  const t = useTranslations('members')
  const roleLabel = (role: ProjectRole): string => t(`roles.${role}`)
  const roleOptions = ROLE_VALUES.map((value) => ({ value, label: roleLabel(value) }))

  const inviteSchema = z.object({
    email: z.string().min(1, t('validation.emailRequired')).email(t('validation.emailInvalid')),
    roleSlug: z.enum(['project-viewer', 'project-editor', 'project-admin']),
  })

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
        throw new Error(t('errors.loadFailed'))
      }
      const data = await response.json()
      setMembers(data.members ?? [])
    } catch (err) {
      const message = err instanceof Error ? err.message : t('errors.loadFailed')
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
          throw new Error(data.error || t('errors.updateFailed'))
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
        const message = err instanceof Error ? err.message : t('errors.updateFailed')
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
        setInviteError(t('invite.notFound'))
        return
      }

      const ok = await assignRole(match.organizationMembershipId, value.roleSlug)
      if (ok) {
        toast.success(
          t('invite.success', { name: match.name, role: roleLabel(value.roleSlug) }),
        )
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
      <div className="flex flex-col gap-3 rounded-2xl border bg-card p-6 shadow-xs">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="h-14 rounded-xl" />
        ))}
      </div>
    )
  }

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t('errors.loadTitle')}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('tryAgain')}
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
          className="flex flex-col gap-4 rounded-2xl border bg-card p-6 shadow-xs"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
              <UserPlus className="h-4 w-4" aria-hidden />
            </div>
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold">{t('invite.title')}</h2>
              <p className="text-sm text-muted-foreground">{t('invite.description')}</p>
            </div>
          </div>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <inviteForm.AppField name="email">
              {() => (
                <MemberSuggestField
                  label={t('invite.memberLabel')}
                  placeholder={t('invite.searchPlaceholder')}
                  members={members}
                  roleLabel={roleLabel}
                  containerClassName="flex-1"
                />
              )}
            </inviteForm.AppField>
            <inviteForm.AppField name="roleSlug">
              {(field) => (
                <field.SelectField
                  label={t('invite.roleLabel')}
                  options={roleOptions}
                  containerClassName="sm:w-44"
                  triggerClassName="w-full"
                />
              )}
            </inviteForm.AppField>
          </div>

          {inviteError && (
            <p role="alert" className="text-sm text-destructive">
              {inviteError}
            </p>
          )}

          <div className="flex justify-end">
            <inviteForm.AppForm>
              <inviteForm.SubmitButton>{t('invite.submit')}</inviteForm.SubmitButton>
            </inviteForm.AppForm>
          </div>
        </form>
      ) : (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertTitle>{t('readOnly.title')}</AlertTitle>
          <AlertDescription>{t('readOnly.description')}</AlertDescription>
        </Alert>
      )}

      {actionError && (
        <Alert variant="destructive">
          <AlertTitle>{t('errors.actionTitle')}</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
        <div className="flex flex-col gap-3 border-b border-border px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
              <Users className="h-4 w-4" aria-hidden />
            </div>
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold">{t('roster.title')}</h2>
              <p className="text-xs text-muted-foreground">
                {t('roster.counts', { active: activeCount, total: members.length })}
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
                  placeholder={t('roster.searchPlaceholder')}
                  aria-label={t('roster.searchAria')}
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
            title={t('roster.emptyTitle')}
            description={t('roster.emptyDescription')}
          />
        ) : filteredMembers.length === 0 ? (
          <EmptyState
            variant="bare"
            icon={Search}
            title={t('roster.noMatchTitle')}
            description={t('roster.noMatchDescription')}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => searchForm.setFieldValue('query', '')}
              >
                {t('roster.clearSearch')}
              </Button>
            }
          />
        ) : (
          <div className="divide-y divide-border">
            {filteredMembers.map((member) => {
              const isUpdating = updatingId === member.organizationMembershipId
              return (
                <div
                  key={member.organizationMembershipId}
                  className="flex flex-col gap-3 px-4 py-3.5 transition-colors duration-200 ease-out hover:bg-accent/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <MemberAvatar member={member} className="size-9" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <p className="truncate text-sm font-medium">{member.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {member.email ?? member.userId}
                      </p>
                    </div>
                  </div>

                  {canManage ? (
                    <div className="flex items-center justify-end gap-3 sm:min-w-[220px]">
                      {isUpdating && (
                        <span className="text-xs uppercase tracking-widest text-muted-foreground">
                          {t('roster.saving')}
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
                        disabled={isUpdating}
                      >
                        <SelectTrigger
                          className="w-full sm:w-[180px]"
                          aria-label={t('roster.roleForMember', { name: member.name })}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_ACCESS}>{t('roster.noAccessOption')}</SelectItem>
                          {roleOptions.map((option) => (
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
                    <span className="shrink-0 text-xs text-muted-foreground">{t('roster.noAccess')}</span>
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
