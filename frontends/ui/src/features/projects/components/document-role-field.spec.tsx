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
vi.mock('@/adapters/api/upload-screening-policy', () => ({
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
})
