import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIXTURE_PROJECT_ID, MIXED_SUMMARY, SETTLED_SUMMARY } from '@/app/dev/_fixtures/upload-batches'
import { classifyIngestFailure, ingestFailureSentence } from '@/features/documents/lib/ingest-failure'
import { en } from '@/i18n/dictionaries/en'
import { createTranslator } from '@/i18n/translate'
import { describeQuarantineReason, type QuarantineReason } from '@/lib/upload-screening/quarantine'
import { UPLOAD_SUMMARY_POLL_MS, useUploadSummary } from '../hooks/use-upload-summary'
import { UploadSummaryDialog, UploadSummaryView } from './upload-summary'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }))
import { toast } from 'sonner'

const tFiles = createTranslator(en, 'files')

function tile(key: string): HTMLElement {
  return screen.getByTestId(`upload-tally-${key}`)
}

describe('UploadSummaryView', () => {
  it('headlines every count in the status words the file badges use', () => {
    render(<UploadSummaryView summary={MIXED_SUMMARY} />)
    expect(within(tile('ready')).getByText('3')).toBeInTheDocument()
    expect(within(tile('ready')).getByText(en.files.status.ready)).toBeInTheDocument()
    expect(within(tile('reading')).getByText(en.files.status.processing)).toBeInTheDocument()
    expect(within(tile('quarantined')).getByText('1')).toBeInTheDocument()
    // One document whose reading failed, one upload that never arrived.
    expect(within(tile('failed')).getByText('2')).toBeInTheDocument()
    expect(within(tile('unchanged')).getByText('4')).toBeInTheDocument()
    expect(within(tile('excluded')).getByText('4')).toBeInTheDocument()
    expect(screen.queryByTestId('upload-tally-stored')).not.toBeInTheDocument()
    expect(screen.getByTestId('upload-summary-upload-failed')).toHaveTextContent('1 file did not arrive')
  })

  it('headlines the changed and the protected files, and marks each such file', () => {
    render(<UploadSummaryView summary={MIXED_SUMMARY} />)
    expect(within(tile('changed')).getByText('1')).toBeInTheDocument()
    expect(within(tile('changed')).getByText(en.uploadBatches.summary.counts.changed)).toBeInTheDocument()
    expect(within(tile('protected')).getByText('2')).toBeInTheDocument()
    expect(within(tile('protected')).getByText(en.uploadBatches.summary.counts.protected)).toBeInTheDocument()

    const replaced = screen.getByTestId('upload-file-doc-brandschutz')
    expect(within(replaced).getByTestId('upload-facet-changed')).toHaveAttribute(
      'title',
      en.uploadBatches.summary.files.changedHint
    )
    expect(within(replaced).getByTestId('upload-facet-protected')).toHaveTextContent(
      en.uploadBatches.summary.counts.protected
    )
    const fresh = screen.getByTestId('upload-file-doc-grundriss-eg')
    expect(within(fresh).queryByTestId('upload-facet-changed')).not.toBeInTheDocument()
    expect(within(fresh).queryByTestId('upload-facet-protected')).not.toBeInTheDocument()
  })

  it('shows no changed or protected tile when no file is either', () => {
    const plain = {
      ...MIXED_SUMMARY,
      documents: MIXED_SUMMARY.documents.map((document) => ({ ...document, replaced: false, restricted: false })),
    }
    render(<UploadSummaryView summary={plain} />)
    expect(screen.queryByTestId('upload-tally-changed')).not.toBeInTheDocument()
    expect(screen.queryByTestId('upload-tally-protected')).not.toBeInTheDocument()
  })

  it('names the excluded terms with their counts and never a file', () => {
    render(<UploadSummaryView summary={MIXED_SUMMARY} />)
    const excluded = screen.getByTestId('upload-summary-excluded')
    expect(within(excluded).getByText('These files never left your computer.', { exact: false })).toBeInTheDocument()
    const terms = within(excluded).getByRole('list', { name: en.uploadBatches.summary.excluded.listLabel })
    expect(within(terms).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Rechnung3', 'Lohnzettel1'])
  })

  it('groups the files by folder, the shelf root first, and links each name into Files', () => {
    render(<UploadSummaryView summary={MIXED_SUMMARY} />)
    const files = screen.getByTestId('upload-summary-files')
    const headings = within(files).getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent)
    expect(headings).toEqual(['Project folder2', 'Gutachten2', 'Pläne / Einreichung2'])
    const link = within(screen.getByTestId('upload-file-doc-grundriss-eg')).getByRole('link', {
      name: 'Grundriss Erdgeschoss 1:100',
    })
    expect(link).toHaveAttribute('href', `/app/projects/${FIXTURE_PROJECT_ID}/files?doc=doc-grundriss-eg`)
  })

  it('shows the document type and the other tags of a file, and its summary', () => {
    render(<UploadSummaryView summary={MIXED_SUMMARY} />)
    const row = screen.getByTestId('upload-file-doc-grundriss-eg')
    expect(within(row).getByTitle(en.files.preview.indexed.documentType)).toHaveTextContent('Grundriss')
    expect(within(row).getByText('Nutzungssicherheit/Barrierefreiheit')).toBeInTheDocument()
    expect(within(row).getByTestId('upload-file-summary-doc-grundriss-eg')).toHaveTextContent('Einreichplan Erdgeschoss')
    // The types section counts the detected types across the batch.
    expect(within(screen.getByTestId('upload-summary-types')).getByText('Grundriss')).toBeInTheDocument()
  })

  it('says why a file waits in quarantine through the shared reason phrases', () => {
    render(<UploadSummaryView summary={MIXED_SUMMARY} />)
    const quarantine = screen.getByTestId('upload-file-quarantine-doc-honorar')
    const reasons = MIXED_SUMMARY.documents.find((document) => document.id === 'doc-honorar')?.quarantine?.reasons ?? []
    expect(reasons).toHaveLength(2)
    for (const reason of reasons as QuarantineReason[]) {
      expect(within(quarantine).getByText(describeQuarantineReason(reason, tFiles))).toBeInTheDocument()
    }
    expect(within(quarantine).getByText('“Honorar” in the text · pages 1, 4')).toBeInTheDocument()
    expect(within(quarantine).getByText(en.files.ingestFailure.quarantined)).toBeInTheDocument()
  })

  // T4.2: the uploader of a file held back can ask the people who may release it.
  describe('„Freigabe anfragen" on a quarantined file', () => {
    afterEach(() => vi.unstubAllGlobals())

    const stubAsk = (notified: number) =>
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'doc-honorar', notified })))

    it('asks the reviewers through the release-request route and says so', async () => {
      stubAsk(2)
      render(<UploadSummaryView summary={MIXED_SUMMARY} />)
      const button = screen.getByTestId('upload-file-request-release-doc-honorar')
      expect(button).toHaveTextContent(en.uploadBatches.summary.files.requestRelease)

      fireEvent.click(button)

      await waitFor(() => expect(button).toHaveTextContent(en.uploadBatches.summary.files.releaseRequested))
      expect(button).toBeDisabled()
      expect(fetch).toHaveBeenCalledWith('/api/documents/doc-honorar/quarantine/request-release', { method: 'POST' })
      expect(toast.success).toHaveBeenCalled()
    })

    it('tells the uploader when nobody but them may release it', async () => {
      stubAsk(0)
      render(<UploadSummaryView summary={MIXED_SUMMARY} />)
      fireEvent.click(screen.getByTestId('upload-file-request-release-doc-honorar'))
      await waitFor(() => expect(toast.info).toHaveBeenCalled())
    })

    it('offers it on no file that is not in quarantine', () => {
      render(<UploadSummaryView summary={MIXED_SUMMARY} />)
      expect(screen.queryByTestId('upload-file-request-release-doc-grundriss-eg')).not.toBeInTheDocument()
      // Failed after its check passed (read by its name): nothing is held.
      expect(screen.queryByTestId('upload-file-request-release-doc-scan')).not.toBeInTheDocument()
    })

    it('offers it on a file whose reading failed before the check had a verdict, which stays held', async () => {
      stubAsk(1)
      const summary = {
        ...MIXED_SUMMARY,
        documents: MIXED_SUMMARY.documents.map((document) =>
          document.id === 'doc-scan' ? { ...document, screening: null } : document
        ),
      }
      render(<UploadSummaryView summary={summary} />)
      fireEvent.click(screen.getByTestId('upload-file-request-release-doc-scan'))
      await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith('/api/documents/doc-scan/quarantine/request-release', { method: 'POST' })
      )
    })
  })

  it('says why a reading failed through the shared failure sentence', () => {
    render(<UploadSummaryView summary={MIXED_SUMMARY} />)
    const message = 'pdf_pages_unreadable: 3 of 12 pages could not be read'
    const failure = classifyIngestFailure(message)
    expect(failure?.kind).toBe('unreadable_pages')
    const notice = screen.getByTestId('upload-file-failure-doc-scan')
    expect(within(notice).getByText(ingestFailureSentence(failure!, tFiles))).toBeInTheDocument()
  })

  it('notes a partly checked and an unchecked file in the screening sentences', () => {
    render(<UploadSummaryView summary={MIXED_SUMMARY} />)
    expect(screen.getByTestId('upload-file-screening-doc-schnitt-aa')).toHaveTextContent(en.files.screening.partial)
    expect(screen.getByTestId('upload-file-screening-doc-foto')).toHaveTextContent(en.files.screening.unchecked)
    expect(screen.queryByTestId('upload-file-screening-doc-grundriss-eg')).not.toBeInTheDocument()
  })
})

