import { render, screen, within } from '@/test-utils'
import { describe, expect, test, vi } from 'vitest'

import { getDictionary } from '@/i18n'
import { createTranslator } from '@/i18n/translate'
import type { OrganizationMemberWithRole } from '@/lib/organizations/service'
import { PeopleDirectory } from './people-directory'

/**
 * The WorkOS widget owns the mutation half of this surface and needs a live
 * token endpoint, so it is stubbed to a marker. What these tests are about is
 * the READING half — that a slug becomes a name, and that the states where it
 * cannot are still legible rather than blank.
 */
vi.mock('@workos-inc/widgets', () => ({
  WorkOsWidgets: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  UsersManagement: () => <div data-testid="users-management" />,
}))

/**
 * Copy is resolved through the same translator the component uses rather than
 * hard-coded, so these assertions pin the BEHAVIOUR (an explicit string is
 * rendered for a member with no role) and survive the dictionary being reworded.
 */
const t = createTranslator(getDictionary('en'), 'organization')

const member = (over: Partial<OrganizationMemberWithRole> = {}): OrganizationMemberWithRole => ({
  id: 'user_1',
  email: 'anna.weber@buero.at',
  name: 'Anna Weber',
  roleSlug: 'member',
  status: 'active',
  ...over,
})

/** The row a member's email identifies, so assertions stay per-person. */
const rowFor = (email: string): HTMLElement => screen.getByText(email).closest('tr') as HTMLElement

describe('PeopleDirectory', () => {
  test('renders the human role name from the catalog, keeping the slug beside it', () => {
    render(
      <PeopleDirectory
        members={[member({ roleSlug: 'org-billing-admin' })]}
        showManagement={false}
      />
    )

    const row = rowFor('anna.weber@buero.at')
    expect(within(row).getByText('Billing Admin')).toBeInTheDocument()
    expect(within(row).getByText('org-billing-admin')).toBeInTheDocument()
  })

  test('falls back to the raw slug for a role the catalog does not know', () => {
    // A custom role provisioned in WorkOS but not yet in our catalog is a
    // legitimate state — showing the slug is true and actionable; blanking the
    // cell would hide a real grant. It is shown ONCE: with no catalog name to
    // pair it with, a second copy underneath reads as a rendering fault.
    render(
      <PeopleDirectory
        members={[member({ roleSlug: 'org-fire-marshal' })]}
        showManagement={false}
      />
    )

    const row = rowFor('anna.weber@buero.at')
    expect(within(row).getByText('org-fire-marshal')).toBeInTheDocument()
  })

  test('renders an explicit string when a membership carries no role', () => {
    render(<PeopleDirectory members={[member({ roleSlug: null })]} showManagement={false} />)

    const row = rowFor('anna.weber@buero.at')
    expect(within(row).getByText(t('access.people.noRole'))).toBeInTheDocument()
  })

  test('a member WorkOS knows only by email still gets a row', () => {
    render(<PeopleDirectory members={[member({ name: null })]} showManagement={false} />)

    const row = rowFor('anna.weber@buero.at')
    expect(within(row).getByText('—')).toBeInTheDocument()
  })

  test('prints the membership status exactly as WorkOS returned it', () => {
    // WorkOS owns this enum and may add to it; a lookup table would turn a
    // status we have not met yet into a blank or a lie.
    render(<PeopleDirectory members={[member({ status: 'quarantined' })]} showManagement={false} />)

    expect(screen.getByText('quarantined')).toBeInTheDocument()
  })

  test('a failed roster load shows the error state instead of an empty table', () => {
    render(<PeopleDirectory members={[]} error showManagement={false} />)

    expect(screen.getByText(t('access.people.loadError'))).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    // The empty state must not also fire — "nobody is here" and "we could not
    // find out who is here" are different claims.
    expect(screen.queryByText(t('access.people.empty'))).not.toBeInTheDocument()
  })

  test('an organization with no members reads as empty, not as broken', () => {
    render(<PeopleDirectory members={[]} showManagement={false} />)

    expect(screen.getByText(t('access.people.empty'))).toBeInTheDocument()
    expect(screen.queryByText(t('access.people.loadError'))).not.toBeInTheDocument()
  })

  test('renders the WorkOS management widget beneath the directory by default', () => {
    render(<PeopleDirectory members={[member()]} />)

    expect(screen.getByTestId('users-management')).toBeInTheDocument()
  })
})
