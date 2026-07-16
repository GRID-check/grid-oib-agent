/**
 * Organization-level authorization helpers.
 *
 * Built on the permission registry (lib/authz/permissions.ts, ADR-0016):
 * each surface checks the specific `org:*` permission it needs, so custom
 * WorkOS roles holding a subset of permissions work without code changes.
 * The legacy `admin` role and the users-table widget permission keep working
 * via hasPermission's back-compat rule / the explicit check below.
 */

import type { GridSession } from '@/lib/auth/types'
import { hasPermission, ORG_PERMISSIONS } from './permissions'

/** The WorkOS widget permission that gates member management. */
export const USERS_TABLE_MANAGE = 'widgets:users-table:manage'

type SessionSlice = Pick<GridSession, 'role' | 'permissions'>

/**
 * True when the session may administer its organization (settings, members).
 * Kept as the broad gate for the org page shell; feature areas below use
 * their granular permission.
 */
export function isOrgAdmin(session: SessionSlice): boolean {
  return hasPermission(session, ORG_PERMISSIONS.settingsManage) || session.permissions.includes(USERS_TABLE_MANAGE)
}

/** May manage runtime AI model configuration (ADR-0014). */
export function canManageModels(session: SessionSlice): boolean {
  return hasPermission(session, ORG_PERMISSIONS.modelsManage)
}

/** May manage LLM budgets and see org-wide usage (ADR-0015). */
export function canManageBudgets(session: SessionSlice): boolean {
  return hasPermission(session, ORG_PERMISSIONS.budgetsManage)
}

/** May manage legal holds and the deletion queue. */
export function canManageCompliance(session: SessionSlice): boolean {
  return hasPermission(session, ORG_PERMISSIONS.complianceManage)
}

/** May open the org's audit trail (WorkOS Audit Logs viewer, org-scoped). */
export function canViewAuditLogs(session: SessionSlice): boolean {
  return hasPermission(session, ORG_PERMISSIONS.auditView)
}

/**
 * May manage the org-wide document Archiv: upload, delete, re-ingest, retag.
 * Reads (list/preview/download) are open to every org member — the Archiv is
 * shared knowledge — so only mutations gate on this permission. Org admins hold
 * it via the `hasPermission` back-compat rule.
 */
export function canManageArchiv(session: SessionSlice): boolean {
  return hasPermission(session, ORG_PERMISSIONS.archivManage)
}

/** Widget permissions we allow the UI to request a token for, when held. */
export const ORG_WIDGET_PERMISSIONS = [
  'widgets:users-table:manage',
  'widgets:sso:manage',
  'widgets:dsync:manage',
  'widgets:domain-verification:manage',
  'widgets:audit-log-streaming:manage',
] as const

export type OrgWidgetPermission = (typeof ORG_WIDGET_PERMISSIONS)[number]
