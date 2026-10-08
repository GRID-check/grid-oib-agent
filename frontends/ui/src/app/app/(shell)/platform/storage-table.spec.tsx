import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { toast } from 'sonner'
import { PlatformAccessProvider } from '@/features/platform/platform-access'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { PlatformStorageTable, readQuotaInput, readUploadLimitInput } from './storage-table'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const GB = 1e9
const MB = 1e6
const STORAGE = {
  organizations: [
    {
      organizationId: 'org_acme',
      displayName: 'Acme Architektur',
      usedBytes: 52.6 * GB,
      documents: 1720,
      quotaBytes: 50 * GB,
      inherited: false,
      maxUploadFileBytes: 250 * MB,
      effectiveMaxUploadFileBytes: 250 * MB,
    },
    {
      organizationId: 'org_new',
      displayName: null,
      usedBytes: 240e6,
      documents: 1,
      quotaBytes: 50 * GB,
      inherited: true,
      maxUploadFileBytes: null,
      effectiveMaxUploadFileBytes: 100 * MB,
    },
  ],
  totals: { usedBytes: 52.84 * GB, documents: 1721, organizations: 2 },
  uploadLimit: { defaultBytes: 100 * MB, minBytes: MB, ceilingBytes: 250 * MB },
}

const json = (body: unknown, status = 200) => Response.json(body, { status })
const fetchMock = vi.fn()
const puts = () =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')

const openEditor = async (org = 'Acme Architektur') => {
  await userEvent.click(await screen.findByRole('button', { name: `Edit limits for ${org}` }))
  return screen.getByRole('textbox', { name: `Quota for ${org}, in GB` })
}

const uploadLimitInput = (org = 'Acme Architektur') =>
  screen.getByRole('textbox', { name: `Max. file size for ${org}, in MB` })

const putTo = (suffix: string) =>
  puts().filter(([url]) => String(url).endsWith(suffix))

