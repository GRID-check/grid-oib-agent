/**
 * The project's mail address where people learn it: copyable in full, saved
 * as a contact, replaced only behind a warning that says every follow ends,
 * offered to a manager only; and the states without an address.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
const download = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock('@/lib/browser-download', () => ({ startBrowserDownload: download.start, downloadFetched: vi.fn() }))

import { toast } from 'sonner'
import { render, screen, waitFor } from '@/test-utils'
import { ADDRESS_VARIANTS, PROJECT_ID, PROJECT_NAME, fixtureAddressClient } from '@/app/dev/inbound-mail/fixtures'
import { InboundMailAddressCard, InboundMailAddressDialog } from './inbound-mail-address'

beforeEach(() => {
  vi.clearAllMocks()
  URL.createObjectURL = vi.fn(() => 'blob:card')
  URL.revokeObjectURL = vi.fn()
})

describe('InboundMailAddressCard', () => {
  it('shows the address whole and saves it as a contact', async () => {
    render(<InboundMailAddressCard projectId={PROJECT_ID} projectName={PROJECT_NAME} client={fixtureAddressClient(ADDRESS_VARIANTS.manager)} />)
    expect(await screen.findByText('bauplatz-12.k3x7q2m9p4ab@piloti.at')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('address-save-contact'))
    expect(download.start).toHaveBeenCalledWith('blob:card', 'piloti-bauplatz-12-wohnbau-seestadt.vcf')
  })

  it('replaces the address behind a warning that says every follow ends', async () => {
    const client = fixtureAddressClient(ADDRESS_VARIANTS.manager)
    const rotate = vi.spyOn(client, 'rotate')
    render(<InboundMailAddressCard projectId={PROJECT_ID} projectName={PROJECT_NAME} client={client} />)
    await userEvent.click(await screen.findByTestId('address-rotate'))
    expect(screen.getByText(/stops following it/)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('address-rotate-confirm'))
    await waitFor(() => expect(rotate).toHaveBeenCalledWith(PROJECT_ID))
    expect(toast.success).toHaveBeenCalledWith('New address created')
    expect(await screen.findByText('bauplatz-12.w8n2c4r7t1qz@piloti.at')).toBeInTheDocument()
  })

  it('offers a member no way to change it', async () => {
    render(<InboundMailAddressCard projectId={PROJECT_ID} projectName={PROJECT_NAME} client={fixtureAddressClient(ADDRESS_VARIANTS.member)} />)
    await screen.findByTestId('inbound-mail-address')
    expect(screen.queryByTestId('address-rotate')).not.toBeInTheDocument()
    expect(screen.queryByTestId('address-switch-off')).not.toBeInTheDocument()
  })

  it('lets a manager create a missing address, and tells a member whom to ask', async () => {
    const client = fixtureAddressClient(ADDRESS_VARIANTS.off)
    const create = vi.spyOn(client, 'create')
    const { unmount } = render(<InboundMailAddressCard projectId={PROJECT_ID} projectName={PROJECT_NAME} client={client} />)
    await userEvent.click(await screen.findByTestId('address-create'))
    await waitFor(() => expect(create).toHaveBeenCalled())
    unmount()
    render(<InboundMailAddressCard projectId={PROJECT_ID} projectName={PROJECT_NAME} client={fixtureAddressClient(ADDRESS_VARIANTS['off-member'])} />)
    expect(await screen.findByText(/Ask someone who manages the project/)).toBeInTheDocument()
  })

  it('says when this installation receives no mail, and when the address failed to load', async () => {
    const { unmount } = render(<InboundMailAddressCard projectId={PROJECT_ID} projectName={PROJECT_NAME} client={fixtureAddressClient(ADDRESS_VARIANTS.unavailable)} />)
    expect(await screen.findByTestId('address-unavailable')).toBeInTheDocument()
    unmount()
    render(<InboundMailAddressCard projectId={PROJECT_ID} projectName={PROJECT_NAME} client={fixtureAddressClient('error')} />)
    expect(await screen.findByText('The project mail address could not be loaded.')).toBeInTheDocument()
  })

  it('says how often the office’s own mail arrives confirmed, or that its domain signs nothing', async () => {
    const { unmount } = render(<InboundMailAddressCard projectId={PROJECT_ID} projectName={PROJECT_NAME} client={fixtureAddressClient(ADDRESS_VARIANTS.manager)} />)
    expect(await screen.findByTestId('own-domain-dkim')).toHaveTextContent('94 % of your office’s mail')
    unmount()
    render(<InboundMailAddressCard projectId={PROJECT_ID} projectName={PROJECT_NAME} client={fixtureAddressClient(ADDRESS_VARIANTS['own-dkim-missing'])} />)
    expect(await screen.findByTestId('own-domain-dkim')).toHaveAttribute('data-state', 'missing')
  })
})

describe('InboundMailAddressDialog', () => {
  it('reads the address only while open, and shows the rules', async () => {
    const client = fixtureAddressClient(ADDRESS_VARIANTS.manager)
    const get = vi.spyOn(client, 'get')
    const { rerender } = render(<InboundMailAddressDialog projectId={PROJECT_ID} projectName={PROJECT_NAME} open={false} onOpenChange={vi.fn()} client={client} />)
    expect(get).not.toHaveBeenCalled()
    rerender(<InboundMailAddressDialog projectId={PROJECT_ID} projectName={PROJECT_NAME} open onOpenChange={vi.fn()} client={client} />)
    expect(await screen.findByText('Nothing is filed until a person confirms it.')).toBeInTheDocument()
    expect(get).toHaveBeenCalledTimes(1)
  })
})
