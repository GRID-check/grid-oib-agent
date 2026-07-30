import { describe, expect, test } from 'vitest'
import { render, screen, within } from '@/test-utils'

import type {
  AccessReason,
  ResourceAccessEntry,
  ResourceRole,
  ResourceSharingState,
  ResourceVisibility,
} from '@/lib/sharing/types'
import { AccessOverview } from './AccessOverview'

/** Default locale in an unprovided test tree is `en`. */

const entry = (
  userId: string,
  name: string,
  role: ResourceRole,
  reason: AccessReason,
  grantedBy: string | null = null,
): ResourceAccessEntry => ({
  person: { userId, name, email: `${userId}@example.com`, profilePictureUrl: null },
  role,
  reason,
  grantedBy,
})

const state = (
  overrides: Partial<ResourceSharingState> = {},
  visibility: ResourceVisibility = 'private',
): ResourceSharingState => ({
  resourceType: 'conversation',
  resourceId: 'c1',
  visibility,
  allowedVisibilities: ['private', 'project'],
  myRole: 'owner',
  canManage: true,
  canEscalate: false,
  shared: true,
  entries: [
    entry('u-matthias', 'Matthias Bigl', 'owner', 'creator'),
    entry('u-anna', 'Anna Weber', 'collaborator', 'grant', 'u-matthias'),
    entry('u-zoe', 'Zoe Vogel', 'viewer', 'grant', 'u-unknown'),
  ],
  ...overrides,
})

describe('AccessOverview — the blanket rule', () => {
  test('states the rule, its consequence in plain words, and the head count', () => {
    render(<AccessOverview state={state()} currentUserId="u-matthias" />)

    expect(screen.getByTestId('access-chip')).toHaveTextContent('Shared with 2')
    // The chip's count is everyone the rule plus the grants resolve to.
    expect(screen.getByText('3 people')).toBeInTheDocument()
    expect(screen.getByText('Only the people listed here.')).toBeInTheDocument()
    // Nothing is derived under `private`, so there is no rule block to draw.
    expect(screen.queryByTestId('access-derived')).toBeNull()
  })

  test('a project-wide thread says the project can read it too', () => {
    render(
      <AccessOverview
        state={state({ visibility: 'project' })}
        currentUserId="u-matthias"
      />,
    )

    expect(screen.getByTestId('access-chip')).toHaveTextContent('Project')
    expect(
      screen.getByText('Everyone in this project can also read and contribute.'),
    ).toBeInTheDocument()
  })

  test('an organization-wide thread says so', () => {
    render(<AccessOverview state={state({ visibility: 'organization' })} />)

    expect(
      screen.getByText('Everyone in your organization can also read and contribute.'),
    ).toBeInTheDocument()
  })

  test('one person uses the singular count key', () => {
    render(
      <AccessOverview
        state={state({ entries: [entry('u-me', 'Me', 'owner', 'creator')] })}
        currentUserId="u-me"
      />,
    )

    expect(screen.getByText('1 person')).toBeInTheDocument()
  })

  test('the rule can be suppressed when the caller states it with its own control', () => {
    render(<AccessOverview state={state()} showVisibility={false} />)

    expect(screen.queryByTestId('access-chip')).not.toBeInTheDocument()
    // …but the named list still says how many people that is. The heading is
    // "Invited by name", not "People with access": with a rule block above it, this
    // list is no longer everyone, and a heading claiming otherwise is the exact
    // confusion the split exists to remove.
    expect(screen.getByText('Invited by name')).toBeInTheDocument()
    expect(screen.getByText('3 people')).toBeInTheDocument()
  })
})

