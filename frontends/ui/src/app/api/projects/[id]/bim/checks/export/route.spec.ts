/**
 * @vitest-environment node
 *
 * The BCF download route.
 *
 * Two things have to hold, and neither is about the archive's contents (that
 * is `lib/bim/bcf.spec.ts`): the response must present as a FILE — a browser
 * that renders the bytes inline instead of saving them has silently lost the
 * export — and the facts in the URL must reach the service unchanged, because
 * a Gebäudeklasse that gets dropped between the panel and the export produces
 * an archive whose fire-resistance thresholds belong to a different building.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'planer@example.at',
    role: 'admin',
  }),
}))

vi.mock('@/lib/bim/model-service', () => ({
  exportAccessibleComplianceBcf: vi.fn().mockResolvedValue({
    filename: 'pruefbuch-wohnhaus-2026-05-04.bcfzip',
    bytes: new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    topics: 3,
  }),
}))

import { GET } from './route'
import { exportAccessibleComplianceBcf } from '@/lib/bim/model-service'

const MODEL_ID = '3f6e1c2a-0000-4000-8000-000000000001'

const call = (query: string): Promise<Response> =>
  GET(new Request(`https://grid.test/api/projects/proj-1/bim/checks/export${query}`), {
    params: Promise.resolve({ id: 'proj-1' }),
  })

describe('GET /api/projects/[id]/bim/checks/export', () => {
  beforeEach(() => vi.clearAllMocks())

  it('serves the archive as a download named after the revision', async () => {
    const response = await call(`?modelId=${MODEL_ID}`)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="pruefbuch-wohnhaus-2026-05-04.bcfzip"'
    )
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(response.headers.get('X-Grid-Bcf-Topics')).toBe('3')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x50, 0x4b, 0x05, 0x06])
    )
  })

  it('passes the project facts through to the catalogue run', async () => {
    await call(`?modelId=${MODEL_ID}&gebaeudeklasse=4&hauptnutzung=wohnen`)

    expect(exportAccessibleComplianceBcf).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
      'proj-1',
      { modelId: MODEL_ID, modelName: null, gebaeudeklasse: 4, hauptnutzung: 'wohnen' }
    )
  })

  it('drops a fact it cannot read rather than guessing one', async () => {
    // The rules that need a Gebäudeklasse then stand down with their reason,
    // which is the whole design. Substituting a default would put thresholds
    // in the file that nobody chose.
    await call(`?modelId=${MODEL_ID}&gebaeudeklasse=7`)

    expect(exportAccessibleComplianceBcf).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      { modelId: MODEL_ID, modelName: null, gebaeudeklasse: null, hauptnutzung: null }
    )
  })

  it('accepts a model addressed by file name, the way a chat answer links one', async () => {
    // A UUID carried through a conversation is a reliable source of
    // hallucinated identifiers; the file name is how the rest of the app
    // addresses a model.
    await call('?model=Haus-A_V3.ifc&gebaeudeklasse=4')

    expect(exportAccessibleComplianceBcf).toHaveBeenCalledWith(expect.anything(), 'proj-1', {
      modelId: null,
      modelName: 'Haus-A_V3.ifc',
      gebaeudeklasse: 4,
      hauptnutzung: null,
    })
  })

  it('rejects a request that names no model at all', async () => {
    expect((await call('')).status).toBe(400)
    expect(exportAccessibleComplianceBcf).not.toHaveBeenCalled()
  })

  it('rejects a model id that is not an id', async () => {
    expect((await call('?modelId=../../etc/passwd')).status).toBe(400)
    expect(exportAccessibleComplianceBcf).not.toHaveBeenCalled()
  })
})
