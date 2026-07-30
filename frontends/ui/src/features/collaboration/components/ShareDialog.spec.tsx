import { beforeEach, describe, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within } from '@/test-utils'

import type {
  AccessReason,
  ResourceAccessEntry,
  ResourceRole,
  ResourceSharingState,
  ShareCandidate,
} from '@/lib/sharing/types'

// The candidate hook is already built and tested; this spec is about the controls
// and the refusals, so it is stubbed. The sharing state itself arrives as a prop.
vi.mock('../hooks/use-sharing', () => ({
  useShareCandidates: vi.fn(() => ({ candidates: [], loading: false })),
}))

import { useShareCandidates } from '../hooks/use-sharing'
import type { UseSharingResult } from '../hooks/use-sharing'
import { ShareDialog } from './ShareDialog'

const useShareCandidatesMock = vi.mocked(useShareCandidates)

/** Default locale in an unprovided test tree is `en`. */

const person = (userId: string, name: string) => ({
  userId,
  name,
  email: `${userId}@example.com`,
  profilePictureUrl: null,
})

const entry = (
  userId: string,
  name: string,
  role: ResourceRole,
  reason: AccessReason,
  grantedBy: string | null = null,
): ResourceAccessEntry => ({ person: person(userId, name), role, reason, grantedBy })

const ME = 'u-matthias'

const sharingState = (overrides: Partial<ResourceSharingState> = {}): ResourceSharingState => ({
  resourceType: 'conversation',
  resourceId: 'c1',
  visibility: 'private',
  allowedVisibilities: ['private', 'project'],
  myRole: 'owner',
  canManage: true,
  canEscalate: false,
  shared: true,
  entries: [
    entry(ME, 'Matthias Bigl', 'owner', 'creator'),
    entry('u-anna', 'Anna Weber', 'collaborator', 'grant', ME),
  ],
  ...overrides,
})

const setVisibility = vi.fn(async () => true)
const grant = vi.fn(async () => true)
const changeRole = vi.fn(async () => true)
const revoke = vi.fn(async () => true)
const escalate = vi.fn(async () => true)
const refresh = vi.fn()

function sharing(overrides: Partial<UseSharingResult> = {}): UseSharingResult {
  return {
    state: sharingState(),
    loading: false,
    loadError: false,
    failure: null,
    saving: false,
    refresh,
    setVisibility,
    grant,
    changeRole,
    revoke,
    escalate,
    ...overrides,
  }
}

function renderDialog(overrides: Partial<UseSharingResult> = {}, onOpenChange = vi.fn()) {
  render(
    <ShareDialog
      open
      onOpenChange={onOpenChange}
      resourceId="c1"
      currentUserId={ME}
      sharing={sharing(overrides)}
    />,
  )
  return { onOpenChange }
}

const candidate = (
  userId: string,
  name: string,
  flags: Partial<Pick<ShareCandidate, 'alreadyHasAccess' | 'needsProjectAccess'>> = {},
): ShareCandidate => ({
  person: person(userId, name),
  alreadyHasAccess: false,
  needsProjectAccess: false,
  ...flags,
})

beforeEach(() => {
  useShareCandidatesMock.mockReturnValue({ candidates: [], loading: false })
})

