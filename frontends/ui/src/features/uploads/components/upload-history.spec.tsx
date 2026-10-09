import { render, screen, within } from '@/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIXTURE_PROJECT_ID, FIXTURE_USER_ID, HISTORY } from '@/app/dev/_fixtures/upload-batches'
import { en } from '@/i18n/dictionaries/en'
import { UploadHistory, UploadHistoryList } from './upload-history'

function pillCount(row: HTMLElement, key: string): string | null | undefined {
  return within(row).queryByTestId(`upload-pill-${key}`)?.querySelector('[data-slot="chip-count"]')?.textContent
}

describe('UploadHistoryList', () => {
  it('tallies each upload as pills in the status words', () => {
    render(<UploadHistoryList uploads={HISTORY} currentUserId={FIXTURE_USER_ID} />)
    const first = screen.getByTestId(`upload-history-row-${HISTORY[0].id}`)
    expect(within(first).getByText('14 files')).toBeInTheDocument()
    expect(pillCount(first, 'ready')).toBe('3')
    expect(pillCount(first, 'reading')).toBe('1')
    expect(pillCount(first, 'quarantined')).toBe('1')
    expect(pillCount(first, 'failed')).toBe('2')
    expect(pillCount(first, 'unchanged')).toBe('4')
    expect(pillCount(first, 'excluded')).toBe('4')
    expect(within(first).getByTestId('upload-pill-ready')).toHaveTextContent(en.files.status.ready)

    const colleague = screen.getByTestId(`upload-history-row-${HISTORY[1].id}`)
    expect(pillCount(colleague, 'ready')).toBe('37')
    expect(pillCount(colleague, 'excluded')).toBeUndefined()
  })

  it('links only the reader’s own uploads to their summary', () => {
    render(<UploadHistoryList uploads={HISTORY} currentUserId={FIXTURE_USER_ID} />)
    const links = screen.getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `/app/uploads/${HISTORY[0].id}`,
      `/app/uploads/${HISTORY[2].id}`,
    ])
    const colleague = screen.getByTestId(`upload-history-row-${HISTORY[1].id}`)
    expect(within(colleague).queryByRole('link')).not.toBeInTheDocument()
    expect(within(colleague).queryByText(en.uploadBatches.history.you)).not.toBeInTheDocument()
    expect(within(colleague).getByText('Jonas Berger')).toBeInTheDocument()
    const own = screen.getByTestId(`upload-history-row-${HISTORY[0].id}`)
    expect(within(own).getByText(en.uploadBatches.history.you)).toBeInTheDocument()
  })

  it('links nothing when the reader is unknown', () => {
    render(<UploadHistoryList uploads={HISTORY} currentUserId={null} />)
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('says so when the project has no uploads yet', () => {
    render(<UploadHistoryList uploads={[]} currentUserId={FIXTURE_USER_ID} />)
    expect(screen.getByTestId('upload-history-empty')).toHaveTextContent(en.uploadBatches.history.empty.title)
  })
})

describe('UploadHistory', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads the project’s uploads from its history endpoint', async () => {
    const fetchMock = vi.fn(async () => Response.json({ uploads: HISTORY }))
    vi.stubGlobal('fetch', fetchMock)
    render(<UploadHistory projectId={FIXTURE_PROJECT_ID} currentUserId={FIXTURE_USER_ID} />)
    expect(await screen.findByTestId('upload-history')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(`/api/projects/${FIXTURE_PROJECT_ID}/uploads`, expect.anything())
  })

  it('offers a retry when the history cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })))
    render(<UploadHistory projectId={FIXTURE_PROJECT_ID} currentUserId={FIXTURE_USER_ID} />)
    const error = await screen.findByTestId('upload-history-error')
    expect(error).toHaveTextContent(en.uploadBatches.history.error)
    expect(within(error).getByRole('button', { name: en.common.actions.retry })).toBeInTheDocument()
  })
})
