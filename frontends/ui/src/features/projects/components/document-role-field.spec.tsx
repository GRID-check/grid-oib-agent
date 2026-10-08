/**
 * The wizard's role field uploads straight to `/api/documents/upload`, so it
 * owes the same name screen the Files page applies before a byte leaves the
 * browser (ADR-0083): a file the office's policy holds back is not sent, and
 * the reader is told which and why.
 */
import { fireEvent, render, waitFor } from '@/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { UploadScreeningPolicy } from '@/lib/upload-screening/policy'
import { en } from '@/i18n/dictionaries/en'
import {
  loadUploadScreeningPolicy,
  UploadScreeningPolicyUnavailableError,
} from '@/adapters/api/upload-screening-policy'
import { DocumentRoleField } from './document-role-field'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))

vi.mock('../lib/use-document-roles', () => ({
  useDocumentRoles: () => ({ bindings: [], documents: [], refresh: vi.fn(async () => undefined) }),
}))

const policy: UploadScreeningPolicy = {
  enabled: true,
  nameTerms: ['Honorar'],
  nameExceptions: [],
  contentTerms: [],
  detectors: [],
}
vi.mock('@/adapters/api/upload-screening-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/adapters/api/upload-screening-policy')>()),
  loadUploadScreeningPolicy: vi.fn(async () => policy),
}))

describe('DocumentRoleField upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('does not send a file the name screen holds back, and says why', async () => {
    const fetchSpy = vi.fn(async (url: string) => ({
      ok: true,
      status: 201,
      json: async () => (url === '/api/documents/upload' ? { documentId: 'doc-1' } : { replaced: [] }),
    }))
    vi.stubGlobal('fetch', fetchSpy)

    const { container } = render(<DocumentRoleField projectId="proj-1" role="lageplan" />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: {
        files: [
          new File(['fee'], 'Honorarnote.pdf', { type: 'application/pdf' }),
          new File(['plan'], 'Lageplan.pdf', { type: 'application/pdf' }),
        ],
      },
    })

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const uploads = fetchSpy.mock.calls.filter(([url]) => url === '/api/documents/upload')
    expect(uploads).toHaveLength(1)
    const sent = (uploads[0] as unknown as [string, { body: FormData }])[1].body.get('file') as File
    expect(sent.name).toBe('Lageplan.pdf')
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain('Honorarnote.pdf')
  })

  it('sends nothing while the office policy cannot be read, and says so', async () => {
    vi.mocked(loadUploadScreeningPolicy).mockRejectedValueOnce(new UploadScreeningPolicyUnavailableError())
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const { container } = render(<DocumentRoleField projectId="proj-1" role="lageplan" />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['plan'], 'Lageplan.pdf', { type: 'application/pdf' })] } })

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe(en.files.errors.screeningPolicyUnavailable)
  })

  it('opens an upload batch, stamps every upload with it and seals it, so the upload gets its summary', async () => {
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => ({
      ok: url !== '/api/documents/upload' || fetchSpy.mock.calls.filter(([u]) => u === url).length !== 2,
      status: 201,
      json: async () => {
        if (url !== '/api/documents/upload') return { replaced: [] }
        return fetchSpy.mock.calls.filter(([u]) => u === url).length === 3
          ? { documentId: 'doc-3', unchanged: true }
          : { documentId: 'doc-1' }
      },
    }))
    vi.stubGlobal('fetch', fetchSpy)

    const { container } = render(<DocumentRoleField projectId="proj-1" role="lageplan" />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: {
        files: [
          new File(['fee'], 'Honorarnote.pdf', { type: 'application/pdf' }),
          new File(['plan'], 'Lageplan.pdf', { type: 'application/pdf' }),
          new File(['broken'], 'Lageplan-alt.pdf', { type: 'application/pdf' }),
          new File(['same'], 'Lageplan-gleich.pdf', { type: 'application/pdf' }),
        ],
      },
    })

    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([url]) => /^\/api\/upload-batches\/[^/]+\/seal$/.test(url))).toBe(true)
    )
    const calls = fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>
    const opened = calls.find(([url]) => url === '/api/upload-batches')
    expect(opened).toBeDefined()
    const batch = JSON.parse(String(opened?.[1].body)) as Record<string, unknown>
    expect(batch).toMatchObject({
      scope: 'project',
      projectId: 'proj-1',
      conversationId: null,
      expectedCount: 3,
      excluded: [{ term: 'Honorar', count: 1 }],
    })
    // Opened before the first file went.
    expect(calls.findIndex(([url]) => url === '/api/upload-batches')).toBeLessThan(
      calls.findIndex(([url]) => url === '/api/documents/upload')
    )

    const uploads = calls.filter(([url]) => url === '/api/documents/upload')
    expect(uploads).toHaveLength(3)
    for (const [, init] of uploads) expect((init.body as FormData).get('uploadBatchId')).toBe(batch.id)

    const sealed = calls.find(([url]) => url === `/api/upload-batches/${String(batch.id)}/seal`)
    expect(JSON.parse(String(sealed?.[1].body))).toEqual({ unchanged: 1, failed: 1 })
  })

  it('opens no batch when the screen holds back every file', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchSpy)
    const { container } = render(<DocumentRoleField projectId="proj-1" role="lageplan" />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['fee'], 'Honorarnote.pdf', { type: 'application/pdf' })] } })
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
