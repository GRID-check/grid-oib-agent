'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { JSX } from 'react'
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemList,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { SearchField } from '@/components/ui/search-field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'

type ProjectRole = 'project-viewer' | 'project-contributor' | 'project-editor' | 'project-admin'

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
  /**
   * The signed-in user's own `organizationMembershipId` (same id space as
   * {@link Member.organizationMembershipId}), so the roster can tell which
   * row is "you". Used to guard against an admin silently stripping their
   * own project access. `null`/omitted when unknown — the guard then simply
   * never matches, i.e. it fails open to the pre-existing (unguarded)
   * behavior rather than blocking legitimate changes.
   */
  currentMembershipId?: string | null
}

/** A pending, user-confirmed role change — either a self-row edit or an
 * "Add member" that would actually change an existing member's role. */
interface PendingRoleConfirm {
  title: string
  description: string
  confirmLabel: string
  tone: 'warning' | 'destructive'
  run: () => Promise<void>
}

const ROLE_VALUES: ProjectRole[] = [
  'project-viewer',
  'project-contributor',
  'project-editor',
  'project-admin',
]

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

interface RoleSelectFieldProps {
  label: string
  options: Array<{ value: ProjectRole; label: string; description: string }>
  containerClassName?: string
}

/**
 * Role picker for the invite form. Built directly on the base Select
 * primitives (rather than the shared `field.SelectField`) so each option can
 * carry a one-line explainer of what the role actually grants.
 */
