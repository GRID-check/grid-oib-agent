/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The authorization decision is the boundary under test: the spec asserts it is
// asked for `project:memory:write` (or the `project:edit` umbrella), and that a refusal stops the extraction.
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
}))

// The office's „Sensible Daten" policy (ADR-0086): here it masks one name, so a
// spec sees that the quote stored in the profile went through it.
vi.mock('@/lib/upload-screening/service', () => ({
  maskChatText: vi.fn(async (_org: string, text: string) => ({ text: text.replaceAll('Maria Huber', '[Name]') })),
}))

vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

// The project and profile repository: the reads the service makes and the one
// profile write `persistProfile` makes. The patch engine itself runs for real.
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(),
  findProjectProfileInOrg: vi.fn(),
  setProjectProfileSummaryInOrg: vi.fn().mockResolvedValue(undefined),
  updateProjectProfileIfVersion: vi.fn(),
}))

// Project memory: the service's own reads and writes, at the service boundary.
vi.mock('@/lib/projects/memory-service', () => ({
  listProjectMemory: vi.fn().mockResolvedValue([]),
  createProjectMemoryItemForProject: vi.fn().mockResolvedValue({ id: 'item-1' }),
}))

vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(),
  invalidateCached: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/document-roles/repository', () => ({
  deleteBindingsOutsideBauwerke: vi.fn().mockResolvedValue(0),
}))

// Which files every member may open and a model may read is the SQL's subject
// (readable-files.integration.spec.ts); here, the names it answered.
vi.mock('./readable-files', () => ({
  extractableFileNames: vi.fn(),
}))

import { requireProjectAccess } from '@/lib/authz/projects'
import { projectClosedError } from '@/lib/projects/project-status'
import { createProjectMemoryItemForProject, listProjectMemory } from '@/lib/projects/memory-service'
import {
  findProjectInOrg,
  findProjectProfileInOrg,
  updateProjectProfileIfVersion,
} from '@/lib/projects/repository'
import { makeMemoryItem, makeProject } from '@/test-utils/db-fixtures'
import { extractableFileNames } from './readable-files'
import { extractProjectExperience } from './service'
import { experienceRequestSchema, type ExperienceResponse } from './types'

const PROJECT_ID = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'
const session = { userId: 'user-1', organizationId: 'org-1' } as never

const emptyProfile = { facts: {}, goals: {}, unknowns: [], assumptions: {} }

/** A profile with one confirmed fact per key, as the intake wizard leaves it. */
const confirmed = (...keys: string[]) => ({
  facts: Object.fromEntries(
    keys.map((key) => [key, { value: 'x', confidence: 'confirmed', source: 'onboarding', updatedAt: '2026-01-01T00:00:00.000Z' }])
  ),
  goals: {},
  unknowns: [],
  assumptions: {},
})

const evidence = (quote: string, page = '2') => ({ fileName: 'Baubeschreibung.pdf', page, quote })

/** The files every member may open, as `extractableFileNames` answers for the project. */
const OPEN_FILES = ['Baubeschreibung.pdf', 'Bescheid.pdf']

function backendAnswer(overrides: Partial<ExperienceResponse> = {}): ExperienceResponse {
  return {
    model: 'test/model',
    documentsRead: ['Baubeschreibung.pdf'],
    fingerprint: [],
    decisions: [],
    error: null,
    ...overrides,
  }
}

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

function answerWith(body: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  )
}

/** The request body the BFF sent, checked against the wire schema. */
function sentRequest() {
  const init = mockFetch.mock.calls[0]?.[1]
  return experienceRequestSchema.parse(JSON.parse(String(init?.body)))
}

/** The assumptions the profile write carried. */
function writtenAssumptions(): Record<string, unknown> {
  const values = vi.mocked(updateProjectProfileIfVersion).mock.calls[0]?.[3]
  return { ...values?.profile.assumptions }
}

