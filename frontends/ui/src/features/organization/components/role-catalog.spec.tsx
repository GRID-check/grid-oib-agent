import { render, screen, within } from '@/test-utils'
import { describe, expect, test } from 'vitest'

import { getDictionary } from '@/i18n'
import { createTranslator } from '@/i18n/translate'
import { ROLES, type RoleSpec } from '@/lib/authz/catalog'
import { RoleCatalog } from './role-catalog'

const t = createTranslator(getDictionary('en'), 'organization')

const role = (over: Partial<RoleSpec> = {}): RoleSpec => ({
  slug: 'org-billing-admin',
  name: 'Billing Admin',
  description: 'FinOps persona.',
  tier: 'org',
  scope: 'environment',
  permissions: ['org:budgets:manage'],
  ...over,
})

describe('RoleCatalog', () => {
  test('renders a role with the human name of every permission it grants', () => {
    render(<RoleCatalog roles={[role()]} />)

    const group = screen.getByTestId('role-tier-org')
    expect(within(group).getByText('Billing Admin')).toBeInTheDocument()
    // The catalog's own label for the permission, not just its slug — the whole
    // point of the view is that "org:budgets:manage" means something.
    expect(within(group).getByText('Manage LLM budgets')).toBeInTheDocument()
    expect(within(group).getByText('org:budgets:manage')).toBeInTheDocument()
  })

  test('a role that grants nothing says so, with no empty list under it', () => {
    render(<RoleCatalog roles={[role({ permissions: [] })]} />)

    const group = screen.getByTestId('role-tier-org')
    expect(
      within(group).getByText(t('access.roles.permissionCountOther', { count: 0 }))
    ).toBeInTheDocument()
    // One list — the roles themselves. No orphan permission list.
    expect(within(group).getAllByRole('list')).toHaveLength(1)
  })

  test('one permission reads as singular, not "1 permissions"', () => {
    render(<RoleCatalog roles={[role({ permissions: ['org:budgets:manage'] })]} />)

    const group = screen.getByTestId('role-tier-org')
    expect(within(group).getByText(t('access.roles.permissionCountOne'))).toBeInTheDocument()
  })

  test('a permission the catalog no longer defines still shows its slug', () => {
    render(<RoleCatalog roles={[role({ permissions: ['org:teleport:manage'] })]} />)

    expect(screen.getByText('org:teleport:manage')).toBeInTheDocument()
  })

  test('marks a deprecated permission wherever a role grants it', () => {
    render(<RoleCatalog roles={[role({ tier: 'project', permissions: ['project:edit'] })]} />)

    const group = screen.getByTestId('role-tier-project')
    expect(within(group).getByText(t('access.permissions.deprecated'))).toBeInTheDocument()
  })

  test('platform-org roles are shown, and shown as not assignable here', () => {
    render(
      <RoleCatalog
        roles={[
          role(),
          role({
            slug: 'org-platform-owner',
            name: 'Platform Owner',
            tier: 'platform',
            scope: 'platform-org',
          }),
        ]}
      />
    )

    const platform = screen.getByTestId('role-tier-platform')
    expect(within(platform).getByText('Platform Owner')).toBeInTheDocument()
    expect(within(platform).getByText(t('access.roles.platformNotice'))).toBeInTheDocument()

    // The tenant-assignable group must NOT inherit the warning.
    const org = screen.getByTestId('role-tier-org')
    expect(within(org).queryByText(t('access.roles.platformNotice'))).not.toBeInTheDocument()
  })

  test('the notice follows the scope, not the tier label it is filed under', () => {
    // `scope: 'platform-org'` is what makes WorkOS refuse the assignment, so a
    // platform-org role filed under any tier must still carry the warning.
    render(<RoleCatalog roles={[role({ scope: 'platform-org' })]} />)

    const org = screen.getByTestId('role-tier-org')
    expect(within(org).getByText(t('access.roles.platformNotice'))).toBeInTheDocument()
  })

  test('tier groups appear in reading order and empty tiers are dropped', () => {
    render(
      <RoleCatalog
        roles={[
          role({ slug: 'skill-viewer', name: 'Skill Viewer', tier: 'skill' }),
          role({ slug: 'member', name: 'Member', tier: 'org' }),
        ]}
      />
    )

    const rendered = screen
      .getAllByTestId(/^role-tier-/)
      .map((section) => section.getAttribute('data-testid'))
    expect(rendered).toEqual(['role-tier-org', 'role-tier-skill'])
  })

  test('renders every shipped role by default', () => {
    render(<RoleCatalog />)

    for (const shipped of ROLES) {
      expect(screen.getByText(shipped.slug)).toBeInTheDocument()
    }
  })
})