function RoleSelectField({
  label,
  options,
  containerClassName,
}: RoleSelectFieldProps): JSX.Element {
  const field = useFieldContext<ProjectRole>()
  const errors = field.state.meta.isTouched
    ? (field.state.meta.errors as Array<string | { message: string } | undefined>)
    : []
  // The closed trigger should show only the role name — SelectValue would
  // otherwise mirror the full option content, description included.
  const selectedLabel = options.find((option) => option.value === field.state.value)?.label

  return (
    <FieldShell label={label} htmlFor={field.name} errors={errors} className={containerClassName}>
      <Select
        value={field.state.value}
        onValueChange={(value) => field.handleChange(value as ProjectRole)}
      >
        <SelectTrigger id={field.name} className="w-full" onBlur={field.handleBlur}>
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <div className="flex flex-col gap-0.5 py-0.5 text-left">
                <span>{option.label}</span>
                <span className="text-muted-foreground text-xs font-normal">
                  {option.description}
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldShell>
  )
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
        Number(Boolean(a.role)) - Number(Boolean(b.role)) || a.name.localeCompare(b.name)
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
            className="bg-popover absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-xl border shadow-md"
          >
            {suggestions.length === 0 ? (
              <p className="text-muted-foreground px-3 py-2.5 text-sm">
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
                    'duration-snap flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors ease-out motion-reduce:transition-none',
                    index === active && 'bg-accent'
                  )}
                >
                  <MemberAvatar member={member} className="size-7" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{member.name}</span>
                    <span className="text-muted-foreground truncate text-xs">{member.email}</span>
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs">
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

export function ProjectMembersForm({
  projectId,
  canManage,
  currentMembershipId = null,
}: ProjectMembersFormProps): JSX.Element {
  const t = useTranslations('members')
  const tCommon = useTranslations('common')
  const roleLabel = (role: ProjectRole): string => t(`roles.${role}`)
  const roleDescription = (role: ProjectRole): string => t(`roleDescriptions.${role}`)
  const roleOptions = ROLE_VALUES.map((value) => ({
    value,
    label: roleLabel(value),
    description: roleDescription(value),
  }))

  const inviteSchema = z.object({
    email: z.string().min(1, t('validation.emailRequired')).email(t('validation.emailInvalid')),
    roleSlug: z.enum(['project-viewer', 'project-contributor', 'project-editor', 'project-admin']),
  })

  const [members, setMembers] = useState<Member[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  // A destructive-ish role change (self-row edit, or an "Add member" that
  // would actually change an existing member's role) waiting on explicit
  // confirmation before it is sent to the server.
  const [pendingConfirm, setPendingConfirm] = useState<PendingRoleConfirm | null>(null)
  const [isConfirming, setIsConfirming] = useState(false)

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
  }, [projectId, t])

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
          // The server rejects any change that would leave the project with no
          // admin; surface that as its own localized message rather than the
          // generic failure copy.
          const message =
            data?.details?.reason === 'last-admin'
              ? t('errors.lastAdmin')
              : data.error || t('errors.updateFailed')
          throw new Error(message)
        }

        setMembers((prev) =>
          prev.map((member) =>
            member.organizationMembershipId === organizationMembershipId
              ? { ...member, role: roleSlug || null }
              : member
          )
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
    [projectId, t]
  )

  /**
   * Roster row role change. Guards the current user's own row: an admin
   * changing their own role/access on this Select otherwise commits
   * instantly (lockout footgun — see project-members-form ticket), so a
   * self-edit is routed through an explicit confirmation instead of
   * `assignRole` directly.
   */
  const handleRosterRoleChange = (member: Member, nextRole: ProjectRole | ''): void => {
    const isSelf =
      currentMembershipId != null && member.organizationMembershipId === currentMembershipId
    if (!isSelf) {
      void assignRole(member.organizationMembershipId, nextRole)
      return
    }

    if (nextRole) {
      setPendingConfirm({
        title: t('confirm.selfChangeTitle'),
        description: t('confirm.selfChangeDescription', { role: roleLabel(nextRole) }),
        confirmLabel: t('confirm.selfChangeConfirm'),
        tone: 'warning',
        run: async () => {
          await assignRole(member.organizationMembershipId, nextRole)
        },
      })
    } else {
      setPendingConfirm({
        title: t('confirm.selfRemoveTitle'),
        description: t('confirm.selfRemoveDescription'),
        confirmLabel: t('confirm.selfRemoveConfirm'),
        tone: 'destructive',
        run: async () => {
          await assignRole(member.organizationMembershipId, nextRole)
        },
      })
    }
  }

  const inviteForm = useAppForm({
    defaultValues: { email: '', roleSlug: 'project-viewer' as ProjectRole },
    validators: { onChange: inviteSchema },
    onSubmit: async ({ value, formApi }) => {
      setInviteError(null)
      const email = value.email.trim().toLowerCase()
      const match = membersRef.current.find(
        (member) => (member.email ?? '').toLowerCase() === email
      )

      if (!match) {
        setInviteError(t('invite.notFound'))
        return
      }

      const grantAndAnnounce = async (): Promise<void> => {
        const ok = await assignRole(match.organizationMembershipId, value.roleSlug)
        if (ok) {
          toast.success(t('invite.success', { name: match.name, role: roleLabel(value.roleSlug) }))
          formApi.reset()
        }
      }

      if (!match.role) {
        // Genuinely new access — no existing role to clobber.
        await grantAndAnnounce()
        return
      }

      if (match.role === value.roleSlug) {
        // Nothing would actually change; say so instead of a no-op success.
        setInviteError(
          t('invite.alreadyHasRole', { name: match.name, role: roleLabel(match.role) })
        )
        return
      }

      // `match` already has a project role — "Add member" here would
      // silently change it (e.g. an admin picked as a "viewer" invite gets
      // downgraded). Confirm the change explicitly instead of presenting a
      // role change as a cheerful "added" toast.
      setPendingConfirm({
        title: t('confirm.roleChangeTitle'),
        description: t('confirm.roleChangeDescription', {
          name: match.name,
          from: roleLabel(match.role),
          to: roleLabel(value.roleSlug),
        }),
        confirmLabel: t('confirm.roleChangeConfirm', { role: roleLabel(value.roleSlug) }),
        tone: 'warning',
        run: grantAndAnnounce,
      })
    },
  })

  const filteredMembers = members.filter((member) => {
    const haystack = `${member.name} ${member.email ?? ''}`.toLowerCase()
    return haystack.includes(query.toLowerCase())
  })

  const activeCount = members.filter((member) => member.role).length

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3">
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-14 rounded-xl" />
          ))}
        </CardContent>
      </Card>
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
    <>
      <div className="flex flex-col gap-8">
        {canManage ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserPlus className="text-muted-foreground size-4" aria-hidden />
                {t('invite.title')}
              </CardTitle>
              <CardDescription>{t('invite.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  void inviteForm.handleSubmit()
                }}
                className="flex flex-col gap-4"
              >
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
                    {() => (
                      <RoleSelectField
                        label={t('invite.roleLabel')}
                        options={roleOptions}
                        containerClassName="sm:w-56"
                      />
                    )}
                  </inviteForm.AppField>
                </div>

                {inviteError && <FieldError>{inviteError}</FieldError>}

                <div className="flex justify-end">
                  <inviteForm.AppForm>
                    <inviteForm.SubmitButton>{t('invite.submit')}</inviteForm.SubmitButton>
                  </inviteForm.AppForm>
                </div>
              </form>
            </CardContent>
          </Card>
        ) : (
          <Alert>
            <Lock className="size-4" />
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

        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="[.border-b]:pb-4 gap-3 border-b py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col gap-1.5">
                <CardTitle className="flex items-center gap-2">
                  <Users className="text-muted-foreground size-4" aria-hidden />
                  {t('roster.title')}
                </CardTitle>
                <CardDescription>
                  {t('roster.counts', { active: activeCount, total: members.length })}
                </CardDescription>
              </div>

              <searchForm.AppField name="query">
                {(field) => (
                  <SearchField
                    type="text"
                    className="w-full sm:max-w-xs"
                    value={field.state.value}
                    onChange={(value) => field.handleChange(value)}
                    placeholder={t('roster.searchPlaceholder')}
                    label={t('roster.searchAria')}
                    clearLabel={t('roster.clearSearch')}
                    onClear={() => searchForm.setFieldValue('query', '')}
                  />
                )}
              </searchForm.AppField>
            </div>
          </CardHeader>

          <CardContent className="p-0">
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
              <ItemList className="rounded-none border-0">
                {filteredMembers.map((member) => {
                  const isUpdating = updatingId === member.organizationMembershipId
                  const isSelf =
                    currentMembershipId != null &&
                    member.organizationMembershipId === currentMembershipId
                  return (
                    <Item
                      key={member.organizationMembershipId}
                      className="flex-col items-stretch sm:flex-row sm:items-center"
                    >
                      <ItemMedia className="size-9">
                        <MemberAvatar member={member} className="size-9" />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{member.name}</span>
                          {isSelf && (
                            <Badge variant="outline" className="shrink-0">
                              {t('roster.youBadge')}
                            </Badge>
                          )}
                        </ItemTitle>
                        <ItemDescription>{member.email ?? member.userId}</ItemDescription>
                      </ItemContent>
                      <ItemActions className="ml-0 w-full justify-end sm:ml-auto sm:w-auto sm:min-w-[220px]">
                        {canManage ? (
                          <>
                            <span
                              className={cn(
                                'text-muted-foreground duration-snap text-xs uppercase tracking-widest transition-opacity ease-out motion-reduce:transition-none',
                                !isUpdating && 'invisible'
                              )}
                              aria-hidden={!isUpdating}
                            >
                              {t('roster.saving')}
                            </span>
                            <Select
                              value={member.role || NO_ACCESS}
                              onValueChange={(value) =>
                                handleRosterRoleChange(
                                  member,
                                  value === NO_ACCESS ? '' : (value as ProjectRole)
                                )
                              }
                              disabled={isUpdating}
                            >
                              <SelectTrigger
                                className="w-full sm:w-[180px]"
                                aria-label={t('roster.roleForMember', { name: member.name })}
                              >
                                <SelectValue>
                                  {member.role
                                    ? roleLabel(member.role)
                                    : t('roster.noAccessOption')}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={NO_ACCESS}>
                                  {t('roster.noAccessOption')}
                                </SelectItem>
                                {roleOptions.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    <div className="flex flex-col gap-0.5 py-0.5 text-left">
                                      <span>{option.label}</span>
                                      <span className="text-muted-foreground text-xs font-normal">
                                        {option.description}
                                      </span>
                                    </div>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </>
                        ) : member.role ? (
                          <Badge variant="secondary" className="shrink-0">
                            {roleLabel(member.role)}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground shrink-0 text-xs">
                            {t('roster.noAccess')}
                          </span>
                        )}
                      </ItemActions>
                    </Item>
                  )
                })}
              </ItemList>
            )}
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={pendingConfirm != null}
        onOpenChange={(open) => {
          if (!open) setPendingConfirm(null)
        }}
        title={pendingConfirm?.title ?? ''}
        description={pendingConfirm?.description}
        confirmLabel={pendingConfirm?.confirmLabel ?? ''}
        cancelLabel={tCommon('actions.cancel')}
        tone={pendingConfirm?.tone ?? 'warning'}
        pending={isConfirming}
        onConfirm={async () => {
          const confirm = pendingConfirm
          if (!confirm) return
          setIsConfirming(true)
          try {
            await confirm.run()
          } finally {
            setIsConfirming(false)
            setPendingConfirm(null)
          }
        }}
      />
    </>
  )
}
