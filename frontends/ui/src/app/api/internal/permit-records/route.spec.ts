/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The route factory statically imports the session guard, which pulls in
// authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))
vi.mock('@/lib/permits/service', () => ({ storePermitRecord: vi.fn() }))

import { storePermitRecord } from '@/lib/permits/service'
import { POST } from './route'

const DOC_ID = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'

const record = {
  kind: 'nachforderung',
  authority: 'Magistratsabteilung 37',
  municipality: 'Wien',
  bundesland: 'wien',
  issuedOn: '2020-03-14',
  reference: 'MA37/123456/2020',
  requirements: [
    { kind: 'nachforderung', content: 'Statischer Nachweis vorzulegen.', evidence: 'Gutachten', legalBasis: '§ 13 Abs. 3 AVG', page: 2 },
  ],
}

const body = (overrides: Record<string, unknown> = {}) => ({
  organizationId: 'org_1',
  documentId: DOC_ID,
  collection: 'proj_1',
  fileName: 'Baubescheid_Baden_2020.pdf',
  model: 'summary-model',
  record,
  ...overrides,
})

const request = (payload: unknown, token: string | null = 'test-token') =>
  new Request('http://localhost/api/internal/permit-records', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-grid-internal-token': token } : {}) },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })

describe('POST /api/internal/permit-records', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
    vi.mocked(storePermitRecord).mockResolvedValue({ stored: true, requirements: 1 })
  })

  it('rejects when the token is missing or wrong', async () => {
    expect((await POST(request(body(), null))).status).toBe(403)
    expect((await POST(request(body(), 'wrong'))).status).toBe(403)
    expect(storePermitRecord).not.toHaveBeenCalled()
  })

  it('fails closed when the token is unconfigured', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN
    expect((await POST(request(body()))).status).toBe(503)
    expect(storePermitRecord).not.toHaveBeenCalled()
  })

  it('passes the parsed body through and answers what the service says', async () => {
    const response = await POST(request(body()))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ stored: true, requirements: 1 })
    expect(storePermitRecord).toHaveBeenCalledWith(body())
  })

  it('accepts a body without a document id: the service finds the file by collection and name', async () => {
    const { documentId: _omitted, ...byName } = body()
    void _omitted

    const response = await POST(request(byName))

    expect(response.status).toBe(200)
    expect(storePermitRecord).toHaveBeenCalledWith(byName)
  })

  it('answers an unknown file name with 200 and stored: false', async () => {
    vi.mocked(storePermitRecord).mockResolvedValue({ stored: false, requirements: 0 })
    const { documentId: _omitted, ...byName } = body({ fileName: 'unbekannt.pdf' })
    void _omitted

    const response = await POST(request(byName))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ stored: false, requirements: 0 })
  })

  it('accepts a record whose notice does not name its authority: a scan without its letterhead', async () => {
    const response = await POST(request(body({ record: { ...record, authority: null } })))

    expect(response.status).toBe(200)
    expect(storePermitRecord).toHaveBeenCalledWith(body({ record: { ...record, authority: null } }))
  })

  it('accepts a null record, which deletes', async () => {
    await POST(request(body({ record: null })))
    expect(storePermitRecord).toHaveBeenCalledWith(body({ record: null }))
  })

  it('answers an unknown document with 200 and stored: false', async () => {
    vi.mocked(storePermitRecord).mockResolvedValue({ stored: false, requirements: 0 })
    const response = await POST(request(body()))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ stored: false, requirements: 0 })
  })

  it('400s a body that is not the contract', async () => {
    const requirement = record.requirements[0]
    const bad: unknown[] = [
      'not json',
      body({ organizationId: '' }),
      body({ documentId: 'not-a-uuid' }),
      body({ documentId: null }),
      body({ collection: '' }),
      body({ fileName: undefined }),
      body({ model: undefined }),
      body({ record: undefined }),
      body({ record: { ...record, kind: 'bescheid' } }),
      body({ record: { ...record, authority: '' } }),
      body({ record: { ...record, issuedOn: '2020-02-31' } }),
      body({ record: { ...record, issuedOn: '14.03.2020' } }),
      body({ record: { ...record, requirements: [{ ...requirement, kind: 'frist' }] } }),
      body({ record: { ...record, requirements: [{ ...requirement, content: '' }] } }),
      body({ record: { ...record, requirements: [{ ...requirement, content: 'x'.repeat(1001) }] } }),
      body({ record: { ...record, requirements: [{ ...requirement, page: 0 }] } }),
      body({ record: { ...record, requirements: [{ ...requirement, page: 1.5 }] } }),
      body({ record: { ...record, requirements: Array.from({ length: 61 }, () => requirement) } }),
    ]
    for (const payload of bad) {
      expect((await POST(request(payload))).status, JSON.stringify(payload).slice(0, 120)).toBe(400)
    }
    expect(storePermitRecord).not.toHaveBeenCalled()
  })

  it('takes the bounds as they are: 60 requirements, 1000 characters', async () => {
    const requirement = { ...record.requirements[0], content: 'x'.repeat(1000) }
    const full = body({ record: { ...record, requirements: Array.from({ length: 60 }, () => requirement) } })
    expect((await POST(request(full))).status).toBe(200)
  })
})
