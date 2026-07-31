'use client'

/**
 * Who is in this organization, and what role do they hold.
 *
 * The organization page has always embedded the WorkOS Users Management widget,
 * which can invite, re-role and remove people — so "manage members" was already
 * solved. What it could not do is answer the *reading* question in Grid's own
 * language: the widget shows WorkOS role slugs, in WorkOS chrome, with no idea
 * what `org-billing-admin` means to us. An admin auditing their org therefore
 * had to translate slugs by hand.
 *
 * So: the directory is ours (a plain, scannable table where the role carries the
 * display name from `lib/authz/catalog.ts`), and the mutation surface stays
 * WorkOS's, rendered underneath. We deliberately do not rebuild invite /
 * re-role / remove — WorkOS owns the membership lifecycle, and a second
 * implementation of it would be a write path we could get wrong.
 *
 * The fallbacks are the substance of this component, not an afterthought:
 *
 * - **An unknown role slug renders as the slug itself**, not as "unknown". A
 *   custom role provisioned in WorkOS but absent from our catalog is a
 *   legitimate state — that is the whole point of the extensibility contract —
 *   and the raw slug is both true and the string you would go and search for.
 *   Blanking the cell would hide a real grant.
 * - **No role at all gets an explicit string.** An empty cell reads as a
 *   rendering bug; "no role" is a fact about the membership.
 * - **A failed roster load degrades to this card's error state.** The widget
 *   below is a separate system with its own session, so a WorkOS listing hiccup
 *   must not take away the ability to fix the thing you came here to fix.
 *
 * The membership status is printed exactly as WorkOS returns it rather than
 * mapped to copy of our own. WorkOS owns that enum and may add to it; a lookup
 * table would turn a status we have not met yet into a blank or a lie, and the
 * word itself is already the most accurate thing we can say about it.
 *
 * `showManagement` exists for the `/dev` preview only: the widget needs a real
 * token endpoint, and a backend-free screenshot route has none.
 */

import { useMemo } from 'react'
import { UsersManagement, WorkOsWidgets } from '@workos-inc/widgets'
import { Users } from 'lucide-react'
import '@radix-ui/themes/styles.css'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { SectionCard } from '@/features/platform/components/section-card'
import { findRoleSpec } from '@/lib/authz/catalog'
import type { OrganizationMemberWithRole } from '@/lib/organizations/service'
import { makeWidgetTokenFetcher } from '@/lib/workos/widget-token'
import { useResolvedAppearance, widgetTheme } from '@/lib/workos/use-widget-appearance'
import { useTranslations } from '@/i18n'

export interface PeopleDirectoryProps {
  members: readonly OrganizationMemberWithRole[]
  /** The roster fetch failed; show the error state instead of an empty table. */
  error?: boolean
  /** Render the WorkOS management widget. Off in the `/dev` preview. */
  showManagement?: boolean
}

export function PeopleDirectory({
  members,
  error = false,
  showManagement = true,
}: PeopleDirectoryProps): JSX.Element {
  const t = useTranslations('organization')
  const appearance = useResolvedAppearance()
  const usersToken = useMemo(() => makeWidgetTokenFetcher(['widgets:users-table:manage']), [])

  return (
    <div className="flex flex-col gap-6">
      <SectionCard
        title={t('access.people.title')}
        description={t('access.people.description')}
        error={error}
        errorMessage={t('access.people.loadError')}
        empty={members.length === 0}
        emptyIcon={Users}
        emptyTitle={t('access.people.empty')}
        testId="people-directory"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('access.people.columnName')}</TableHead>
              <TableHead>{t('access.people.columnEmail')}</TableHead>
              <TableHead>{t('access.people.columnRole')}</TableHead>
              <TableHead>{t('access.people.columnStatus')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const roleName = member.roleSlug ? findRoleSpec(member.roleSlug)?.name : undefined
              return (
                <TableRow key={member.id}>
                  <TableCell className="font-medium">
                    {member.name ?? <span className="text-muted-foreground font-normal">—</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{member.email}</TableCell>
                  <TableCell>
                    {member.roleSlug ? (
                      <div className="flex flex-col gap-0.5">
                        {/* Name above, slug below — and only the slug when the
                            catalog has no name for it, because printing the same
                            string twice reads as a rendering fault. */}
                        <span>{roleName ?? member.roleSlug}</span>
                        {roleName ? (
                          <code className="text-muted-foreground font-mono text-xs">
                            {member.roleSlug}
                          </code>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">{t('access.people.noRole')}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={member.status.toLowerCase() === 'active' ? 'success' : 'secondary'}
                    >
                      {member.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </SectionCard>

      {/* The mutation half. Same scoped token fetcher the organization overview
          uses, so a caller without `widgets:users-table:manage` gets a refusal
          from the token route rather than a widget that half-works. */}
      {showManagement ? (
        <WorkOsWidgets theme={widgetTheme(appearance)}>
          <Card>
            <CardHeader>
              <CardTitle>{t('members.title')}</CardTitle>
              <CardDescription>{t('members.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <UsersManagement authToken={usersToken} />
            </CardContent>
          </Card>
        </WorkOsWidgets>
      ) : null}
    </div>
  )
}