function givenProfile(profile: unknown) {
  vi.mocked(findProjectInOrg).mockResolvedValue(makeProject({ id: PROJECT_ID, collectionName: 'proj_col', profile: profile as never }))
  vi.mocked(findProjectProfileInOrg).mockResolvedValue({
    profile: profile as never,
    profileVersion: 5,
    profilePromptView: '',
    profileDisplay: null,
    profileUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  vi.mocked(updateProjectProfileIfVersion).mockImplementation(async (_id, _org, _version, values) => ({
    ...values,
    profileVersion: 6,
  }) as never)
}

describe('extractProjectExperience', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    vi.mocked(requireProjectAccess).mockResolvedValue(undefined as never)
    vi.mocked(listProjectMemory).mockResolvedValue([])
    vi.mocked(createProjectMemoryItemForProject).mockResolvedValue(makeMemoryItem() as never)
    vi.mocked(extractableFileNames).mockResolvedValue(OPEN_FILES)
    givenProfile(emptyProfile)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('checks memory write access first, and refuses a closed project before the backend is asked', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(projectClosedError())

    await expect(extractProjectExperience(session, PROJECT_ID)).rejects.toThrow()

    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT_ID, ['project:memory:write', 'project:edit'])
    expect(mockFetch).not.toHaveBeenCalled()
    expect(updateProjectProfileIfVersion).not.toHaveBeenCalled()
    expect(createProjectMemoryItemForProject).not.toHaveBeenCalled()
  })

  it('writes fingerprint values as unconfirmed assumptions from the agent, with the document as reason', async () => {
    answerWith(
      backendAnswer({
        fingerprint: [
          { key: 'bundesland', value: 'niederoesterreich', evidence: [evidence('Niederösterreich')] },
          { key: 'gebaeudeklasse', value: '4', evidence: [evidence('Gebäudeklasse 4', '3')] },
          { key: 'bauweise', value: ['holzbau', 'stahlbeton'], evidence: [evidence('Holz-Stahlbeton')] },
          { key: 'oib_ausgabe', value: '2019', evidence: [evidence('OIB-RL 2019')] },
        ],
      })
    )

    const result = await extractProjectExperience(session, PROJECT_ID)

    expect(result).toEqual({ suggested: 4, drafted: 0, documentsRead: ['Baubeschreibung.pdf'], error: null })
    expect(writtenAssumptions()).toEqual({
      bundesland: {
        value: 'niederoesterreich',
        status: 'unconfirmed',
        reason: 'Baubeschreibung.pdf, S. 2: „Niederösterreich"',
        source: 'agent_suggested',
        updatedAt: expect.any(String),
      },
      gebaeudeklasse: {
        value: 4,
        status: 'unconfirmed',
        reason: 'Baubeschreibung.pdf, S. 3: „Gebäudeklasse 4"',
        source: 'agent_suggested',
        updatedAt: expect.any(String),
      },
      bauweise: {
        value: ['holzbau', 'stahlbeton'],
        status: 'unconfirmed',
        reason: 'Baubeschreibung.pdf, S. 2: „Holz-Stahlbeton"',
        source: 'agent_suggested',
        updatedAt: expect.any(String),
      },
      oib_ausgabe: {
        value: '2019',
        status: 'unconfirmed',
        reason: 'Baubeschreibung.pdf, S. 2: „OIB-RL 2019"',
        source: 'agent_suggested',
        updatedAt: expect.any(String),
      },
    })
  })

  it('masks the quote it stores as a reason, as a memory note is masked (ADR-0086)', async () => {
    answerWith(
      backendAnswer({
        fingerprint: [{ key: 'gebaeudeklasse', value: '4', evidence: [evidence('Bauwerberin Maria Huber, GK 4')] }],
      })
    )

    await extractProjectExperience(session, PROJECT_ID)

    expect(writtenAssumptions()).toMatchObject({
      gebaeudeklasse: { reason: 'Baubeschreibung.pdf, S. 2: „Bauwerberin [Name], GK 4"' },
    })
  })

  it('asks for a key whose fact holds no value, and suggests it', async () => {
    givenProfile({ ...emptyProfile, facts: { bauweise: { value: null, confidence: 'confirmed', source: 'onboarding', updatedAt: '' } } })
    answerWith(backendAnswer({ fingerprint: [{ key: 'bauweise', value: ['holzbau'], evidence: [evidence('Holzbau')] }] }))

    const result = await extractProjectExperience(session, PROJECT_ID)

    expect(sentRequest().knownFacts).not.toContain('bauweise')
    expect(result.suggested).toBe(1)
  })

  it('skips a key with a confirmed fact, flat or per building (bauweise@bw1)', async () => {
    givenProfile(confirmed('bundesland', 'bauweise@bw1'))
    answerWith(
      backendAnswer({
        fingerprint: [
          { key: 'bundesland', value: 'wien', evidence: [evidence('Wien')] },
          { key: 'bauweise', value: ['holzbau'], evidence: [evidence('Holzbau')] },
          { key: 'gebaeudeklasse', value: '2', evidence: [evidence('GK 2')] },
        ],
      })
    )

    const result = await extractProjectExperience(session, PROJECT_ID)

    expect(sentRequest().knownFacts.sort()).toEqual(['bauweise', 'bundesland'])
    expect(result.suggested).toBe(1)
    expect(Object.keys(writtenAssumptions())).toEqual(['gebaeudeklasse'])
  })

  it('drops a value outside the vocabulary or without evidence, and keeps the rest of the patch', async () => {
    answerWith(
      backendAnswer({
        fingerprint: [
          { key: 'bundesland', value: 'mars', evidence: [evidence('Mars')] },
          { key: 'gebaeudeklasse', value: '4', evidence: [] },
          { key: 'vorhabensart', value: ['neubau'], evidence: [evidence('Neubau')] },
        ],
      })
    )

    const result = await extractProjectExperience(session, PROJECT_ID)

    expect(result.suggested).toBe(1)
    expect(Object.keys(writtenAssumptions())).toEqual(['vorhabensart'])
  })

  it('writes decisions as distillation, source-grounded, with their evidence', async () => {
    answerWith(
      backendAnswer({
        decisions: [
          {
            kind: 'decision',
            content: 'Fluchttreppe außen in Stahl statt eines zweiten Stiegenhauses.',
            outcome: 'accepted',
            evidence: [{ fileName: 'Bescheid.pdf', page: '3', quote: 'Außenstiege' }],
          },
          {
            kind: 'constraint',
            content: 'Brandsperre je Geschoß aus 1 mm Stahlblech.',
            outcome: 'auflage',
            evidence: [{ fileName: 'Bescheid.pdf', page: '', quote: 'Brandsperre' }],
          },
          {
            kind: 'decision',
            content: 'Ohne Beleg, daher nicht gespeichert.',
            outcome: 'unknown',
            evidence: [],
          },
        ],
      })
    )

    const result = await extractProjectExperience(session, PROJECT_ID)

    expect(result.drafted).toBe(2)
    expect(createProjectMemoryItemForProject).toHaveBeenCalledTimes(2)
    expect(createProjectMemoryItemForProject).toHaveBeenNthCalledWith(1, PROJECT_ID, {
      kind: 'decision',
      content: 'Fluchttreppe außen in Stahl statt eines zweiten Stiegenhauses.',
      confidence: 'medium',
      provenanceType: 'distillation',
      verification: 'source_grounded',
      evidence: [{ fileName: 'Bescheid.pdf', page: '3' }],
    })
    expect(createProjectMemoryItemForProject).toHaveBeenNthCalledWith(2, PROJECT_ID, expect.objectContaining({
      kind: 'constraint',
      provenanceType: 'distillation',
      verification: 'source_grounded',
      evidence: [{ fileName: 'Bescheid.pdf', page: null }],
    }))
  })

  it('sends the active decisions cut to 300 characters, and only decisions and constraints', async () => {
    vi.mocked(listProjectMemory).mockResolvedValue([
      makeMemoryItem({ kind: 'decision', content: 'd'.repeat(400) }),
      makeMemoryItem({ kind: 'derived_fact', content: 'Keine Entscheidung' }),
    ])
    answerWith(backendAnswer())

    await extractProjectExperience(session, PROJECT_ID)

    const request = sentRequest()
    expect(request.knownDecisions).toEqual(['d'.repeat(300)])
    expect(request.collection).toBe('proj_col')
    expect(request.organizationId).toBe('org-1')
    expect(mockFetch.mock.calls[0]?.[0]).toBe('http://backend:8000/v1/internal/project-experience')
    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers['x-grid-internal-token']).toBeDefined()
  })

  it.each([
    ['the backend is unreachable', () => mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'))],
    ['the backend answers 500', () => answerWith({ error: 'boom' }, 500)],
    ['the backend answers outside the contract', () => answerWith({ fingerprint: 'nope' })],
  ])('returns backend_unavailable and writes nothing when %s', async (_label, arrange) => {
    arrange()

    const result = await extractProjectExperience(session, PROJECT_ID)

    expect(result).toEqual({ suggested: 0, drafted: 0, documentsRead: [], error: 'backend_unavailable' })
    expect(updateProjectProfileIfVersion).not.toHaveBeenCalled()
    expect(createProjectMemoryItemForProject).not.toHaveBeenCalled()
  })

  it('reports the extractor error and writes nothing when there were no documents', async () => {
    answerWith(backendAnswer({ error: 'no_documents', documentsRead: [] }))

    const result = await extractProjectExperience(session, PROJECT_ID)

    expect(result).toEqual({ suggested: 0, drafted: 0, documentsRead: [], error: 'no_documents' })
    expect(updateProjectProfileIfVersion).not.toHaveBeenCalled()
    expect(createProjectMemoryItemForProject).not.toHaveBeenCalled()
  })

  describe('only from files every member may open (ADR-0090, ADR-0096)', () => {
    it('names the files the backend may read, asked for the project’s main collection', async () => {
      answerWith(backendAnswer())

      await extractProjectExperience(session, PROJECT_ID)

      expect(extractableFileNames).toHaveBeenCalledWith('org-1', PROJECT_ID, 'proj_col')
      expect(sentRequest().fileNames).toEqual(OPEN_FILES)
    })

    it('asks no backend and writes nothing when no file is open to every member', async () => {
      vi.mocked(extractableFileNames).mockResolvedValueOnce([])

      const result = await extractProjectExperience(session, PROJECT_ID)

      expect(result).toEqual({ suggested: 0, drafted: 0, documentsRead: [], error: 'no_documents' })
      expect(mockFetch).not.toHaveBeenCalled()
      expect(updateProjectProfileIfVersion).not.toHaveBeenCalled()
      expect(createProjectMemoryItemForProject).not.toHaveBeenCalled()
    })

    it('writes no value or decision from a file it was not allowed to read, whatever the backend answered', async () => {
      const restricted = { fileName: 'Honorare_vertraulich.pdf', page: '1', quote: 'GK 5' }
      answerWith(
        backendAnswer({
          documentsRead: ['Baubeschreibung.pdf', 'Honorare_vertraulich.pdf'],
          fingerprint: [
            { key: 'gebaeudeklasse', value: '5', evidence: [restricted] },
            { key: 'bundesland', value: 'wien', evidence: [restricted, evidence('Wien')] },
          ],
          decisions: [
            {
              kind: 'decision',
              content: 'Honorar der Statikerin pauschal vereinbart.',
              outcome: 'accepted',
              evidence: [{ ...restricted, quote: 'pauschal' }],
            },
            {
              kind: 'constraint',
              content: 'Brandsperre je Geschoß aus 1 mm Stahlblech.',
              outcome: 'auflage',
              evidence: [{ ...restricted, quote: 'Brandsperre' }, { fileName: 'Bescheid.pdf', page: '3', quote: 'Brandsperre' }],
            },
          ],
        })
      )

      const result = await extractProjectExperience(session, PROJECT_ID)

      expect(result).toEqual({ suggested: 1, drafted: 1, documentsRead: ['Baubeschreibung.pdf'], error: null })
      expect(writtenAssumptions()).toEqual({
        bundesland: expect.objectContaining({ value: 'wien', reason: 'Baubeschreibung.pdf, S. 2: „Wien"' }),
      })
      expect(createProjectMemoryItemForProject).toHaveBeenCalledTimes(1)
      expect(createProjectMemoryItemForProject).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
        content: 'Brandsperre je Geschoß aus 1 mm Stahlblech.',
        evidence: [{ fileName: 'Bescheid.pdf', page: '3' }],
      }))
    })
  })
})
