import { render, screen, within } from '@/test-utils'
import { describe, expect, test } from 'vitest'

import { getDictionary } from '@/i18n'
import { createTranslator } from '@/i18n/translate'
import { type PermissionSpec, type RoleSpec } from '@/lib/authz/catalog'
import { PermissionReference, invertRoles } from './permission-reference'

const t = createTranslator(getDictionary('en'), 'organization')

const permission = (over: Partial<PermissionSpec> = {}): PermissionSpec => ({
  slug: 'org:budgets:manage',
  name: 'Manage LLM budgets',
  description: 'Manage LLM budgets and view org-wide usage.',
  tier: 'org',
  ...over,
})

const role = (over: Partial<RoleSpec> = {}): RoleSpec => ({
  slug: 'admin',
  name: 'Admin',
  description: 'Full administration of one organization.',
  tier: 'org',
  scope: 'environment',
  permissions: ['org:budgets:manage'],
  ...over,
})

/** The table row a permission's slug identifies. */
const rowFor = (slug: string): HTMLElement => screen.getByText(slug).closest('tr') as HTMLElement

describe('invertRoles', () => {
  test('collects every role that grants a permission, in catalog order', () => {
    const granting = invertRoles([
      role({ slug: 'admin', name: 'Admin' }),
      role({ slug: 'org-billing-admin', name: 'Billing Admin' }),
      role({ slug: 'org-auditor', name: 'Auditor', permissions: ['org:audit:view'] }),
    ])

    expect(granting.get('org:budgets:manage')?.map((r) => r.name)).toEqual([
      'Admin',
      'Billing Admin',
    ])
    expect(granting.get('org:audit:view')?.map((r) => r.name)).toEqual(['Auditor'])
    expect(granting.get('org:settings:manage')).toBeUndefined()
  })

  test('a role granting the same permission twice is still listed once per role', () => {
    const granting = invertRoles([
      role({ permissions: ['org:budgets:manage', 'org:audit:view'] }),
      role({ slug: 'org-auditor', name: 'Auditor', permissions: ['org:audit:view'] }),
    ])

    expect(granting.get('org:audit:view')?.map((r) => r.slug)).toEqual(['admin', 'org-auditor'])
  })
})

describe('PermissionReference', () => {
  test('lists the roles that grant each permission', () => {
    render(
      <PermissionReference
        permissions={[permission()]}
        roles={[role(), role({ slug: 'org-billing-admin', name: 'Billing Admin' })]}
      />
    )

    const row = rowFor('org:budgets:manage')
    expect(within(row).getByText('Admin')).toBeInTheDocument()
    expect(within(row).getByText('Billing Admin')).toBeInTheDocument()
  })

  test('says so when no role grants a permission', () => {
    // A permission no role holds is a real and important finding: nobody can
    // exercise it, which usually means a provisioning gap rather than a design.
    render(
      <PermissionReference
        permissions={[permission({ slug: 'org:archiv:manage', name: 'Manage document Archiv' })]}
        roles={[role()]}
      />
    )

    const row = rowFor('org:archiv:manage')
    expect(within(row).getByText(t('access.permissions.noRoles'))).toBeInTheDocument()
  })

  test('marks a deprecated permission visibly', () => {
    render(
      <PermissionReference
        permissions={[
          permission({
            slug: 'project:edit',
            name: 'Edit project content',
            tier: 'project',
            deprecated: true,
          }),
          permission(),
        ]}
        roles={[role()]}
      />
    )

    expect(
      within(rowFor('project:edit')).getByText(t('access.permissions.deprecated'))
    ).toBeInTheDocument()
    expect(
      within(rowFor('org:budgets:manage')).queryByText(t('access.permissions.deprecated'))
    ).not.toBeInTheDocument()
  })

  test('groups by tier in reading order, dropping tiers with no permissions', () => {
    render(
      <PermissionReference
        permissions={[
          permission({ slug: 'workflow:run', name: 'Run workflow', tier: 'workflow' }),
          permission(),
        ]}
        roles={[role()]}
      />
    )

    const rendered = screen
      .getAllByTestId(/^permission-tier-/)
      .map((section) => section.getAttribute('data-testid'))
    expect(rendered).toEqual(['permission-tier-org', 'permission-tier-workflow'])
  })

  test('the shipped catalog renders with the real inversion behind it', () => {
    render(<PermissionReference />)

    // `org:audit:view` is granted by exactly three shipped roles; if a role edit
    // changes that, this view must be why anyone finds out.
    const row = rowFor('org:audit:view')
    expect(within(row).getByText('Admin')).toBeInTheDocument()
    expect(within(row).getByText('Auditor')).toBeInTheDocument()
    expect(within(row).getByText('Compliance Officer')).toBeInTheDocument()
  })
})
