'use client'

/**
 * What does "Billing Admin" actually mean?
 *
 * The answer has to be inside the product. The role a person holds is a slug on
 * a WorkOS membership, and its meaning is written down in `lib/authz/catalog.ts`,
 * a TypeScript file an admin cannot open. Without a readable catalog, re-roling
 * somebody is a guess, and the fine-grained personas (Auditor, Billing Admin,
 * Compliance Officer, Knowledge Manager) cannot be told apart by the person
 * choosing between them.
 *
 * This renders the catalog itself. Not a hand-written table of what the roles
 * are *believed* to grant — the same `ROLES` array the provisioning script
 * applies to WorkOS and the same permission specs every gate checks. A second,
 * prose copy of this would start drifting the first time a role changed, and the
 * drift would be invisible precisely because it lives in the docs rather than in
 * the type system.
 *
 * Three decisions worth naming:
 *
 * - **Grouped by tier, in reading order** (organization → project → skill →
 *   platform). Tier is not cosmetic: it decides where a role can be held at all,
 *   so an org admin scanning for "who can I make somebody" needs the org group
 *   first, and needs to see that the project/workflow groups are per-resource.
 * - **Platform roles are shown, and shown as unavailable.** Hiding them would be
 *   tidier and worse: an admin who reads about Platform Owner elsewhere and
 *   cannot find it here learns nothing, whereas "exists, not assignable by you"
 *   is the actual access rule. The marker keys off `scope: 'platform-org'`,
 *   which is the property that really makes WorkOS refuse the assignment — not
 *   off the tier, which is only how it is filed.
 * - **A permission the catalog no longer defines still renders, as its slug.**
 *   Substituting "unknown" would throw away the only fact we have. The slug is
 *   both true and the thing you would paste into WorkOS to go look.
 *
 * `roles` is injectable so the catalog's own edge cases (a role granting
 * nothing, a role naming a permission that no longer exists) can be rendered and
 * asserted without inventing them in the real catalog.
 */

import type { JSX } from 'react'
import { ShieldAlert } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Item, ItemList } from '@/components/ui/item'
import { SectionLabel } from '@/components/ui/section-label'
import { SectionCard } from '@/features/platform/components/section-card'
import { ROLES, findPermissionSpec, type PermissionTier, type RoleSpec } from '@/lib/authz/catalog'
import { useTranslations } from '@/i18n'

/**
 * Reading order for the tier groups: the organization you administer, then the
 * things inside it, then the tier you do not administer at all.
 */
export const ACCESS_TIER_ORDER: readonly PermissionTier[] = [
  'org',
  'project',
  // Skill schedules are per-resource. Every tier in the catalog must be listed
  // here: a tier missing from this list silently drops its roles and permissions
  // from the reference, and this screen exists to show an administrator what exists.
  'skill',
  'platform',
]

export interface RoleCatalogProps {
  /** Defaults to the shipped catalog. Injectable so specs can pin edge cases. */
  roles?: readonly RoleSpec[]
}

/** Group into `ACCESS_TIER_ORDER`, dropping tiers nothing landed in. */
export function groupByTier<T extends { readonly tier: PermissionTier }>(
  items: readonly T[]
): readonly { tier: PermissionTier; items: readonly T[] }[] {
  return ACCESS_TIER_ORDER.map((tier) => ({
    tier,
    items: items.filter((item) => item.tier === tier),
  })).filter((group) => group.items.length > 0)
}

export function RoleCatalog({ roles = ROLES }: RoleCatalogProps): JSX.Element {
  const t = useTranslations('organization')
  const groups = groupByTier(roles)

  return (
    <SectionCard
      title={t('access.roles.title')}
      description={t('access.roles.description')}
      empty={groups.length === 0}
      emptyIcon={ShieldAlert}
      testId="role-catalog"
    >
      <div className="flex flex-col gap-8">
        {groups.map(({ tier, items }) => {
          // The notice belongs to the group when anything in it is provisioned
          // inside the platform organization — that, not the tier label, is what
          // makes WorkOS refuse to assign it in a tenant.
          const restricted = items.some((role) => role.scope === 'platform-org')

          return (
            <section key={tier} className="flex flex-col gap-3" data-testid={`role-tier-${tier}`}>
              <div className="flex flex-col gap-1">
                <SectionLabel as="h3">{t(`access.tiers.${tier}`)}</SectionLabel>
                {restricted ? (
                  <p className="text-muted-foreground flex items-start gap-1.5 text-sm">
                    <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {t('access.roles.platformNotice')}
                  </p>
                ) : null}
              </div>

              <ItemList as="ul">
                {items.map((role) => (
                  <Item as="li" key={role.slug} className="flex-col items-stretch gap-0 p-4">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <h4 className="text-sm font-medium">{role.name}</h4>
                      <code className="text-muted-foreground font-mono text-xs">{role.slug}</code>
                    </div>
                    <p className="text-muted-foreground mt-1 text-sm">{role.description}</p>

                    {/* The count IS the heading: "0 permissions" is how a role
                        that grants nothing says so, with no empty list under it. */}
                    <SectionLabel as="p" className="mt-3">
                      {role.permissions.length === 1
                        ? t('access.roles.permissionCountOne')
                        : t('access.roles.permissionCountOther', { count: role.permissions.length })}
                    </SectionLabel>
                    {role.permissions.length > 0 ? (
                      <ul className="mt-1.5 flex flex-col gap-1">
                        {role.permissions.map((slug) => {
                          const spec = findPermissionSpec(slug)
                          return (
                            <li
                              key={slug}
                              className="flex flex-wrap items-baseline gap-x-2 text-sm"
                            >
                              {spec ? <span>{spec.name}</span> : null}
                              <code className="text-muted-foreground font-mono text-xs">
                                {slug}
                              </code>
                              {spec?.deprecated ? (
                                <Badge variant="warning">
                                  {t('access.permissions.deprecated')}
                                </Badge>
                              ) : null}
                            </li>
                          )
                        })}
                      </ul>
                    ) : null}
                  </Item>
                ))}
              </ItemList>
            </section>
          )
        })}
      </div>
    </SectionCard>
  )
}
