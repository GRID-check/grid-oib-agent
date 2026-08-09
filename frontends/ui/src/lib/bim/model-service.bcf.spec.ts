/**
 * @vitest-environment node
 *
 * Resolving WHICH model an export is about.
 *
 * The archive itself is covered in `bcf.spec.ts`. What is dangerous here is
 * everything before the first byte is written: exporting the wrong revision
 * produces a file that is internally consistent, opens cleanly in ArchiCAD,
 * and describes a building that is not the one on screen. Nothing downstream
 * can catch that, so it has to be caught here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BimModelHeader } from './repository'

vi.mock('@/lib/authz/feature-flags', () => ({
  FEATURE_FLAGS: { ifcModels: 'ifc-models' },
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-admin' }),
}))

vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn().mockResolvedValue({ id: 'proj-1', name: 'Wohnhaus Grüngasse' }),
}))

vi.mock('@/lib/documents/repository', () => ({
  findDocumentInOrg: vi.fn().mockResolvedValue({ id: 'doc-1', projectId: 'proj-1', storageKey: 'k' }),
}))

vi.mock('./repository', () => ({
  listBimModels: vi.fn(),
  findBimModelById: vi.fn(),
  findBimModelByDocument: vi.fn(),
  listBimCheckConfirmations: vi.fn().mockResolvedValue([]),
  upsertBimCheckConfirmation: vi.fn(),
  deleteBimCheckConfirmation: vi.fn(),
}))

vi.mock('./query', () => ({
  runBimQuery: vi.fn().mockResolvedValue({
    compliance: [
      {
        ruleId: 'oib2-feuerwiderstand-tragend',
        richtlinie: 'OIB 2',
        clause: '3.1',
        titleDe: 'Feuerwiderstand tragender Bauteile',
        thresholdDe: 'Mindestens REI 60',
        applicable: true,
        passed: 0,
        failed: 0,
        undecidable: 1,
        failures: [],
        unknowns: [
          {
            globalId: 'wall-1',
            name: 'Aussenwand',
            storeyName: 'EG',
            status: 'undecidable',
            reading: 'kein FireRating veröffentlicht',
          },
        ],
        truncated: false,
        missing: [{ path: 'Pset_WallCommon.FireRating', elements: 1 }],
      },
    ],
  }),
}))

import { exportAccessibleComplianceBcf } from './model-service'
import { listBimModels, findBimModelById, listBimCheckConfirmations } from './repository'
import { readZipEntries } from '@/test-utils/read-zip'

const SESSION = {
  userId: 'user-1',
  email: 'planer@example.at',
  name: null,
  accessToken: 't',
  organizationId: 'org-1',
  organizationMembershipId: 'om-1',
  role: 'admin',
  permissions: [],
  featureFlags: ['ifc-models'],
}

function model(overrides: Partial<BimModelHeader> & Pick<BimModelHeader, 'id' | 'filename'>): BimModelHeader {
  return {
    documentId: `doc-${overrides.id}`,
    projectId: 'proj-1',
    status: 'ready',
    schemaVersion: 'IFC4',
    elementCount: 1,
    errorMessage: null,
    summary: null,
    updatedAt: new Date('2026-05-04T09:30:15.400Z'),
    ...overrides,
  }
}

const run = (input: Parameters<typeof exportAccessibleComplianceBcf>[2]) =>
  exportAccessibleComplianceBcf(SESSION, 'proj-1', input)

const byName = (modelName: string) => run({ modelId: null, modelName, gebaeudeklasse: 4, hauptnutzung: null })

describe('exportAccessibleComplianceBcf', () => {
  beforeEach(() => vi.clearAllMocks())

  it('prefers an exact file-name match over a substring one', async () => {
    // `Haus-A_V3 (1).ifc` contains `Haus-A_V3.ifc`'s stem; a substring-first
    // resolver hands back the duplicate upload.
    vi.mocked(listBimModels).mockResolvedValue([
      model({ id: 'm-dup', filename: 'Haus-A_V3 (1).ifc' }),
      model({ id: 'm-real', filename: 'Haus-A_V3.ifc' }),
    ])

    const bcf = await byName('Haus-A_V3.ifc')
    const markup = [...readZipEntries(bcf.bytes).entries()].find(([p]) => p.endsWith('markup.bcf'))?.[1] ?? ''

    expect(markup).toContain('<Filename>Haus-A_V3.ifc</Filename>')
  })

  it('matches case-insensitively, because a file name is not a key', async () => {
    vi.mocked(listBimModels).mockResolvedValue([model({ id: 'm-1', filename: 'Haus-A_V3.ifc' })])

    await expect(byName('haus-a_v3.ifc')).resolves.toMatchObject({ topics: 1 })
  })

  it('takes the newest when only a substring matches', async () => {
    // `listBimModels` orders newest-first; the first hit is the revision the
    // architect uploaded last, which is what "the model" means in a sentence.
    vi.mocked(listBimModels).mockResolvedValue([
      model({ id: 'm-4', filename: 'Haus-A_V4.ifc' }),
      model({ id: 'm-3', filename: 'Haus-A_V3.ifc' }),
    ])

    const bcf = await byName('Haus-A')
    const markup = [...readZipEntries(bcf.bytes).entries()].find(([p]) => p.endsWith('markup.bcf'))?.[1] ?? ''

    expect(markup).toContain('<Filename>Haus-A_V4.ifc</Filename>')
  })

  it('never resolves a model that is still being extracted', async () => {
    // A pending model has no elements, so it would export a clean ledger for a
    // building nobody has checked.
    vi.mocked(listBimModels).mockResolvedValue([
      model({ id: 'm-new', filename: 'Haus-A_V4.ifc', status: 'pending' }),
      model({ id: 'm-3', filename: 'Haus-A_V3.ifc' }),
    ])

    const bcf = await byName('Haus-A')
    const markup = [...readZipEntries(bcf.bytes).entries()].find(([p]) => p.endsWith('markup.bcf'))?.[1] ?? ''

    expect(markup).toContain('<Filename>Haus-A_V3.ifc</Filename>')
  })

  it('refuses a name no model in the project carries', async () => {
    vi.mocked(listBimModels).mockResolvedValue([model({ id: 'm-3', filename: 'Haus-A_V3.ifc' })])

    await expect(byName('Haus-B.ifc')).rejects.toThrow(/not found/i)
  })

  it('refuses a model id belonging to another project', async () => {
    // The id would pass `getAccessibleModel` — the caller can read that model.
    // What they must not get is that building's verdicts filed under THIS
    // project's confirmations.
    vi.mocked(findBimModelById).mockResolvedValue(
      model({ id: 'm-other', filename: 'Anderes-Haus.ifc', projectId: 'proj-2' })
    )

    await expect(
      run({ modelId: 'm-other', gebaeudeklasse: 4, hauptnutzung: null })
    ).rejects.toThrow(/not found in this project/i)
  })

  it('reads the confirmations of the project, not of the model', async () => {
    vi.mocked(listBimModels).mockResolvedValue([model({ id: 'm-3', filename: 'Haus-A_V3.ifc' })])
    vi.mocked(listBimCheckConfirmations).mockResolvedValue([
      {
        ruleId: 'oib2-feuerwiderstand-tragend',
        modelId: 'm-3',
        confirmedBy: 'brandschutz@example.at',
        note: 'Gutachten liegt vor',
        confirmedAt: new Date('2026-05-05T08:00:00.000Z'),
      },
    ])

    const bcf = await byName('Haus-A_V3.ifc')
    const markup = [...readZipEntries(bcf.bytes).entries()].find(([p]) => p.endsWith('markup.bcf'))?.[1] ?? ''

    expect(listBimCheckConfirmations).toHaveBeenCalledWith('org-1', 'proj-1')
    expect(markup).toContain('TopicStatus="Closed"')
    expect(markup).toContain('Gutachten liegt vor')
  })

  it('names the exporting user as the topic author, not the confirming one', async () => {
    vi.mocked(listBimModels).mockResolvedValue([model({ id: 'm-3', filename: 'Haus-A_V3.ifc' })])
    vi.mocked(listBimCheckConfirmations).mockResolvedValue([
      {
        ruleId: 'oib2-feuerwiderstand-tragend',
        modelId: 'm-3',
        confirmedBy: 'brandschutz@example.at',
        note: null,
        confirmedAt: new Date('2026-05-05T08:00:00.000Z'),
      },
    ])

    const bcf = await byName('Haus-A_V3.ifc')
    const markup = [...readZipEntries(bcf.bytes).entries()].find(([p]) => p.endsWith('markup.bcf'))?.[1] ?? ''

    expect(markup).toContain('<CreationAuthor>planer@example.at</CreationAuthor>')
    expect(markup).toContain('<Author>brandschutz@example.at</Author>')
  })

  it('refuses every export when the feature is off for the organization', async () => {
    const { isFeatureEnabled } = await import('@/lib/authz/feature-flags')
    vi.mocked(isFeatureEnabled).mockReturnValueOnce(false)

    await expect(byName('Haus-A_V3.ifc')).rejects.toThrow(/not enabled/i)
  })
})
