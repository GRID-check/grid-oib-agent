import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { resetSurfacedDocumentsCache } from '@/features/documents/hooks/use-surfaced-documents'
import { useAnswerFileReferences } from './use-answer-file-references'

const row = (id: string, filename: string) => ({
  id,
  filename,
  fileSize: 1024,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-01-01T00:00:00Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
})

const corpora = (options: {
  projekt?: ReturnType<typeof row>[]
  archiv?: ReturnType<typeof row>[]
  session?: ReturnType<typeof row>[]
  onProjectFetch?: () => void
}) => {
  server.use(
    http.get('/api/documents', () => {
      options.onProjectFetch?.()
      return HttpResponse.json({ documents: options.projekt ?? [] })
    }),
    http.get('/api/archiv/documents', () => HttpResponse.json({ documents: options.archiv ?? [] })),
    http.get('/api/session/documents', () =>
      HttpResponse.json({ documents: options.session ?? [] })
    )
  )
}

const referencesFor = (body: string, conversationId: string | null = 'conv-1') =>
  renderHook(() =>
    useAnswerFileReferences({ body, projectId: 'proj-1', conversationId })
  )

describe('useAnswerFileReferences', () => {
  beforeEach(() => {
    resetSurfacedDocumentsCache()
  })

  afterEach(() => {
    resetSurfacedDocumentsCache()
  })

  it('names the project files the answer wrote out', async () => {
    corpora({ projekt: [row('p1', 'pd8280-2.pdf'), row('p2', 'Statik.pdf')] })
    const { result } = referencesFor('Beginnen Sie mit pd8280-2.pdf.')

    await waitFor(() => expect(result.current.fileNames).toEqual(['pd8280-2.pdf']))
    expect(result.current.resolve('pd8280-2.pdf')?.file.id).toBe('p1')
    expect(result.current.resolve('pd8280-2.pdf')?.corpus).toBe('projekt')
  })

  it('resolves a name the answer spelled in a different case', async () => {
    corpora({ projekt: [row('p1', 'pd8280-2.pdf')] })
    const { result } = referencesFor('Siehe PD8280-2.PDF.')

    await waitFor(() => expect(result.current.fileNames).toEqual(['pd8280-2.pdf']))
    expect(result.current.resolve('PD8280-2.PDF')?.file.id).toBe('p1')
  })

  // The gap this change closes: a file the reader dropped into THIS chat was
  // reachable by no index at all, so the answer naming it back was dead text.
  it('reaches a file attached to this conversation', async () => {
    corpora({ session: [row('s1', 'Bestandsplan-1910.pdf')] })
    const { result } = referencesFor('Der Bestandsplan-1910.pdf zeigt den Konsens.')

    await waitFor(() => expect(result.current.fileNames).toEqual(['Bestandsplan-1910.pdf']))
    expect(result.current.resolve('Bestandsplan-1910.pdf')?.corpus).toBe('session')
  })

  // The index is "every file the reader has", so it reads the listing to its
  // end: a file older than the first page is as nameable as the newest.
  it('names a project file that sits past the listing\'s first page', async () => {
    server.use(
      http.get('/api/documents', ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === 'page-2'
          ? HttpResponse.json({ documents: [row('p-old', 'Bestand-1962.pdf')], nextCursor: null })
          : HttpResponse.json({ documents: [row('p-new', 'Statik.pdf')], nextCursor: 'page-2' })
      ),
      http.get('/api/archiv/documents', () => HttpResponse.json({ documents: [] })),
      http.get('/api/session/documents', () => HttpResponse.json({ documents: [] }))
    )
    const { result } = referencesFor('Vergleichen Sie Bestand-1962.pdf.')

    await waitFor(() => expect(result.current.fileNames).toEqual(['Bestand-1962.pdf']))
    expect(result.current.resolve('Bestand-1962.pdf')?.file.id).toBe('p-old')
  })

  it('prefers the project copy of a name held on two shelves', async () => {
    corpora({
      projekt: [row('p1', 'Plan.pdf')],
      archiv: [row('a1', 'Plan.pdf')],
      session: [row('s1', 'Plan.pdf')],
    })
    const { result } = referencesFor('Siehe Plan.pdf.')

    await waitFor(() => expect(result.current.resolve('Plan.pdf')?.file.id).toBe('p1'))
  })

  it('names nothing the reader does not own', async () => {
    corpora({ projekt: [row('p1', 'Statik.pdf')] })
    const { result } = referencesFor('Siehe Konzept.pdf.')

    // The index still loads (the body names a document type), it simply
    // resolves nothing — which is plain prose, not a broken chip.
    await waitFor(() => expect(result.current.resolve('Statik.pdf')).toBeNull())
    expect(result.current.fileNames).toEqual([])
  })

  // The whole point of the gate: three list fetches per answer would be paid by
  // every answer, and almost no answer names a file.
  it('fetches nothing for an answer with no document in it', async () => {
    let fetched = false
    corpora({ projekt: [row('p1', 'Statik.pdf')], onProjectFetch: () => (fetched = true) })
    const { result } = referencesFor('Die Fluchtweglänge beträgt 34 m [1].')

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetched).toBe(false)
    expect(result.current.fileNames).toEqual([])
  })

  // It used to wait for the finished answer, which fetched at the settle and
  // re-parsed an answer the reader had just read to the end. The paced body
  // grows a word at a time, so a name is linked once it is whole on screen.
  it('starts while the answer is still arriving, as soon as a filename appears', async () => {
    let fetched = false
    corpora({ projekt: [row('p1', 'pd8280-2.pdf')], onProjectFetch: () => (fetched = true) })
    const { result, rerender } = renderHook(({ body }) =>
      useAnswerFileReferences({ body, projectId: 'proj-1', conversationId: 'conv-1' }),
      { initialProps: { body: 'Beginnen Sie mit' } }
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetched).toBe(false)

    rerender({ body: 'Beginnen Sie mit pd8280-2.pdf' })
    await waitFor(() => expect(result.current.fileNames).toEqual(['pd8280-2.pdf']))
    expect(fetched).toBe(true)
  })

  it('degrades to plain prose when the index cannot be read', async () => {
    server.use(
      http.get('/api/documents', () => HttpResponse.error()),
      http.get('/api/archiv/documents', () => HttpResponse.error()),
      http.get('/api/session/documents', () => HttpResponse.error())
    )
    const { result } = referencesFor('Beginnen Sie mit pd8280-2.pdf.')

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(result.current.fileNames).toEqual([])
    expect(result.current.resolve('pd8280-2.pdf')).toBeNull()
  })
})
