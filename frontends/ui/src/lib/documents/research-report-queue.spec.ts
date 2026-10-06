/**
 * @vitest-environment node
 *
 * The two doors a finished report goes through before a job renders it
 * (ADR-0078): the probe that says "already filed", and the enqueue that hands
 * the rest to the `bff-jobs` pool, one job per run. What the job then does is
 * `lib/tasks/service.spec.ts`; what the PDF contains is `research-report.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./generated', () => ({ fileGeneratedDocument: vi.fn() }))
vi.mock('@/lib/pdf/markdown-pdf', () => ({ PDF_MEDIA_TYPE: 'application/pdf', renderMarkdownPdf: vi.fn() }))
vi.mock('@/i18n/server', () => ({ getTranslations: vi.fn(), getLocale: vi.fn() }))
vi.mock('./lifecycle', () => ({ createDocumentVersion: vi.fn(), transitionDocumentVersion: vi.fn() }))
vi.mock('./version-repository', () => ({ findOpenVersion: vi.fn() }))
vi.mock('./repository', () => ({ findDocumentInOrg: vi.fn(), findDocumentAuthoredByRef: vi.fn() }))
vi.mock('./branding', () => ({ resolveDocumentBranding: vi.fn() }))
vi.mock('@/lib/organizations/service', () => ({ getOrganizationDisplayName: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn() }))
vi.mock('@/lib/jobs-queue/repository', () => ({ findOpenJobId: vi.fn() }))

import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import type { FileResearchReportPayload } from '@/lib/jobs-queue/types'
import { findFiledResearchReport, queueResearchReportFiling } from './research-report'
import { findDocumentAuthoredByRef } from './repository'

const payload: FileResearchReportPayload = {
  runId: 'backend-job-1',
  projectId: 'proj-1',
  report: '# Bericht',
  taskRunId: 'run-1',
  requester: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findOpenJobId).mockResolvedValue(null)
  vi.mocked(enqueueJob).mockResolvedValue({ jobId: 'job-new' })
})

describe('queueResearchReportFiling', () => {
  it('queues one interactive job in the organization’s lane, carrying the whole payload', async () => {
    await expect(queueResearchReportFiling({ organizationId: 'org_1', payload })).resolves.toEqual({ jobId: 'job-new' })

    // Interactive: the answer to a run somebody waited minutes for must not sit
    // behind that office's own reindex.
    expect(enqueueJob).toHaveBeenCalledWith({
      kind: 'file_research_report',
      organizationId: 'org_1',
      priority: 0,
      payload,
    })
  })

  it('returns the job already open for the run instead of queueing a second', async () => {
    vi.mocked(findOpenJobId).mockResolvedValue('job-open')

    await expect(queueResearchReportFiling({ organizationId: 'org_1', payload })).resolves.toEqual({ jobId: 'job-open' })

    // The run's id is the key: whoever asked first, the filing is the same one.
    expect(findOpenJobId).toHaveBeenCalledWith({
      kind: 'file_research_report',
      organizationId: 'org_1',
      matching: { runId: 'backend-job-1' },
    })
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('lets a failure reach the caller, which records it', async () => {
    vi.mocked(enqueueJob).mockRejectedValue(new Error('database gone'))

    await expect(queueResearchReportFiling({ organizationId: 'org_1', payload })).rejects.toThrow('database gone')
  })
})

describe('findFiledResearchReport', () => {
  it('answers from the same key the filing is idempotent on: the run, in this project, as a research report', async () => {
    vi.mocked(findDocumentAuthoredByRef).mockResolvedValue({ id: 'doc-1', filename: 'bericht.pdf', folderId: 'folder-1' })

    await expect(
      findFiledResearchReport({ organizationId: 'org_1', projectId: 'proj-1', runId: 'backend-job-1' })
    ).resolves.toEqual({ documentId: 'doc-1', filename: 'bericht.pdf', folderId: 'folder-1', alreadyFiled: true })

    expect(findDocumentAuthoredByRef).toHaveBeenCalledWith('backend-job-1', 'org_1', 'proj-1', 'deep_research')
  })

  it('is null for a report nobody has filed', async () => {
    vi.mocked(findDocumentAuthoredByRef).mockResolvedValue(null)

    await expect(
      findFiledResearchReport({ organizationId: 'org_1', projectId: 'proj-1', runId: 'backend-job-1' })
    ).resolves.toBeNull()
  })
})