describe('useUploadSummary', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('asks again every 10 s while a file is being read, and stops once the batch has completed', async () => {
    const answers = [MIXED_SUMMARY, MIXED_SUMMARY, SETTLED_SUMMARY]
    const fetchMock = vi.fn(async () => Response.json(answers.shift() ?? SETTLED_SUMMARY))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useUploadSummary(MIXED_SUMMARY.id))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(() => vi.advanceTimersByTimeAsync(UPLOAD_SUMMARY_POLL_MS))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    await act(() => vi.advanceTimersByTimeAsync(UPLOAD_SUMMARY_POLL_MS))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    await waitFor(() =>
      expect(result.current.state).toMatchObject({ status: 'ready', summary: { completedAt: SETTLED_SUMMARY.completedAt } })
    )

    // Completed: nothing is asked for again, however long the dialog stays open.
    await act(() => vi.advanceTimersByTimeAsync(UPLOAD_SUMMARY_POLL_MS * 3))
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not poll a summary that arrives complete', async () => {
    const fetchMock = vi.fn(async () => Response.json(SETTLED_SUMMARY))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useUploadSummary(SETTLED_SUMMARY.id))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    await act(() => vi.advanceTimersByTimeAsync(UPLOAD_SUMMARY_POLL_MS * 2))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the summary on screen when a poll fails, and tries again on the next tick', async () => {
    const replies: Array<() => Response> = [
      () => Response.json(MIXED_SUMMARY),
      () => new Response(null, { status: 502 }),
      () => Response.json(SETTLED_SUMMARY),
    ]
    const fetchMock = vi.fn(async () => (replies.shift() ?? (() => Response.json(SETTLED_SUMMARY)))())
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useUploadSummary(MIXED_SUMMARY.id))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))

    await act(() => vi.advanceTimersByTimeAsync(UPLOAD_SUMMARY_POLL_MS))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(result.current.state.status).toBe('ready')

    await act(() => vi.advanceTimersByTimeAsync(UPLOAD_SUMMARY_POLL_MS))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
  })
})

describe('UploadSummaryDialog', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('answers a 404 with the not-found sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: { message: 'Upload not found' } }, { status: 404 }))
    )
    render(<UploadSummaryDialog batchId="gone" standalone={false} />)
    expect(await screen.findByTestId('upload-summary-not-found')).toHaveTextContent(
      en.uploadBatches.summary.notFound.description
    )
  })

  it('names the project the upload went to, read from the project', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === `/api/projects/${FIXTURE_PROJECT_ID}`
          ? Response.json({ id: FIXTURE_PROJECT_ID, name: 'Stadthaus Lindengasse' })
          : Response.json(SETTLED_SUMMARY)
      )
    )
    render(<UploadSummaryDialog batchId={SETTLED_SUMMARY.id} standalone={false} />)
    const meta = await screen.findByTestId('upload-summary-meta')
    expect(await within(meta).findByRole('link', { name: 'Stadthaus Lindengasse' })).toHaveAttribute(
      'href',
      `/app/projects/${FIXTURE_PROJECT_ID}/files`
    )
    expect(screen.getByTestId('upload-summary-state')).toHaveTextContent(en.uploadBatches.summary.state.done)
  })
})