describe('ShareDialog — loading and load failure', () => {
  test('shows a skeleton shaped like the roster, never a bare spinner', () => {
    renderDialog({ state: null, loading: true })

    expect(screen.getByTestId('share-dialog-skeleton')).toBeInTheDocument()
    expect(screen.queryByTestId('access-overview')).not.toBeInTheDocument()
  })

  test('a failed load says so and offers a retry that re-reads', async () => {
    const user = userEvent.setup()
    renderDialog({ state: null, loadError: true })

    expect(screen.getByText('Sharing settings could not be loaded.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refresh).toHaveBeenCalledOnce()
  })

  test('renders nothing without a resource', () => {
    render(
      <ShareDialog open onOpenChange={vi.fn()} resourceId={null} sharing={sharing()} />,
    )

    expect(screen.queryByTestId('share-dialog')).not.toBeInTheDocument()
  })
})

describe('ShareDialog — visibility', () => {
  test('offers ONLY the visibilities the registry permits for this type', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('combobox', { name: 'Who can see this' }))

    expect(screen.getByRole('option', { name: /Only me/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Everyone in this project/ })).toBeInTheDocument()
    // `organization` is phase 2 and the API rejects it — offering it would be a
    // control that fails.
    expect(screen.queryByRole('option', { name: /Everyone in the organization/ })).toBeNull()
  })

  test('each option explains who that means, and the current one says it unopened', () => {
    renderDialog()

    expect(screen.getByText('Just you, plus anyone you invite by name.')).toBeInTheDocument()
  })

  test('widening is applied straight away', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('combobox', { name: 'Who can see this' }))
    await user.click(screen.getByRole('option', { name: /Everyone in this project/ }))

    expect(setVisibility).toHaveBeenCalledWith('project')
  })

  test('narrowing is confirmed first, and the confirmation shows who loses access', async () => {
    const user = userEvent.setup()
    renderDialog({
      state: sharingState({
        visibility: 'project',
        entries: [
          entry(ME, 'Matthias Bigl', 'owner', 'creator'),
          entry('u-klaus', 'Klaus Berger', 'collaborator', 'visibility-project'),
        ],
      }),
    })

    await user.click(screen.getByRole('combobox', { name: 'Who can see this' }))
    await user.click(screen.getByRole('option', { name: /Only me/ }))

    // Nothing saved yet.
    expect(setVisibility).not.toHaveBeenCalled()

    const loss = await screen.findByTestId('visibility-loss-list')
    expect(within(loss).getByText('Klaus Berger')).toBeInTheDocument()
    expect(within(loss).getByText('Project member')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Only me' }))
    expect(setVisibility).toHaveBeenCalledWith('private')
  })

  test('cancelling a narrowing changes nothing', async () => {
    const user = userEvent.setup()
    renderDialog({ state: sharingState({ visibility: 'project' }) })

    await user.click(screen.getByRole('combobox', { name: 'Who can see this' }))
    await user.click(screen.getByRole('option', { name: /Only me/ }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(setVisibility).not.toHaveBeenCalled()
  })

  test('a reader who cannot manage gets the statement, not the control', () => {
    renderDialog({ state: sharingState({ canManage: false, myRole: 'viewer' }) })

    expect(screen.queryByRole('combobox', { name: 'Who can see this' })).toBeNull()
    // The overview then carries the visibility chip instead.
    expect(screen.getByTestId('access-chip')).toBeInTheDocument()
  })
})

describe('ShareDialog — per-person controls', () => {
  test('an explicitly granted person gets a role control labelled with their name', async () => {
    const user = userEvent.setup()
    renderDialog()

    // One control per row, and it does NOT restate the role — the group heading
    // above the row already says it. Opening the menu is how the role is changed.
    await user.click(screen.getByRole('button', { name: 'Manage access: Anna Weber' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Can view' }))

    expect(changeRole).toHaveBeenCalledWith('u-anna', 'viewer')
  })

  test('removing access is confirmed, and says what survives it', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('button', { name: 'Manage access: Anna Weber' }))
    await user.click(await screen.findByRole('menuitem', { name: /Remove access/ }))

    expect(await screen.findByText('Remove Anna Weber?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'They lose access immediately. Anything they wrote stays in the conversation.',
      ),
    ).toBeInTheDocument()
    expect(revoke).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Remove access' }))
    expect(revoke).toHaveBeenCalledWith('u-anna')
  })

  test('visibility-derived rows get NO controls — there is no per-person deny', () => {
    renderDialog({
      state: sharingState({
        visibility: 'project',
        entries: [
          entry(ME, 'Matthias Bigl', 'owner', 'creator'),
          entry('u-klaus', 'Klaus Berger', 'collaborator', 'visibility-project'),
        ],
      }),
    })

    // The row is present and explains itself…
    expect(screen.getByText('Klaus Berger')).toBeInTheDocument()
    expect(screen.getByText('Project member')).toBeInTheDocument()
    // …but promises nothing the model cannot do.
    expect(screen.queryByRole('button', { name: 'Manage access: Klaus Berger' })).toBeNull()
  })

  test('the reader’s own row has no remove button — leaving is its own action', () => {
    renderDialog()

    expect(screen.queryByRole('button', { name: /Remove access: Matthias Bigl/ })).toBeNull()
  })

  test('controls are disabled while a mutation is in flight', () => {
    renderDialog({ saving: true })

    expect(screen.getByRole('button', { name: 'Manage access: Anna Weber' })).toBeDisabled()
  })
})

describe('ShareDialog — invite', () => {
  test('invites a candidate as a contributor', async () => {
    useShareCandidatesMock.mockReturnValue({
      candidates: [candidate('u-sabine', 'Sabine Gruber')],
      loading: false,
    })
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('button', { name: 'Invite: Sabine Gruber' }))
    expect(grant).toHaveBeenCalledWith('u-sabine')
  })

  test('filters candidates by name or email', async () => {
    useShareCandidatesMock.mockReturnValue({
      candidates: [candidate('u-sabine', 'Sabine Gruber'), candidate('u-klaus', 'Klaus Berger')],
      loading: false,
    })
    const user = userEvent.setup()
    renderDialog()

    await user.type(screen.getByRole('textbox', { name: 'Invite someone' }), 'klaus')

    expect(screen.getByText('Klaus Berger')).toBeInTheDocument()
    expect(screen.queryByText('Sabine Gruber')).toBeNull()
  })

  test('a colleague outside the project is SHOWN, disabled, with the reason (SH-19)', () => {
    useShareCandidatesMock.mockReturnValue({
      candidates: [candidate('u-eva', 'Eva Ritter', { needsProjectAccess: true })],
      loading: false,
    })
    renderDialog()

    // Never hidden: an invite picker that silently omits a colleague reads as a bug.
    expect(screen.getByText('Eva Ritter')).toBeInTheDocument()
    expect(screen.getByText('Not in this project yet')).toBeInTheDocument()
    // The reason is still stated — once, below the list, rather than as a
    // paragraph inside the row.
    expect(within(screen.getByTestId('share-blocked-note')).getByText(
      'Add them to the project first. Sharing a chat never grants access to the project itself.',
    )).toBeInTheDocument()
    // Stronger than "disabled": there is no invite control on this row at all. A
    // greyed-out button is a promise that pressing it might one day work here,
    // and it never will until someone adds Eva to the project elsewhere.
    expect(screen.queryByRole('button', { name: 'Invite: Eva Ritter' })).toBeNull()

    // The identifying detail survives. It used to be replaced by the explanation,
    // which is precisely the row where the reader most needs to be sure WHO this is.
    const row = screen.getByText('Eva Ritter').closest('[data-testid="share-candidate"]')
    expect(within(row as HTMLElement).getByText('u-eva@example.com')).toBeInTheDocument()
  })

  test('the blocked-row reason is stated once, however many rows are blocked', () => {
    useShareCandidatesMock.mockReturnValue({
      candidates: [
        candidate('u-eva', 'Eva Ritter', { needsProjectAccess: true }),
        candidate('u-tom', 'Tom Fischer', { needsProjectAccess: true }),
      ],
      loading: false,
    })
    renderDialog()

    expect(screen.getAllByTestId('share-candidate')).toHaveLength(2)
    expect(screen.getAllByTestId('share-blocked-note')).toHaveLength(1)
  })

  test('no note when nothing is blocked — it explains a state that is not on screen', () => {
    useShareCandidatesMock.mockReturnValue({
      candidates: [candidate('u-sabine', 'Sabine Gruber')],
      loading: false,
    })
    renderDialog()

    expect(screen.queryByTestId('share-blocked-note')).toBeNull()
  })

  /**
   * One person, one place (rule 7).
   *
   * A grant holder used to get a role control in the roster AND a second one beside
   * their invite row: two controls for one person's role in one dialog, which reads
   * as a bug because it is one. The roster is the home — role and removal live there
   * — so the invite list is only ever "who else could be added".
   */
  test('a person who already has access is not repeated in the invite list', () => {
    useShareCandidatesMock.mockReturnValue({
      candidates: [
        candidate('u-anna', 'Anna Weber', { alreadyHasAccess: true }),
        candidate('u-sabine', 'Sabine Gruber'),
      ],
      loading: false,
    })
    renderDialog()

    // Only the person who is NOT on the roster is offered.
    const rows = screen.getAllByTestId('share-candidate')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('Sabine Gruber')

    // Anna is on screen exactly once, with exactly one control: her roster row.
    expect(screen.getAllByRole('button', { name: 'Manage access: Anna Weber' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Invite: Anna Weber' })).toBeNull()
  })

  test('no person appears in both the roster and the invite list', () => {
    // Includes the harder case: a project member whose access is DERIVED, so the
    // server does not flag them `alreadyHasAccess` — the roster is still where they
    // are accounted for.
    useShareCandidatesMock.mockReturnValue({
      candidates: [
        candidate('u-anna', 'Anna Weber', { alreadyHasAccess: true }),
        candidate('u-klaus', 'Klaus Berger'),
        candidate('u-sabine', 'Sabine Gruber'),
        candidate('u-eva', 'Eva Ritter', { needsProjectAccess: true }),
      ],
      loading: false,
    })
    renderDialog({
      state: sharingState({
        visibility: 'project',
        entries: [
          entry(ME, 'Matthias Bigl', 'owner', 'creator'),
          entry('u-anna', 'Anna Weber', 'collaborator', 'grant', ME),
          entry('u-klaus', 'Klaus Berger', 'collaborator', 'visibility-project'),
        ],
      }),
    })

    const rosterText = screen.getAllByTestId('access-row').map((row) => row.textContent ?? '')
    const inviteText = screen.getAllByTestId('share-candidate').map((row) => row.textContent ?? '')

    for (const name of ['Matthias Bigl', 'Anna Weber', 'Klaus Berger', 'Sabine Gruber', 'Eva Ritter']) {
      const inRoster = rosterText.some((text) => text.includes(name))
      const inInvites = inviteText.some((text) => text.includes(name))
      expect(inRoster && inInvites, `${name} appears in both lists`).toBe(false)
    }

    // …and the deliberate SH-19 row is still there: visible, named, not invitable.
    expect(inviteText.some((text) => text.includes('Eva Ritter'))).toBe(true)
    expect(screen.queryByRole('button', { name: 'Invite: Eva Ritter' })).toBeNull()
    expect(screen.getByTestId('share-blocked-note')).toBeInTheDocument()
  })

  test('an empty candidate set says so', () => {
    renderDialog()

    expect(screen.getByText('Nobody left to invite.')).toBeInTheDocument()
  })

  test('a reader who cannot manage gets no invite surface at all', () => {
    renderDialog({ state: sharingState({ canManage: false, myRole: 'collaborator' }) })

    expect(screen.queryByRole('textbox', { name: 'Invite someone' })).toBeNull()
  })
})

describe('ShareDialog — leaving and escalation', () => {
  test('a non-owner participant can leave, and the dialog closes once they have', async () => {
    const user = userEvent.setup()
    const { onOpenChange } = renderDialog({
      state: sharingState({ myRole: 'collaborator', canManage: false }),
    })

    await user.click(screen.getByRole('button', { name: 'Leave this conversation' }))
    expect(await screen.findByText('Leave this conversation?')).toBeInTheDocument()
    expect(screen.getByText('You lose access. Everyone else keeps theirs.')).toBeInTheDocument()

    // The confirm button carries the same label; the last match is the dialog's.
    const confirms = screen.getAllByRole('button', { name: 'Leave this conversation' })
    await user.click(confirms[confirms.length - 1])

    expect(revoke).toHaveBeenCalledWith(ME)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  test('an owner is not offered Leave — ownership is transferred, not abandoned', () => {
    renderDialog()

    expect(screen.queryByRole('button', { name: 'Leave this conversation' })).toBeNull()
  })

  test('taking ownership is offered to an entitled admin, and says it is audited', async () => {
    const user = userEvent.setup()
    renderDialog({ state: sharingState({ canEscalate: true, canManage: false, myRole: null }) })

    expect(
      screen.getByText(
        'As a project admin you can take ownership of this conversation. This is recorded in the audit trail.',
      ),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Take ownership' }))
    expect(escalate).toHaveBeenCalledOnce()
  })

  test('escalation is absent for everyone else', () => {
    renderDialog()

    expect(screen.queryByRole('button', { name: 'Take ownership' })).toBeNull()
  })
})

describe('ShareDialog — refusals', () => {
  test('the last-owner invariant is explained in the user’s language', () => {
    renderDialog({ failure: { reason: 'last-owner', message: 'CONFLICT' } })

    expect(screen.getByTestId('share-failure')).toHaveTextContent(
      'This conversation must keep at least one owner. Make someone else an owner first.',
    )
  })

  test('a missing project membership is explained as such', () => {
    renderDialog({ failure: { reason: 'container-access-required', message: null } })

    expect(screen.getByTestId('share-failure')).toHaveTextContent(
      'That person is not a member of this project yet. Add them to the project first.',
    )
  })

  test('an unrecognised refusal still surfaces — a failed change never looks like it worked', () => {
    renderDialog({ failure: { reason: null, message: null } })

    expect(screen.getByTestId('share-failure')).toHaveTextContent(
      'That change could not be saved.',
    )
  })

  test('the roster is unchanged by a refusal (the hook is non-optimistic)', () => {
    renderDialog({ failure: { reason: 'last-owner', message: null } })

    expect(screen.getAllByTestId('access-row')).toHaveLength(2)
  })
})

describe('ShareDialog — the row menu states the current role', () => {
  /**
   * The select this replaced DISPLAYED the current role. Losing that would be a
   * real regression for anyone who cannot see the group heading above the row —
   * the checked radio is what carries it now, and a screen reader reads it.
   */
  test('the current role is the checked option, not merely the default', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('button', { name: 'Manage access: Anna Weber' }))

    // Anna is a collaborator, so "Can contribute" is checked and the others are not.
    expect(await screen.findByRole('menuitemradio', { name: 'Can contribute' })).toBeChecked()
    expect(screen.getByRole('menuitemradio', { name: 'Can view' })).not.toBeChecked()
    expect(screen.getByRole('menuitemradio', { name: 'Owner' })).not.toBeChecked()
  })
})
