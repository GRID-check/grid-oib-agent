'use client'

/**
 * The one sharing surface for a resource (spec SH-17): the access overview plus
 * the controls that change it.
 *
 * The rules this file exists to hold — each of them a thing that, done the obvious
 * way, would make the dialog lie about who can read the thread:
 *
 *   1. **Only what the server returned is on screen.** `useSharing` is deliberately
 *      non-optimistic, and this dialog stays that way: a mutation that resolves
 *      `false` leaves the roster exactly as it was and raises the refusal. A
 *      cheerfully-added row the server rejected would be a false statement about
 *      access control, which is worse than a slow one.
 *   2. **Only `allowedVisibilities` is offered.** The registry decides what a type
 *      permits (conversations: `private`/`project` in phase 1) and the API rejects
 *      the rest, so offering `organisation` here would be a control that fails.
 *   3. **Narrowing is an access removal, and it is confirmed by showing the faces.**
 *      Rather than prose about what "might" happen, the confirmation lists the
 *      people who lose access — derived from the roster on screen, so it cannot
 *      drift from what actually happens.
 *   4. **Derived access has no per-person controls.** Grants are additive and there
 *      is no per-person deny (SH-3), so a "remove" button on a row that reads
 *      "Projektmitglied" would promise something the model cannot do. Those rows
 *      keep their reason line and no controls; their access changes by changing the
 *      rule above.
 *   5. **People who cannot be invited are shown, disabled, with the reason** (SH-19).
 *      Sharing a chat never grants project access, and a picker that silently omits
 *      a colleague reads as a bug — so the block is taught, not hidden.
 *   6. **Leaving is not managing.** Self-removal needs only `viewer`, so the Leave
 *      action is outside the `canManage` gate.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, Search, ShieldCheck, UserMinus, UserPlus } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import {
  SHARING_ERROR_REASONS,
  type ResourceAccessEntry,
  type ResourceRole,
  type ResourceVisibility,
  type ShareCandidate,
  type ShareableResourceType,
} from '@/lib/sharing/types'
import { cn } from '@/lib/utils'
import type { SharingFailure, UseSharingResult } from '../hooks/use-sharing'
import { useShareCandidates } from '../hooks/use-sharing'
import { AccessOverview } from './AccessOverview'
import { PersonAvatar } from './ParticipantStrip'

/**
 * The role ladder and the visibility ranking, weakest first.
 *
 * Spelled out here rather than imported from `@/lib/db/schema`, where the same
 * unions live: that module is the Drizzle schema, and pulling it into a client
 * component would drag the whole database layer into the browser bundle. Both are
 * typed as exhaustive `Record`s / arrays over the wire unions, so a new role or
 * visibility is a type error here rather than a silently missing option.
 */
const ROLE_OPTIONS: readonly ResourceRole[] = ['viewer', 'collaborator', 'owner']
const VISIBILITY_RANK: Record<ResourceVisibility, number> = {
  private: 0,
  project: 1,
  organization: 2,
}

/** Candidates shown at once. Bounded so the dialog cannot grow without limit. */
const MAX_CANDIDATES = 6

/** A consequential change waiting for explicit confirmation. */
type PendingConfirm =
  | { kind: 'visibility'; next: ResourceVisibility }
  | { kind: 'remove'; entry: ResourceAccessEntry }
  | { kind: 'leave' }

export interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  resourceId: string | null
  /**
   * Sharing state, owned by the caller. The chat toolbar already holds it for the
   * participant strip and the access chip, so taking it as a prop keeps one
   * request per conversation instead of a second one every time this opens.
   */
  sharing: UseSharingResult
  resourceType?: ShareableResourceType
  /** The reader, so their own row is marked and Leave targets them. */
  currentUserId?: string | null
}

