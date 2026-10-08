import { fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadLogView } from './download-log-view'
import { DownloadLogRetentionForm } from './download-log-retention-form'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { toast } from 'sonner'

const PEOPLE = [
  { id: 'user_01', name: 'Anna Weber', email: 'anna@buero.at' },
  { id: 'user_02', name: null, email: 'klaus@buero.at' },
]

const entry = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `e${n}`,
  occurredAt: `2026-10-0${n}T10:00:00.000Z`,
  userId: 'user_01',
  person: { name: 'Anna Weber', email: 'anna@buero.at' },
  kind: 'download',
  access: 'download',
  scope: 'project',
  projectId: 'proj_1',
  projectName: 'Wohnbau Nord',
  documentId: `d${n}`,
  documentName: `Plan ${n}.pdf`,
  versionId: null,
  folderId: 'f1',
  folderPath: 'Pläne',
  ownList: false,
  nameWithheld: false,
  ...overrides,
})

function stubApi(respond: (url: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => respond(url)))
}
const page = (entries: unknown[], nextCursor: string | null = null) =>
  Response.json({ entries, nextCursor, retentionDays: 180 })
const lastUrl = (): string => String(vi.mocked(fetch).mock.calls.at(-1)?.[0])

describe('DownloadLogView', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('says what the log is for, how long it is kept and that reading it is recorded, before any row', async () => {
    stubApi(() => page([entry(1)]))
    render(<DownloadLogView people={PEOPLE} />)

    expect(await screen.findByText(/security and accountability/)).toBeInTheDocument()
    expect(screen.getByText(/not an activity report/)).toBeInTheDocument()
    expect(await screen.findByText(/kept for 180 days/)).toBeInTheDocument()
    expect(screen.getByText(/audit log records who looked/)).toBeInTheDocument()
  })

  it("says beside a closed project's file that its project is closed (ADR-0088)", async () => {
    stubApi(() => page([entry(1, { projectStatus: 'closed' }), entry(2, { projectStatus: 'active', projectName: 'Lände 3' })]))
    render(<DownloadLogView people={PEOPLE} />)

    expect(await screen.findByText('Wohnbau Nord · closed')).toBeInTheDocument()
    expect(screen.queryByText('Lände 3 · closed')).not.toBeInTheDocument()
  })

  it('lists who, what, which document and where, and flags a folder with its own list', async () => {
    stubApi(() =>
      page([
        entry(1),
        entry(2, { kind: 'pdf', access: 'open', ownList: true, folderPath: 'Personal', documentName: 'Vertrag.pdf' }),
        entry(3, { userId: 'user_gone', person: null, scope: 'archiv', projectId: null, projectName: null, folderId: null, folderPath: null }),
        entry(4, { kind: 'version', access: 'open', ownList: true, versionId: '8f3a1c52-0000-4000-8000-000000000001' }),
      ])
    )
    render(<DownloadLogView people={PEOPLE} />)

    const rows = await screen.findAllByRole('row')
    // Header + four entries.
    expect(rows).toHaveLength(5)
    const second = rows[2]
    expect(within(second).getByText('Anna Weber (anna@buero.at)')).toBeInTheDocument()
    expect(within(second).getByText('Opened in the viewer')).toBeInTheDocument()
    expect(within(second).getByText('Vertrag.pdf')).toBeInTheDocument()
    expect(within(second).getByText(/Wohnbau Nord · Personal/)).toBeInTheDocument()
    expect(within(second).getByText('Own access list')).toBeInTheDocument()
    // Someone who has left is shown by id and said to have left; the Archiv has no folder.
    expect(within(rows[3]).getByText('user_gone')).toBeInTheDocument()
    expect(within(rows[3]).getByText('No longer in the organization')).toBeInTheDocument()
    expect(within(rows[3]).getByText('Office filing')).toBeInTheDocument()
    expect(within(rows[4]).getByText('Version 8f3a1c52')).toBeInTheDocument()
  })

  it('says a name was withheld, and names neither the document nor the folder, for a folder the viewer may not read', async () => {
    stubApi(() =>
      page([
        entry(1),
        entry(2, { kind: 'pdf', access: 'open', ownList: true, documentName: null, folderPath: null, nameWithheld: true }),
      ])
    )
    render(<DownloadLogView people={PEOPLE} />)

    const rows = await screen.findAllByRole('row')
    expect(within(rows[1]).queryByTestId('download-log-name-withheld')).toBeNull()
    expect(within(rows[2]).getByTestId('download-log-name-withheld')).toHaveTextContent('Name withheld')
    expect(within(rows[2]).getByText(/Wohnbau Nord · a folder you may not read/)).toBeInTheDocument()
    expect(within(rows[2]).queryByText(/Folder no longer exists/)).toBeNull()
  })

  it('shows no total, no ranking and no chart: it is a list of events', async () => {
    stubApi(() => page([entry(1), entry(2)]))
    render(<DownloadLogView people={PEOPLE} />)

    await screen.findAllByRole('row')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.queryByText(/total|most|top|ranking|per person/i)).not.toBeInTheDocument()
  })

  it('sends the typed filters, with the first page again', async () => {
    stubApi(() => page([entry(1)]))
    render(<DownloadLogView people={PEOPLE} />)
    await screen.findAllByRole('row')

    fireEvent.change(screen.getByLabelText('Document'), { target: { value: 'Werkvertrag' } })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))

    await waitFor(() => expect(lastUrl()).toContain('document=Werkvertrag'))
    expect(lastUrl()).toContain('from=2026-09-01')
    expect(lastUrl()).toContain('to=2026-09-30')
    expect(lastUrl()).not.toContain('cursor')
  })

  it('pages: older entries are appended, with the cursor the server gave', async () => {
    stubApi((url) => (url.includes('cursor=c2') ? page([entry(1)]) : page([entry(3), entry(2)], 'c2')))
    render(<DownloadLogView people={PEOPLE} />)
    await screen.findAllByRole('row')
    expect(screen.getAllByRole('row')).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: 'Show older entries' }))

    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(4))
    expect(lastUrl()).toContain('cursor=c2')
    expect(screen.queryByRole('button', { name: 'Show older entries' })).not.toBeInTheDocument()
  })

  it('says so when nothing matches', async () => {
    stubApi(() => page([]))
    render(<DownloadLogView people={PEOPLE} />)

    expect(await screen.findByTestId('download-log-empty')).toBeInTheDocument()
  })

  it('shows the failure and no rows when the read is refused, and retries', async () => {
    let refuse = true
    stubApi(() => (refuse ? Response.json({ error: { message: 'x' } }, { status: 503 }) : page([entry(1)])))
    render(<DownloadLogView people={PEOPLE} />)

    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    refuse = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findAllByRole('row')).toHaveLength(2)
  })
})

