import { describe, expect, it } from 'vitest'

import {
  canManageBudgets,
  canManageCompliance,
  canManageModels,
  isOrgAdmin,
} from './organizations'
import { hasPermission, ORG_PERMISSIONS, PLATFORM_PERMISSIONS } from './permissions'

const session = (role: string, permissions: string[] = []) => ({ role, permissions })

describe('permission registry', () => {
  it('grants via explicit permission claims', () => {
    expect(hasPermission(session('member', ['org:budgets:manage']), ORG_PERMISSIONS.budgetsManage)).toBe(true)
    expect(hasPermission(session('member'), ORG_PERMISSIONS.budgetsManage)).toBe(false)
  })

  it('legacy admin role implies every org:* permission (back-compat)', () => {
    const admin = session('admin')
    expect(hasPermission(admin, ORG_PERMISSIONS.settingsManage)).toBe(true)
    expect(hasPermission(admin, ORG_PERMISSIONS.modelsManage)).toBe(true)
    expect(hasPermission(admin, ORG_PERMISSIONS.complianceManage)).toBe(true)
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
