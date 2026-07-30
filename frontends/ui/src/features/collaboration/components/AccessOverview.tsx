'use client'

/**
 * "Who is accessing this" — the panel the participant strip opens, and the body of
 * the share dialog (spec SH-17).
 *
 * The whole design serves one sentence: **a reader must learn in one glance both
 * the blanket rule and the named exceptions.** Those are two different kinds of
 * access and a flat list of names cannot express the difference — a project-wide
 * thread whose roster happens to show three people looks identical to a private
 * thread shared with three people, and they are not remotely the same thing. So:
 *
 *   - the top states the *rule* — the visibility chip plus its plain-words
 *     consequence ("Alle im Projekt können ebenfalls mitlesen und mitschreiben")
 *     and the number of people that currently resolves to;
 *   - below it the *people*, grouped by what they may do, because "who can change
 *     this" and "who can only read it" is the distinction a reader is actually
 *     scanning for;
 *   - and every row carries **why** it is there ("Projektmitglied", "Eingeladen von
 *     Matthias"). A name with no reason is the thing that generates the "why can
 *     Anna see this?" support ticket, so the reason is not optional garnish — it is
 *     the point of the row.
 *
 * Presentational: it renders the state it is handed and never fetches or mutates.
 * The share dialog injects per-row controls through `renderActions`, which is what
 * lets the management surface reuse this grouping instead of growing a second,
 * drifting copy of it.
 */

import type { ReactNode } from 'react'
import { Users } from 'lucide-react'

import { EmptyState } from '@/components/ui/empty-state'
import { useTranslations } from '@/i18n'
import type {
  ResourceAccessEntry,
  ResourceRole,
  ResourceSharingState,
} from '@/lib/sharing/types'
import { cn } from '@/lib/utils'
import { AccessChip } from './AccessChip'
import { PersonAvatar, sortByRoleThenName } from './ParticipantStrip'

/** Strongest first: owners, then contributors, then readers. */
const GROUPS: ReadonlyArray<{ role: ResourceRole; headingKey: string }> = [
  { role: 'owner', headingKey: 'sharing.overview.ownersHeading' },
  { role: 'collaborator', headingKey: 'sharing.overview.collaboratorsHeading' },
  { role: 'viewer', headingKey: 'sharing.overview.viewersHeading' },
]

/** `viaVisibility*` — the consequence sentence for each blanket rule. */
const CONSEQUENCE: Record<string, string> = {
  private: 'sharing.overview.viaVisibilityPrivate',
  project: 'sharing.overview.viaVisibilityProject',
  organization: 'sharing.overview.viaVisibilityOrganization',
}

export interface AccessOverviewProps {
  state: ResourceSharingState
  /** Marks the reader's own row with `sharing.overview.you`. */
  currentUserId?: string | null
  /**
   * Renders the controls at the trailing edge of a row (role select, remove).
   * Omitted on the read-only overview, supplied by the share dialog.
   */
  renderActions?: (entry: ResourceAccessEntry) => ReactNode
  /**
   * Show the visibility chip + its consequence line. The share dialog turns this
   * off because its visibility *selector* states the same rule one control above,
   * and saying it twice makes the reader hunt for the difference.
   */
  showVisibility?: boolean
  className?: string
}

export function AccessOverview({
  state,
  currentUserId = null,
  renderActions,
  showVisibility = true,
  className,
}: AccessOverviewProps): JSX.Element {
  const t = useTranslations('collaboration')

  const ordered = sortByRoleThenName(state.entries)
  const count = ordered.length
  const countLabel = count === 1 ? t('sharing.overview.countOne') : t('sharing.overview.countMany', { count })

  // Grants are the named exceptions; under `private` their number is what the
  // access chip reports ("Mit 3 Personen geteilt").
  const namedOthers = ordered.filter(
    (entry) =>
      entry.person.userId !== currentUserId &&
      (entry.reason === 'grant' || entry.reason === 'creator'),
  ).length

  // `grantedBy` is a user id; the granter is usually on the roster themselves, so
  // resolve names from it and fall back to the anonymous variant rather than
  // printing a raw id at a colleague.
  const nameById = new Map(ordered.map((entry) => [entry.person.userId, entry.person.name]))

  const reasonFor = (entry: ResourceAccessEntry): string => {
    if (entry.reason !== 'grant') return t(`sharing.reasons.${entry.reason}`)
    const granter = entry.grantedBy ? nameById.get(entry.grantedBy) : null
    return granter ? t('sharing.reasons.grant', { name: granter }) : t('sharing.reasons.grantUnknown')
  }

  return (
    <section className={cn('space-y-4', className)} data-testid="access-overview">
      {/* The rule. Chip + consequence + how many people it currently resolves to. */}
      {showVisibility && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <AccessChip visibility={state.visibility} sharedWith={namedOthers} size="md" />
            <span className="text-xs tabular-nums text-muted-foreground">{countLabel}</span>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t(CONSEQUENCE[state.visibility] ?? CONSEQUENCE.private)}
          </p>
        </div>
      )}

      {/* The people. */}
      <div className="space-y-4">
        {!showVisibility && (
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('sharing.peopleHeading')}
            </h3>
            <span className="text-xs tabular-nums text-muted-foreground">{countLabel}</span>
          </div>
        )}

        {count === 0 ? (
          <EmptyState
            variant="bare"
            icon={Users}
            title={t('sharing.overview.title')}
            description={t(CONSEQUENCE[state.visibility] ?? CONSEQUENCE.private)}
          />
        ) : (
          GROUPS.map(({ role, headingKey }) => {
            const group = ordered.filter((entry) => entry.role === role)
            if (group.length === 0) return null
            return (
              <div key={role} className="space-y-1" data-testid={`access-group-${role}`}>
                <h4 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t(headingKey)}
                </h4>
                <ul className="-mx-2">
                  {group.map((entry) => (
                    <li
                      key={entry.person.userId}
                      data-testid="access-row"
                      data-role={entry.role}
                      data-reason={entry.reason}
                      className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-200 ease-out hover:bg-accent/40"
                    >
                      <PersonAvatar person={entry.person} size="md" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {entry.person.name}
                          {entry.person.userId === currentUserId && (
                            <span className="font-normal text-muted-foreground">
                              {' '}
                              ({t('sharing.overview.you')})
                            </span>
                          )}
                        </p>
                        {/* Why they are here — quiet, but never absent. */}
                        <p className="truncate text-xs text-muted-foreground">{reasonFor(entry)}</p>
                      </div>
                      {/* No role label on the read-only overview: the group
                          heading above already says it, and repeating it per row
                          is noise in a panel meant to be scanned. */}
                      {renderActions && (
                        <div className="flex shrink-0 items-center gap-1.5">{renderActions(entry)}</div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
