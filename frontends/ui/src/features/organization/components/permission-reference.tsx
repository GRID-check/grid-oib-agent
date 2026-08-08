'use client'

/**
 * The catalog read the other way round: for each permission, who has it.
 *
 * The role catalog answers "what does this role let someone do". This answers
 * the question that actually arrives in an incident or an audit — *"who can
 * delete documents in the Archiv?"* — and it is a genuinely different question,
 * because a permission may be granted by several roles and by none. Nobody
 * should have to read eighteen role definitions and hold the union in their
 * head; that reading is exactly what a computer is for.
 *
 * The inversion is computed here from `ROLES` rather than stored. A maintained
 * permission→roles map would be a second source of truth that agrees with the
 * catalog only until the next role edit, and disagreeing about who can do what
 * is the one failure mode an access reference must not have.
 *
 * Deprecated permissions are shown, marked, and NOT hidden. They still sit on
 * live grants (`project:edit` is on Project Editor and Project Admin today), so
 * an admin auditing a role meets the slug whether or not we print it — the
 * useful act is to say it is retained-but-superseded rather than to let it look
 * like an unknown.
 *
 * Two columns, not four. The description belongs *under* the permission it
 * describes rather than beside it: pairing them keeps a long sentence from
 * stretching the row that the "granted by" badges have to line up in, and leaves
 * the one column a reader actually scans down — who holds this — narrow enough
 * to compare. `Table` already scrolls inside its own box, so a long slug never
 * makes the page body scroll sideways.
 */

import { KeyRound } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { SectionCard } from '@/features/platform/components/section-card'
import {
  ALL_PERMISSION_SPECS,
  ROLES,
  type PermissionSpec,
  type RoleSpec,
} from '@/lib/authz/catalog'
import { useTranslations } from '@/i18n'
import { groupByTier } from './role-catalog'

export interface PermissionReferenceProps {
  /** Defaults to the shipped catalog. Injectable so specs can pin edge cases. */
  permissions?: readonly PermissionSpec[]
  /** The roles the inversion is computed from. Defaults to the shipped catalog. */
  roles?: readonly RoleSpec[]
}

/**
 * Invert the role→permissions catalog into permission slug → granting roles.
 *
 * Built from the roles actually passed in, so the answer can never be stale
 * relative to the catalog it was derived from.
 */
export function invertRoles(roles: readonly RoleSpec[]): ReadonlyMap<string, readonly RoleSpec[]> {
  const granting = new Map<string, RoleSpec[]>()
  for (const role of roles) {
    for (const slug of role.permissions) {
      const existing = granting.get(slug)
      if (existing) existing.push(role)
      else granting.set(slug, [role])
    }
  }
  return granting
}

export function PermissionReference({
  permissions = ALL_PERMISSION_SPECS,
  roles = ROLES,
}: PermissionReferenceProps): JSX.Element {
  const t = useTranslations('organization')
  const granting = invertRoles(roles)
  const groups = groupByTier(permissions)

  return (
    <SectionCard
      title={t('access.permissions.title')}
      description={t('access.permissions.description')}
      empty={groups.length === 0}
      emptyIcon={KeyRound}
      testId="permission-reference"
    >
      <div className="flex flex-col gap-8">
        {groups.map(({ tier, items }) => (
          <section
            key={tier}
            className="flex flex-col gap-2"
            data-testid={`permission-tier-${tier}`}
          >
            <h3 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              {t(`access.tiers.${tier}`)}
            </h3>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('access.permissions.columnPermission')}</TableHead>
                  <TableHead>{t('access.permissions.grantedBy')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((permission) => {
                  const grantedBy = granting.get(permission.slug) ?? []
                  return (
                    <TableRow key={permission.slug}>
                      <TableCell className="align-top">
                        <div className="flex max-w-xl flex-col gap-1">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                            <span className="font-medium">{permission.name}</span>
                            <code className="text-muted-foreground font-mono text-xs">
                              {permission.slug}
                            </code>
                            {permission.deprecated ? (
                              <Badge variant="warning">{t('access.permissions.deprecated')}</Badge>
                            ) : null}
                          </div>
                          <p className="text-muted-foreground text-sm">{permission.description}</p>
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        {grantedBy.length === 0 ? (
                          <span className="text-muted-foreground text-sm">
                            {t('access.permissions.noRoles')}
                          </span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {grantedBy.map((role) => (
                              <Badge key={role.slug} variant="secondary">
                                {role.name}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </section>
        ))}
      </div>
    </SectionCard>
  )
}