describe('PlatformStorageTable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(json(STORAGE))
  })

  test('renders the rows in the Table atom, counts formatted, and labels the actions column', async () => {
    render(<PlatformStorageTable />)
    const table = await screen.findByRole('table')

    expect(within(table).getByText('1,720 documents')).toBeDefined()
    expect(within(table).getByText('1 document')).toBeDefined()
    expect(within(table).getByRole('columnheader', { name: 'Actions' })).toBeDefined()
    for (const header of within(table).getAllByRole('columnheader')) {
      expect(header.textContent?.trim()).not.toBe('')
    }
  })

  test('an initial load failure is a retryable error, not an empty state titled with it', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500)).mockResolvedValueOnce(json(STORAGE))
    render(<PlatformStorageTable />)

    const error = await screen.findByTestId('platform-storage-error')
    expect(error).toHaveAttribute('role', 'alert')
    expect(error).toHaveTextContent('Could not load storage usage.')
    await userEvent.click(within(error).getByRole('button', { name: /Retry/ }))

    expect(await screen.findByText('Acme Architektur')).toBeDefined()
  })

  test.each(['12x', '0x10', '1e3', 'ten'])(
    'refuses %s as a field error, never sending it as unlimited',
    async (value) => {
      render(<PlatformStorageTable />)
      const input = await openEditor()
      await userEvent.clear(input)
      await userEvent.type(input, `${value}{Enter}`)

      expect(
        screen.getByText('Enter a quota in GB above zero, or leave the field empty for no limit.')
      ).toBeDefined()
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(puts()).toHaveLength(0)
    }
  )

  test('is a text field, so an unparseable entry cannot arrive as an empty (= unlimited) value', async () => {
    render(<PlatformStorageTable />)
    const input = await openEditor()
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveAttribute('inputmode', 'decimal')
  })

  test('reads a German decimal comma', async () => {
    fetchMock
      .mockResolvedValueOnce(json(STORAGE))
      .mockResolvedValueOnce(json({ quotaBytes: 60.5 * GB }))
      .mockResolvedValueOnce(json(STORAGE))
    render(<PlatformStorageTable />)
    const input = await openEditor()
    await userEvent.clear(input)
    await userEvent.type(input, '60,5{Enter}')

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(JSON.parse(String((puts()[0][1] as RequestInit).body))).toEqual({
      quotaBytes: 60.5 * GB,
    })
  })

  test('Escape cancels the inline editor', async () => {
    render(<PlatformStorageTable />)
    const input = await openEditor()
    await userEvent.type(input, '{Escape}')

    expect(screen.queryByTestId('quota-editor')).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit limits for Acme Architektur' })).toBeDefined()
  })

  test('a refused save leads with the translated reason; the server text is only the detail', async () => {
    fetchMock
      .mockResolvedValueOnce(json(STORAGE))
      .mockResolvedValueOnce(json({ error: 'quota below usage' }, 422))
    render(<PlatformStorageTable />)
    const input = await openEditor()
    await userEvent.clear(input)
    await userEvent.type(input, '10{Enter}')

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'That quota is below what the organization already stores. Free space first.',
        { description: 'quota below usage' }
      )
    )
  })

  test('a failed reload after a save keeps the rows and says they may be stale', async () => {
    fetchMock
      .mockResolvedValueOnce(json(STORAGE))
      .mockResolvedValueOnce(json({ quotaBytes: 60 * GB }))
      .mockResolvedValueOnce(json({}, 500))
    render(<PlatformStorageTable />)
    const input = await openEditor()
    await userEvent.clear(input)
    await userEvent.type(input, '60{Enter}')

    expect(await screen.findByText(/Could not refresh storage usage/)).toBeDefined()
    expect(screen.getByText('Acme Architektur')).toBeDefined()
  })

  test('shows each organization\'s max. file size, and "Default (…)" where it has none', async () => {
    render(<PlatformStorageTable />)
    const table = await screen.findByRole('table')

    expect(within(table).getByRole('columnheader', { name: 'Max. file size' })).toBeDefined()
    const cells = within(table).getAllByTestId('upload-limit-cell')
    expect(cells.map((cell) => cell.textContent)).toEqual(['250 MB', 'Default (100 MB)'])
    expect(screen.getByText(/At most 250 MB/)).toBeDefined()
  })

  test('saving only a new file size writes the upload limit and leaves an inherited quota alone', async () => {
    fetchMock
      .mockResolvedValueOnce(json(STORAGE))
      .mockResolvedValueOnce(json({ maxUploadFileBytes: 150 * MB }))
      .mockResolvedValueOnce(json(STORAGE))
    render(<PlatformStorageTable />)
    // org_new inherits its quota, so its quota field opens blank, and blank is
    // UNLIMITED: sending it would silently lift the quota.
    await openEditor('org_new')
    await userEvent.type(uploadLimitInput('org_new'), '150{Enter}')

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Limits updated.'))
    expect(putTo('/storage')).toHaveLength(0)
    expect(putTo('/org_new/upload-limit')).toHaveLength(1)
    expect(JSON.parse(String((putTo('/upload-limit')[0][1] as RequestInit).body))).toEqual({
      maxUploadFileBytes: 150 * MB,
    })
  })

  test('clearing the file size sends null, back to the default', async () => {
    fetchMock
      .mockResolvedValueOnce(json(STORAGE))
      .mockResolvedValueOnce(json({ maxUploadFileBytes: null }))
      .mockResolvedValueOnce(json(STORAGE))
    render(<PlatformStorageTable />)
    await openEditor()
    expect(uploadLimitInput()).toHaveValue('250')
    await userEvent.clear(uploadLimitInput())
    await userEvent.type(uploadLimitInput(), '{Enter}')

    await waitFor(() => expect(putTo('/upload-limit')).toHaveLength(1))
    expect(JSON.parse(String((putTo('/upload-limit')[0][1] as RequestInit).body))).toEqual({
      maxUploadFileBytes: null,
    })
    expect(putTo('/storage')).toHaveLength(0)
  })

  test.each(['900', '0,5', '12x'])(
    'refuses a file size of %s MB as a field error and sends nothing',
    async (value) => {
      render(<PlatformStorageTable />)
      await openEditor()
      const input = uploadLimitInput()
      await userEvent.clear(input)
      await userEvent.type(input, `${value}{Enter}`)

      expect(
        screen.getByText(
          'Enter a file size in MB from 1 to 250 MB, or leave the field empty for the default.'
        )
      ).toBeDefined()
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(puts()).toHaveLength(0)
    }
  )

  test('saving with nothing changed sends nothing and closes the editor', async () => {
    render(<PlatformStorageTable />)
    const input = await openEditor()
    await userEvent.type(input, '{Enter}')

    expect(puts()).toHaveLength(0)
    expect(screen.queryByTestId('quota-editor')).toBeNull()
  })

  test('a refused file size names the reason and keeps the editor open', async () => {
    fetchMock
      .mockResolvedValueOnce(json(STORAGE))
      .mockResolvedValueOnce(json({ error: 'above the ceiling' }, 422))
    render(<PlatformStorageTable />)
    await openEditor()
    await userEvent.clear(uploadLimitInput())
    await userEvent.type(uploadLimitInput(), '200{Enter}')

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not update the max. file size.', {
        description: 'above the ceiling',
      })
    )
    expect(screen.getByTestId('quota-editor')).toBeDefined()
  })

  test('read-only staff get no pencil and no actions column', async () => {
    render(
      <PlatformAccessProvider permissions={[PLATFORM_PERMISSIONS.organizationsView]}>
        <PlatformStorageTable />
      </PlatformAccessProvider>
    )
    const table = await screen.findByRole('table')

    expect(within(table).queryByRole('button')).toBeNull()
    expect(within(table).queryByRole('columnheader', { name: 'Actions' })).toBeNull()
    // The limit is still shown; only the editor is withheld.
    expect(within(table).getByRole('columnheader', { name: 'Max. file size' })).toBeDefined()
    expect(screen.queryByText(/At most 250 MB/)).toBeNull()
  })
})

describe('readQuotaInput', () => {
  test('blank is unlimited; everything else must be a number of GB', () => {
    expect(readQuotaInput('', 'de')).toEqual({ ok: true, quotaBytes: null })
    expect(readQuotaInput('2,5', 'de')).toEqual({ ok: true, quotaBytes: 2.5 * GB })
    expect(readQuotaInput('2.5x', 'de')).toEqual({ ok: false, reason: 'notANumber' })
    expect(readQuotaInput('0', 'de')).toEqual({ ok: false, reason: 'notPositive' })
  })
})

describe('readUploadLimitInput', () => {
  test('blank is the default; a number of MB must sit between 1 and the ceiling', () => {
    expect(readUploadLimitInput('', 'de', 250 * MB)).toEqual({ ok: true, maxUploadFileBytes: null })
    expect(readUploadLimitInput('2,5', 'de', 250 * MB)).toEqual({ ok: true, maxUploadFileBytes: 2.5 * MB })
    expect(readUploadLimitInput('251', 'de', 250 * MB)).toEqual({ ok: false, reason: 'outOfRange' })
    expect(readUploadLimitInput('20x', 'de', 250 * MB)).toEqual({ ok: false, reason: 'notANumber' })
  })
})
