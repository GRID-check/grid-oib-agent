/**
 * Human labels for the permissions a custom role can carry (ADR-0086).
 *
 * The catalog's names are English, written for provisioning; an office
 * composing a role reads German. Each organization permission has a key in
 * `organization.customRoles.permission`, and this map says which. It is a map
 * rather than a derivation from the slug so `permission-labels.spec.ts` can
 * fail the day the catalog gains an organization permission nobody labelled,
 * instead of the editor quietly showing a raw slug.
 */

import { findPermissionSpec } from '@/lib/authz/catalog'
import type { Translator } from '@/i18n/translate'

export const PERMISSION_LABEL_KEYS: Readonly<Record<string, string>> = {
  'org:settings:manage': 'settings_manage',
  'org:models:manage': 'models_manage',
  'org:budgets:manage': 'budgets_manage',
  'org:compliance:manage': 'compliance_manage',
  'org:audit:view': 'audit_view',
  'org:archiv:manage': 'archiv_manage',
  'org:skills:manage': 'skills_manage',
  'org:projects:create': 'projects_create',
  'org:projects:administer': 'projects_administer',
  'org:members:manage': 'members_manage',
}

export interface PermissionLabel {
  name: string
  /** One line on what it allows; null when only the catalog knows the permission. */
  hint: string | null
}

/**
 * The label for one permission, from a translator scoped to `organization`.
 * A permission without a key (one set in the WorkOS dashboard, or newer than
 * this map) falls back to the catalog's name, then to its slug.
 */
export function permissionLabel(t: Translator, slug: string): PermissionLabel {
  const key = PERMISSION_LABEL_KEYS[slug]
  if (key) {
    return { name: t(`customRoles.permission.${key}.name`), hint: t(`customRoles.permission.${key}.hint`) }
  }
  return { name: findPermissionSpec(slug)?.name ?? slug, hint: null }
}
