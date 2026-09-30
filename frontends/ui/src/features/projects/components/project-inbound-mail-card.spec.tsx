import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { toast } from 'sonner'
import { I18nProvider } from '@/i18n'
import type {
  InboundAddressResponse,
  RotateInboundAddressResponse,
} from '@/lib/inbound-mail/contract'
import { ProjectInboundMailCard } from './project-inbound-mail-card'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const ADDRESS = 'wohnbau-mariahilf.k7m2qx4hz9ab@piloti-post.at'
const ROTATED = 'wohnbau-mariahilf.p3v6wn2cjt5d@piloti-post.at'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/**
 * A fetch that answers the two contract routes. Specs never reach the real
 * routes: those belong to the BFF and may not exist yet.
 */
function stubRoutes({
  get,
  rotate = { status: 200, body: { address: ROTATED } },
}: {
  get: { status: number; body: InboundAddressResponse | { error: string } }
  rotate?: { status: number; body: RotateInboundAddressResponse | { error: string } }
}) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/inbound-address/rotate') && init?.method === 'POST') {
      return json(rotate.status, rotate.body)
    }
    if (url.endsWith('/inbound-address')) return json(get.status, get.body)
    return json(404, { error: 'unexpected' })
  })
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

const ready = (canRotate: boolean) => ({
  get: { status: 200, body: { enabled: true, address: ADDRESS, canRotate } },
})

const rotateCalls = (fetchSpy: ReturnType<typeof stubRoutes>) =>
  fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/rotate'))

describe('ProjectInboundMailCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('shows the address and the rules', async () => {
    const fetchSpy = stubRoutes(ready(false))
    render(<ProjectInboundMailCard projectId="proj-1" />)

    const field = await screen.findByRole('group', { name: 'Project email address' })
    expect(field).toHaveTextContent(ADDRESS)
    expect(fetchSpy).toHaveBeenCalledWith('/api/projects/proj-1/inbound-address')

    const region = screen.getByRole('region', { name: 'Email inbox' })
    const rules = within(region).getByRole('list', { name: 'What applies' })
    expect(within(rules).getAllByRole('listitem')).toHaveLength(4)
    expect(rules).toHaveTextContent('25 MB')
    expect(rules).toHaveTextContent('DKIM')
  })

  test('links the public help page, in the reader’s language, in a new tab', async () => {
    stubRoutes(ready(false))
    const { unmount } = render(<ProjectInboundMailCard projectId="proj-1" />)

    const link = await screen.findByRole('link', { name: 'How it works, and why mail bounces' })
    expect(link).toHaveAttribute('href', 'https://piloti.at/en/e-mail-eingang/')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    unmount()

    render(
      <I18nProvider initialLocale="de" fixedLocale>
        <ProjectInboundMailCard projectId="proj-1" />
      </I18nProvider>
    )
    // The German URL is the one the bounce text of a refused mail carries.
    expect(
      await screen.findByRole('link', { name: 'Anleitung und Gründe für abgelehnte E-Mails' })
    ).toHaveAttribute('href', 'https://piloti.at/e-mail-eingang/')
  })

  test('copy puts the address on the clipboard and says so', async () => {
    stubRoutes(ready(false))
    const user = userEvent.setup()
    // After setup: user-event installs its own clipboard stub.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    render(<ProjectInboundMailCard projectId="proj-1" />)

    await user.click(await screen.findByRole('button', { name: 'Copy' }))

    expect(writeText).toHaveBeenCalledWith(ADDRESS)
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  test('a refused copy reports the failure and never says copied', async () => {
    stubRoutes(ready(false))
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    render(<ProjectInboundMailCard projectId="proj-1" />)

    await user.click(await screen.findByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not copy'))
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument()
  })

  test('rotation waits for confirmation, then shows the new address', async () => {
    const fetchSpy = stubRoutes(ready(true))
    const user = userEvent.setup()
    render(<ProjectInboundMailCard projectId="proj-1" />)

    await user.click(await screen.findByRole('button', { name: 'Generate new address' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('stops working immediately')
    expect(rotateCalls(fetchSpy)).toHaveLength(0)

    await user.click(within(dialog).getByRole('button', { name: 'Generate new address' }))

    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Project email address' })).toHaveTextContent(
        ROTATED
      )
    )
    expect(rotateCalls(fetchSpy)).toHaveLength(1)
    expect(rotateCalls(fetchSpy)[0][0]).toBe('/api/projects/proj-1/inbound-address/rotate')
    expect(toast.success).toHaveBeenCalledWith('New address generated')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  test('cancelling the confirmation rotates nothing', async () => {
    const fetchSpy = stubRoutes(ready(true))
    const user = userEvent.setup()
    render(<ProjectInboundMailCard projectId="proj-1" />)

    await user.click(await screen.findByRole('button', { name: 'Generate new address' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' })
    )

    expect(rotateCalls(fetchSpy)).toHaveLength(0)
    expect(screen.getByRole('group', { name: 'Project email address' })).toHaveTextContent(ADDRESS)
  })

  test('a failed rotation keeps the dialog and the old address', async () => {
    stubRoutes({ ...ready(true), rotate: { status: 500, body: { error: 'boom' } } })
    const user = userEvent.setup()
    render(<ProjectInboundMailCard projectId="proj-1" />)

    await user.click(await screen.findByRole('button', { name: 'Generate new address' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Generate new address' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // By text: the open dialog marks the page behind it aria-hidden.
    expect(screen.getByText(ADDRESS)).toBeInTheDocument()
  })

  test('without canRotate there is no rotate control', async () => {
    stubRoutes(ready(false))
    render(<ProjectInboundMailCard projectId="proj-1" />)

    await screen.findByRole('group', { name: 'Project email address' })
    expect(screen.queryByRole('button', { name: 'Generate new address' })).not.toBeInTheDocument()
  })

  test('draws nothing when the deployment has no inbound mail domain', async () => {
    const fetchSpy = stubRoutes({
      get: { status: 200, body: { enabled: false, address: null, canRotate: false } },
    })
    const { container } = render(<ProjectInboundMailCard projectId="proj-1" />)

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  test('draws nothing when the route refuses the caller', async () => {
    stubRoutes({ get: { status: 404, body: { error: 'Not found' } } })
    const { container } = render(<ProjectInboundMailCard projectId="proj-1" />)

    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  test('a failed load shows the error and retries on demand', async () => {
    const fetchSpy = stubRoutes({ get: { status: 500, body: { error: 'boom' } } })
    const user = userEvent.setup()
    render(<ProjectInboundMailCard projectId="proj-1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')

    fetchSpy.mockImplementation(async () =>
      json(200, { enabled: true, address: ADDRESS, canRotate: false })
    )
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('group', { name: 'Project email address' })).toHaveTextContent(
      ADDRESS
    )
  })

  test('an answer outside the contract is an error, not an empty field', async () => {
    stubRoutes({
      get: { status: 200, body: { enabled: true } as unknown as InboundAddressResponse },
    })
    render(<ProjectInboundMailCard projectId="proj-1" />)

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Project email address' })).not.toBeInTheDocument()
  })
})