describe('DownloadLogRetentionForm', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('saves a valid number of days', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ days: 90, previous: 365 })))
    render(<DownloadLogRetentionForm initialDays={365} />)

    fireEvent.change(screen.getByLabelText('Days'), { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save retention' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/organization/download-log/retention')
    expect(JSON.parse(String(init.body))).toEqual({ days: 90 })
  })

  it.each(['29', '366', '', '90.5'])('does not offer to save %j', (value) => {
    vi.stubGlobal('fetch', vi.fn())
    render(<DownloadLogRetentionForm initialDays={365} />)

    fireEvent.change(screen.getByLabelText('Days'), { target: { value } })

    expect(screen.getByRole('button', { name: 'Save retention' })).toBeDisabled()
    expect(screen.getByText('Enter a whole number of days from 30 to 365.')).toBeInTheDocument()
  })

  it('does not offer to save what is already saved', () => {
    render(<DownloadLogRetentionForm initialDays={180} />)

    expect(screen.getByRole('button', { name: 'Save retention' })).toBeDisabled()
  })

  it('says so when the server refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'no' } }, { status: 403 })))
    render(<DownloadLogRetentionForm initialDays={365} />)

    fireEvent.change(screen.getByLabelText('Days'), { target: { value: '60' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save retention' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })
})
