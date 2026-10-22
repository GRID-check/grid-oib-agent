/**
 * Dateien › E-Mail-Eingang: the list beside the open mail, its states, the
 * keyboard (J/K walk, X selects, Enter opens, ⌫ asks to dismiss the
 * selection), and the bulk filing that is only offered for complete mails.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/app/projects/p/files/mail',
  useSearchParams: () => new URLSearchParams(),
}))

import { act, fireEvent, render, screen, waitFor, within } from '@/test-utils'
import {
  ADDRESS_VARIANTS,
  DETAIL_VARIANTS,
  FIXTURE_NOW,
  FOLDERS,
  LIST_VARIANTS,
  PROJECT_ID,
  PROJECT_NAME,
  fixtureAddressClient,
  fixtureClient,
} from '@/app/dev/inbound-mail/fixtures'
import { resetInboundMailWaitingForTests } from '../hooks/use-inbound-mail-waiting'
import { InboundMailWorkspace } from './inbound-mail-workspace'

function renderWorkspace(variant: string, overrides: Partial<Parameters<typeof InboundMailWorkspace>[0]> = {}) {
  const fixture = LIST_VARIANTS[variant]
  const client = fixtureClient({ list: fixture })
  const status = fixture.status ?? 'waiting'
  render(
    <InboundMailWorkspace
      projectId={PROJECT_ID}
      projectName={PROJECT_NAME}
      projectClosed={fixture.closed ?? false}
      folders={FOLDERS}
      status={status}
      outcome={fixture.outcome ?? null}
      initialList={fixture.load ? null : { items: fixture.items.filter((item) => item.status === status), nextCursor: fixture.nextCursor ?? null }}
      initialListFailed={fixture.load === 'error'}
      mailId={null}
      initialMail={null}
      client={client}
      addressClient={fixtureAddressClient(
        fixture.everReceived === false ? { ...(ADDRESS_VARIANTS.manager as Exclude<(typeof ADDRESS_VARIANTS)['manager'], string>), lastReceivedAt: null } : ADDRESS_VARIANTS.manager
      )}
      now={FIXTURE_NOW}
      initialChecked={fixture.checked}
      {...overrides}
    />
  )
  return { client }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetInboundMailWaitingForTests()
})

describe('InboundMailWorkspace', () => {
  it('groups a conversation with one button that files it as suggested', async () => {
    renderWorkspace('selected')
    const group = screen.getByRole('region', { name: /Mail thread “Stellplatznachweis” · 4 new mails/ })
    expect(within(group).getByTestId('thread-group-file')).toHaveTextContent('File 4 mails in mail thread “Stellplatznachweis” (becomes revision 7)')
    await userEvent.click(within(group).getByTestId('thread-group-file'))
    const destinations = await screen.findByTestId('bulk-destinations')
    expect(destinations).toHaveTextContent('In mail thread “Stellplatznachweis”: 4')
    expect(destinations).toHaveTextContent('In “Tragwerk”: 1')
  })

  it('opens the first mail of a group that cannot go in one press', async () => {
    renderWorkspace('thread-group')
    const group = screen.getByRole('region', { name: /4 new mails/ })
    await userEvent.click(within(group).getByTestId('thread-group-file'))
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(expect.stringContaining('/files/mail/')))
    expect(screen.queryByTestId('bulk-destinations')).not.toBeInTheDocument()
  })

  it('keeps unconfirmed and automatic mail in a quiet group, listed when opened', async () => {
    renderWorkspace('unverified-group')
    const toggle = screen.getByTestId('quiet-group-toggle')
    expect(toggle).toHaveTextContent('Domain not verified or automatic (2)')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(within(screen.getByTestId('quiet-group')).getAllByTestId('inbound-mail-row-link')).toHaveLength(2)
  })

  it('teaches the address when nothing ever arrived, and says „all done“ otherwise', async () => {
    renderWorkspace('empty')
    expect(await screen.findByTestId('inbound-mail-never')).toHaveTextContent('No mail to this project yet')
    expect(await screen.findByTestId('inbound-mail-address')).toHaveTextContent('bauplatz-12.k3x7q2m9p4ab@piloti.at')
  })

  it('says „nothing waits“ for a project that had mail', async () => {
    renderWorkspace('done')
    expect(await screen.findByText('Nothing waits to be filed')).toBeInTheDocument()
  })

  it('says a failed list in its own words', () => {
    renderWorkspace('error')
    expect(screen.getByText('Project mail could not be loaded.')).toBeInTheDocument()
  })

  it('walks the rows with J and K, selects with X and opens with Enter', async () => {
    renderWorkspace('one')
    const id = DETAIL_VARIANTS['member-verified'].view.id
    fireEvent.keyDown(window, { key: 'j' })
    expect(await screen.findByTestId(`inbound-mail-row-${id}`)).toHaveAttribute('data-focused', 'true')
    fireEvent.keyDown(window, { key: 'x' })
    expect(within(screen.getByTestId(`inbound-mail-row-${id}`)).getByTestId('inbound-mail-row-checkbox')).toBeChecked()
    expect(await screen.findByTestId('inbound-mail-selection-bar')).toHaveTextContent('1 selected')
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(nav.push).toHaveBeenCalledWith(expect.stringContaining(`/files/mail/${id}`))
  })

  it('ignores the keys while the person types', () => {
    renderWorkspace('one')
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'j' })
    expect(screen.getByTestId(`inbound-mail-row-${DETAIL_VARIANTS['member-verified'].view.id}`)).not.toHaveAttribute('data-focused')
    input.remove()
  })

  it('offers „File as suggested“ only when every selected mail is complete, and says why not', async () => {
    renderWorkspace('bulk-blocked')
    const file = await screen.findByTestId('selection-file')
    await waitFor(() => expect(screen.getByTestId('selection-why')).toHaveAccessibleName(/needs its sender confirmed/))
    expect(file).toBeDisabled()
  })

  it('files a complete selection after a confirmation grouped by destination', async () => {
    const { client } = renderWorkspace('selected')
    const file = vi.spyOn(client, 'file')
    await waitFor(() => expect(screen.getByTestId('selection-file')).toBeEnabled())
    await userEvent.click(screen.getByTestId('selection-file'))
    expect(await screen.findByTestId('bulk-destinations')).toHaveTextContent('In mail thread “Stellplatznachweis”: 2')
    await userEvent.click(screen.getByTestId('bulk-file-confirm'))
    await waitFor(() => expect(file).toHaveBeenCalled())
    const body = file.mock.calls[0][1]
    expect(body.mails).toHaveLength(2)
    for (const decision of body.mails) {
      expect(decision).not.toHaveProperty('acknowledgeSender')
      expect(decision).not.toHaveProperty('acknowledgeRisk')
    }
  })

  it('asks before dismissing a selection with ⌫', async () => {
    renderWorkspace('selected')
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Backspace' })
    })
    expect(await screen.findByText('Dismiss 2 mails?')).toBeInTheDocument()
  })

  it('switches to the handled list by replacing the URL', async () => {
    renderWorkspace('one')
    await userEvent.click(screen.getByTestId('filter-handled'))
    expect(nav.replace).toHaveBeenCalledWith(expect.stringContaining('status=handled'))
  })

  it('says a closed project above the rows', () => {
    renderWorkspace('closed')
    expect(screen.getByTestId('inbound-mail-closed')).toHaveTextContent('The project is closed – reopen it to file')
  })
})