export function ShareDialog({
  open,
  onOpenChange,
  resourceId,
  sharing,
  resourceType = 'conversation',
  currentUserId = null,
}: ShareDialogProps): JSX.Element | null {
  const t = useTranslations('collaboration')
  const tCommon = useTranslations('common')

  const { state, loading, loadError, failure, saving, refresh } = sharing
  const canManage = state?.canManage ?? false

  // Candidates are loaded lazily: only while the dialog is open, and only for
  // someone who could act on them.
  const { candidates, loading: candidatesLoading } = useShareCandidates(
    resourceType,
    resourceId,
    open && canManage,
  )

  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<PendingConfirm | null>(null)

  const roleLabel = (role: ResourceRole): string => t(`sharing.roles.${role}`)

  const failureMessage = (value: SharingFailure): string => {
    if (value.reason === SHARING_ERROR_REASONS.lastOwner) return t('sharing.errors.lastOwner')
    if (value.reason === SHARING_ERROR_REASONS.containerAccessRequired) {
      return t('sharing.errors.containerAccessRequired')
    }
    return t('sharing.errors.saveFailed')
  }

  /** People who would lose access if visibility narrowed — the derived rows. */
  const derivedEntries = useMemo(
    () =>
      (state?.entries ?? []).filter(
        (entry) => entry.reason === 'visibility-project' || entry.reason === 'visibility-organization',
      ),
    [state],
  )

  const filteredCandidates = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = candidates.filter((candidate) =>
      `${candidate.person.name} ${candidate.person.email ?? ''}`.toLowerCase().includes(needle),
    )
    // Invitable first, then people who are already in, and blocked colleagues
    // last — visible, but never in the way of the action that works (SH-19).
    const weight = (candidate: ShareCandidate): number =>
      candidate.needsProjectAccess ? 2 : candidate.alreadyHasAccess ? 1 : 0
    return matches
      .sort((a, b) => weight(a) - weight(b) || a.person.name.localeCompare(b.person.name))
      .slice(0, MAX_CANDIDATES)
  }, [candidates, query])

  if (!resourceId) return null

  const handleVisibilityChange = (next: ResourceVisibility): void => {
    if (!state || next === state.visibility) return
    // Narrowing takes access away from everyone who only had it through the old
    // rule, so it is never applied straight from the select.
    if (VISIBILITY_RANK[next] < VISIBILITY_RANK[state.visibility]) {
      setPending({ kind: 'visibility', next })
      return
    }
    void sharing.setVisibility(next)
  }

  const confirmProps = (): {
    title: string
    description: string
    confirmLabel: string
    children?: ReactNode
    onConfirm: () => Promise<void>
  } | null => {
    if (!pending) return null
    if (pending.kind === 'visibility') {
      return {
        title: t('sharing.visibilityHeading'),
        description: t(`sharing.visibility.${pending.next}Hint`),
        confirmLabel: t(`sharing.visibility.${pending.next}`),
        // Say what happens by showing it: exactly the rows that disappear.
        children:
          derivedEntries.length > 0 ? (
            <ul className="mt-1 space-y-1.5" data-testid="visibility-loss-list">
              {derivedEntries.map((entry) => (
                <li key={entry.person.userId} className="flex items-center gap-2">
                  <PersonAvatar person={entry.person} size="sm" />
                  <span className="truncate text-sm text-foreground">{entry.person.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {t(`sharing.reasons.${entry.reason}`)}
                  </span>
                </li>
              ))}
            </ul>
          ) : undefined,
        onConfirm: async () => {
          await sharing.setVisibility(pending.next)
        },
      }
    }
    if (pending.kind === 'remove') {
      return {
        title: t('sharing.removeConfirm', { name: pending.entry.person.name }),
        description: t('sharing.removeConfirmHint'),
        confirmLabel: t('sharing.remove'),
        onConfirm: async () => {
          await sharing.revoke(pending.entry.person.userId)
        },
      }
    }
    return {
      title: t('sharing.leaveConfirm'),
      description: t('sharing.leaveConfirmHint'),
      confirmLabel: t('sharing.leave'),
      onConfirm: async () => {
        if (!currentUserId) return
        const ok = await sharing.revoke(currentUserId)
        // Access is gone — keeping the dialog open on a roster the reader may no
        // longer read would be both wrong and confusing.
        if (ok) onOpenChange(false)
      },
    }
  }

  const confirm = confirmProps()

  /** Per-row controls. Only explicit grants get them — see rule 4 in the header. */
  const renderActions = (entry: ResourceAccessEntry): ReactNode => {
    const isSelf = entry.person.userId === currentUserId
    const isExplicit = entry.reason === 'grant' || entry.reason === 'creator'
    if (!canManage || !isExplicit || isSelf) return null
    return (
      <>
        <Select
          value={entry.role}
          disabled={saving}
          onValueChange={(value) => void sharing.changeRole(entry.person.userId, value as ResourceRole)}
        >
          {/* Labelled with the person's name: several of these live in one list, so
              "combobox, Kann mitschreiben" alone would not say whose role it is. */}
          <SelectTrigger className="h-8 w-[150px] text-xs" aria-label={entry.person.name}>
            <SelectValue>{roleLabel(entry.role)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((role) => (
              <SelectItem key={role} value={role}>
                {roleLabel(role)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-foreground"
          disabled={saving}
          aria-label={`${t('sharing.remove')}: ${entry.person.name}`}
          title={t('sharing.remove')}
          onClick={() => setPending({ kind: 'remove', entry })}
        >
          <UserMinus className="size-4" aria-hidden />
        </Button>
      </>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle>{t('sharing.title')}</DialogTitle>
          <DialogDescription>{t('sharing.overview.title')}</DialogDescription>
        </DialogHeader>

        {loading && !state ? (
          // Skeleton shaped like the real thing: rule line, then roster rows.
          <div className="space-y-4" data-testid="share-dialog-skeleton">
            <Skeleton className="h-6 w-40 rounded-md" />
            <Skeleton className="h-4 w-64" />
            <div className="space-y-2">
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} className="h-11 w-full" />
              ))}
            </div>
          </div>
        ) : loadError && !state ? (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" aria-hidden />
            <AlertTitle>{t('sharing.errors.loadFailed')}</AlertTitle>
            <AlertDescription>
              <Button variant="outline" size="sm" className="mt-2" onClick={refresh}>
                {t('sharing.errors.tryAgain')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : state ? (
          <div className="space-y-6">
            {/* A refused mutation must never look like it worked. */}
            {failure && (
              <Alert variant="destructive" data-testid="share-failure">
                <AlertTriangle className="size-4" aria-hidden />
                <AlertDescription>{failureMessage(failure)}</AlertDescription>
              </Alert>
            )}

            {/* The blanket rule. Owners get the control; everyone else gets the
                statement (rendered by the overview below). */}
            {canManage && (
              <section className="space-y-2">
                <h3 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('sharing.visibilityHeading')}
                </h3>
                <Select
                  value={state.visibility}
                  disabled={saving}
                  onValueChange={(value) => handleVisibilityChange(value as ResourceVisibility)}
                >
                  <SelectTrigger className="w-full" aria-label={t('sharing.visibilityHeading')}>
                    <SelectValue>{t(`sharing.visibility.${state.visibility}`)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {/* ONLY what the registry permits for this type. */}
                    {state.allowedVisibilities.map((visibility) => (
                      <SelectItem key={visibility} value={visibility}>
                        <div className="flex flex-col gap-0.5 py-0.5 text-left">
                          <span>{t(`sharing.visibility.${visibility}`)}</span>
                          <span className="text-xs font-normal text-muted-foreground">
                            {t(`sharing.visibility.${visibility}Hint`)}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* The one-line "who that means" for what is selected right now,
                    visible without opening the select (SH-17). */}
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t(`sharing.visibility.${state.visibility}Hint`)}
                </p>
              </section>
            )}

            <AccessOverview
              state={state}
              currentUserId={currentUserId}
              showVisibility={!canManage}
              renderActions={canManage ? renderActions : undefined}
            />

            {canManage && (
              <>
                <Separator />
                <section className="space-y-2.5">
                  <h3 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('sharing.invite.label')}
                  </h3>
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t('sharing.invite.placeholder')}
                      aria-label={t('sharing.invite.label')}
                      className="pl-9"
                    />
                  </div>

                  {candidatesLoading && candidates.length === 0 ? (
                    <div className="space-y-2">
                      {[0, 1].map((row) => (
                        <Skeleton key={row} className="h-11 w-full" />
                      ))}
                    </div>
                  ) : filteredCandidates.length === 0 ? (
                    <p className="px-1 py-2 text-sm text-muted-foreground">
                      {t('sharing.invite.empty')}
                    </p>
                  ) : (
                    <ul className="-mx-2">
                      {filteredCandidates.map((candidate) => (
                        <li
                          key={candidate.person.userId}
                          data-testid="share-candidate"
                          data-blocked={candidate.needsProjectAccess || undefined}
                          className={cn(
                            'flex items-center gap-3 rounded-lg px-2 py-2',
                            candidate.needsProjectAccess && 'opacity-70',
                          )}
                        >
                          <PersonAvatar person={candidate.person} size="md" />
                          <div className="min-w-0 flex-1">
                            <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
                              <span className="truncate">{candidate.person.name}</span>
                              {candidate.needsProjectAccess && (
                                <Chip variant="muted" size="sm" className="shrink-0 font-normal">
                                  {t('sharing.invite.needsProjectAccess')}
                                </Chip>
                              )}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {/* The teaching moment: why this colleague is here
                                  but not invitable. */}
                              {candidate.needsProjectAccess
                                ? t('sharing.invite.needsProjectAccessHint')
                                : (candidate.person.email ?? '')}
                            </p>
                          </div>
                          {candidate.alreadyHasAccess && !candidate.needsProjectAccess ? (
                            // Already in — offer the change that makes sense, not a
                            // second invitation.
                            <Select
                              disabled={saving}
                              onValueChange={(value) =>
                                void sharing.changeRole(candidate.person.userId, value as ResourceRole)
                              }
                            >
                              <SelectTrigger
                                className="h-8 w-[150px] shrink-0 text-xs"
                                aria-label={candidate.person.name}
                              >
                                <SelectValue placeholder={roleLabel('collaborator')} />
                              </SelectTrigger>
                              <SelectContent>
                                {ROLE_OPTIONS.map((role) => (
                                  <SelectItem key={role} value={role}>
                                    {roleLabel(role)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              className="shrink-0 gap-1.5"
                              disabled={saving || candidate.needsProjectAccess}
                              title={
                                candidate.needsProjectAccess
                                  ? t('sharing.invite.needsProjectAccessHint')
                                  : undefined
                              }
                              aria-label={`${t('sharing.invite.submit')}: ${candidate.person.name}`}
                              onClick={() => void sharing.grant(candidate.person.userId)}
                            >
                              <UserPlus className="size-3.5" aria-hidden />
                              {t('sharing.invite.submit')}
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            )}

            {/* Taking ownership is legitimate; silent escalation is not — so it is
                a deliberate, labelled action that says it is audited (SH-10/SH-14). */}
            {state.canEscalate && (
              <>
                <Separator />
                <section className="space-y-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={saving}
                    onClick={() => void sharing.escalate()}
                  >
                    <ShieldCheck className="size-3.5" aria-hidden />
                    {t('sharing.escalate')}
                  </Button>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t('sharing.escalateHint')}
                  </p>
                </section>
              </>
            )}
          </div>
        ) : null}

        <DialogFooter className="sm:justify-between">
          {/* Leaving needs no ownership (SH-12). */}
          {state && state.myRole && state.myRole !== 'owner' && currentUserId ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-danger-subtle hover:text-destructive"
              disabled={saving}
              onClick={() => setPending({ kind: 'leave' })}
            >
              {t('sharing.leave')}
            </Button>
          ) : (
            <span />
          )}
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            {t('sharing.close')}
          </Button>
        </DialogFooter>

        {confirm && (
          <ConfirmDialog
            open
            onOpenChange={(next) => {
              if (!next) setPending(null)
            }}
            title={confirm.title}
            description={confirm.description}
            confirmLabel={confirm.confirmLabel}
            cancelLabel={tCommon('actions.cancel')}
            tone="warning"
            onConfirm={async () => {
              await confirm.onConfirm()
              setPending(null)
            }}
          >
            {confirm.children}
          </ConfirmDialog>
        )}
      </DialogContent>
    </Dialog>
  )
}
