import { describe, expect, it } from 'vitest'

import { canManageBudgets, canManageCompliance, canManageModels, isOrgAdmin } from './organizations'
import {
  hasPermission,
  ORG_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  type OrgPermission,
} from './permissions'
import { findRoleSpec } from './catalog'

const session = (role: string, permissions: string[] = []) => ({ role, permissions })

describe('permission registry', () => {
  it('grants via explicit permission claims', () => {
    expect(
      hasPermission(session('member', ['org:budgets:manage']), ORG_PERMISSIONS.budgetsManage)
    ).toBe(true)
    expect(hasPermission(session('member'), ORG_PERMISSIONS.budgetsManage)).toBe(false)
  })

  it('legacy admin role implies every org:* permission (back-compat)', () => {
    const admin = session('admin')
    expect(hasPermission(admin, ORG_PERMISSIONS.settingsManage)).toBe(true)
    expect(hasPermission(admin, ORG_PERMISSIONS.modelsManage)).toBe(true)
    expect(hasPermission(admin, ORG_PERMISSIONS.complianceManage)).toBe(true)
    // The two that used to work ONLY through the wildcard, because they were in
    // the code registry and the runbook but in no WorkOS environment.
    expect(hasPermission(admin, ORG_PERMISSIONS.auditView)).toBe(true)
    expect(hasPermission(admin, ORG_PERMISSIONS.archivManage)).toBe(true)
  })

  it('the admin implication is BOUNDED by the catalog, not a wildcard', () => {
    // The old rule was `permission.startsWith('org:') && role === 'admin'`, so
    // any future org:* permission was pre-granted to every admin the moment it
    // was defined — and a restricted admin was impossible to build. The rule now
    // grants exactly what the catalog says the Admin role holds.
    const adminGrants = new Set(findRoleSpec('admin')?.permissions ?? [])
    const notOnAdmin = 'org:not:provisioned' as unknown as OrgPermission

    expect(adminGrants.has(notOnAdmin)).toBe(false)
    expect(hasPermission(session('admin'), notOnAdmin)).toBe(false)
  })

  it('implication follows the role slug, so fine-grained personas are bounded too', () => {
    // A claims-less auditor session gets exactly the auditor bundle.
    const auditor = session('org-auditor')
    expect(hasPermission(auditor, ORG_PERMISSIONS.auditView)).toBe(true)
    expect(hasPermission(auditor, ORG_PERMISSIONS.settingsManage)).toBe(false)
    expect(hasPermission(auditor, ORG_PERMISSIONS.budgetsManage)).toBe(false)
  })

  it('a platform-org role slug never implies a platform permission', () => {
    // Platform access is membership of the platform org (lib/authz/platform),
    // never a claim. A JWT naming the slug must not be enough on its own.
    const spoofed = session('org-platform-owner')
    expect(hasPermission(spoofed, PLATFORM_PERMISSIONS.organizationsView)).toBe(false)
    expect(hasPermission(spoofed, PLATFORM_PERMISSIONS.organizationsManage)).toBe(false)
  })

  it('an unknown role slug implies nothing', () => {
    expect(hasPermission(session('made-up-role'), ORG_PERMISSIONS.settingsManage)).toBe(false)
  })

  it('admin role NEVER implies platform permissions', () => {
    expect(hasPermission(session('admin'), PLATFORM_PERMISSIONS.organizationsView)).toBe(false)
    expect(hasPermission(session('admin'), PLATFORM_PERMISSIONS.usageView)).toBe(false)
  })

  it('custom roles work through claims alone (extensibility contract)', () => {
    const billingAdmin = session('org-billing-admin', ['org:budgets:manage'])
    expect(canManageBudgets(billingAdmin)).toBe(true)
    expect(canManageModels(billingAdmin)).toBe(false)
    expect(canManageCompliance(billingAdmin)).toBe(false)
    expect(isOrgAdmin(billingAdmin)).toBe(false)
  })

  it('isOrgAdmin honors both org:settings:manage and the legacy widget permission', () => {
    expect(isOrgAdmin(session('member', ['org:settings:manage']))).toBe(true)
    expect(isOrgAdmin(session('member', ['widgets:users-table:manage']))).toBe(true)
    expect(isOrgAdmin(session('member'))).toBe(false)
  })
})