describe('AccessOverview — the named exceptions', () => {
  test('groups people by what they may do', () => {
    render(<AccessOverview state={state()} currentUserId="u-matthias" />)

    expect(screen.getByText('Owners')).toBeInTheDocument()
    expect(screen.getByText('Can contribute')).toBeInTheDocument()
    expect(screen.getByText('Can view')).toBeInTheDocument()

    const owners = screen.getByTestId('access-group-owner')
    expect(within(owners).getByText(/Matthias Bigl/)).toBeInTheDocument()
    expect(within(owners).queryByText(/Anna Weber/)).not.toBeInTheDocument()
  })

  test('omits groups nobody is in, rather than showing an empty heading', () => {
    render(
      <AccessOverview
        state={state({ entries: [entry('u-me', 'Me', 'owner', 'creator')] })}
      />,
    )

    expect(screen.getByTestId('access-group-owner')).toBeInTheDocument()
    expect(screen.queryByTestId('access-group-viewer')).not.toBeInTheDocument()
    expect(screen.queryByText('Can view')).not.toBeInTheDocument()
  })

  test('every row says WHY that person has access', () => {
    render(<AccessOverview state={state()} currentUserId="u-matthias" />)

    expect(screen.getByText('Created this')).toBeInTheDocument()
    expect(screen.getByText('Invited by Matthias Bigl')).toBeInTheDocument()
  })

  test('an unresolvable granter falls back to the anonymous reason, never a raw id', () => {
    render(<AccessOverview state={state()} />)

    expect(screen.getByText('Invited')).toBeInTheDocument()
    expect(screen.queryByText(/u-unknown/)).not.toBeInTheDocument()
  })

  test('project-derived access explains itself as membership', () => {
    render(
      <AccessOverview
        state={state({
          visibility: 'project',
          entries: [
            entry('u-matthias', 'Matthias Bigl', 'owner', 'creator'),
            entry('u-klaus', 'Klaus Berger', 'collaborator', 'visibility-project'),
          ],
        })}
      />,
    )

    // Derived access is its own block — not a row in the named list, because it
    // carries no controls and changing it means changing the rule above it.
    const block = screen.getByTestId('access-derived')
    expect(within(block).getByText('Project member', { exact: false })).toBeInTheDocument()
    // The NAME is present as text, not only as initials in an avatar.
    expect(within(block).getByText('Klaus Berger', { exact: false })).toBeInTheDocument()
    // …and it is not duplicated as a roster row.
    expect(screen.getAllByTestId('access-row')).toHaveLength(1)
  })

  test('a long derived list is bounded and counts the remainder', () => {
    render(
      <AccessOverview
        state={state({
          visibility: 'project',
          entries: [
            entry('u-matthias', 'Matthias Bigl', 'owner', 'creator'),
            ...Array.from({ length: 8 }, (_, index) =>
              entry(`u-${index}`, `Person ${index}`, 'collaborator', 'visibility-project'),
            ),
          ],
        })}
      />,
    )

    // Five names, then the remainder counted rather than silently dropped.
    expect(
      within(screen.getByTestId('access-derived')).getByText(/and 3 more/),
    ).toBeInTheDocument()
  })

  test('marks the reader’s own row', () => {
    render(<AccessOverview state={state()} currentUserId="u-anna" />)

    const rows = screen.getAllByTestId('access-row')
    const mine = rows.find((row) => row.textContent?.includes('Anna Weber'))
    expect(mine?.textContent).toContain('(you)')
    expect(rows.filter((row) => row.textContent?.includes('(you)'))).toHaveLength(1)
  })

  test('the read-only overview carries no controls', () => {
    render(<AccessOverview state={state()} currentUserId="u-matthias" />)

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  test('controls are injected per row when the caller supplies them', () => {
    render(
      <AccessOverview
        state={state()}
        currentUserId="u-matthias"
        renderActions={(item) => <button type="button">{`act:${item.person.name}`}</button>}
      />,
    )

    expect(screen.getByRole('button', { name: 'act:Anna Weber' })).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  test('sorts owners first and alphabetically inside a group', () => {
    render(
      <AccessOverview
        state={state({
          entries: [
            entry('u-zoe', 'Zoe Vogel', 'collaborator', 'grant', 'u-matthias'),
            entry('u-anna', 'Anna Weber', 'collaborator', 'grant', 'u-matthias'),
            entry('u-matthias', 'Matthias Bigl', 'owner', 'creator'),
          ],
        })}
      />,
    )

    const names = screen
      .getAllByTestId('access-row')
      .map((row) => row.querySelector('p')?.textContent?.trim())
    expect(names).toEqual(['Matthias Bigl', 'Anna Weber', 'Zoe Vogel'])
  })

  test('an empty roster still explains the rule instead of showing a bare blank', () => {
    render(<AccessOverview state={state({ entries: [], visibility: 'project' })} />)

    expect(screen.queryByTestId('access-row')).not.toBeInTheDocument()
    expect(screen.getByText('Who has access')).toBeInTheDocument()
    expect(
      screen.getAllByText('Everyone in this project can also read and contribute.').length,
    ).toBeGreaterThan(0)
  })
})
