/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import type { GitHubIssueSender } from '@/lib/github/issues'
import { feedbackIssueDraft, fileProductFeedbackIssue } from './github'

const report = {
  id: '7b6a2c1e-0000-4000-8000-000000000001',
  kind: 'bug' as const,
  message: 'Der Upload bleibt bei 99 % stehen.\nBitte an @maria weiterleiten, maria@buero.test',
  pagePath: '/app/projects',
  context: { viewport: '1440x900', appVersion: '2026.9.30' },
  createdAt: new Date('2026-09-29T08:00:00Z'),
}

function sender(send: GitHubIssueSender['send']): () => GitHubIssueSender {
  return () => ({ repo: 'o/r', send })
}

afterEach(() => {
  delete process.env.WORKOS_REDIRECT_URI
})

describe('feedbackIssueDraft', () => {
  const draft = feedbackIssueDraft(report, 'https://app.piloti.at')

  it('titles the issue with the first line of the message', () => {
    expect(draft.title).toBe('Feedback: Der Upload bleibt bei 99 % stehen.')
  })

  it('links the report on the triage page, where the reporter is', () => {
    expect(draft.body).toContain(
      `[${report.id}](https://app.piloti.at/app/platform/feedback?report=${report.id})`,
    )
  })

  it('scrubs contact details and quotes the message inertly', () => {
    expect(draft.body).not.toContain('maria@buero.test')
    // Inside a fence, so the @-mention pings nobody.
    expect(draft.body).toMatch(/```text\nDer Upload bleibt bei 99 % stehen\.\nBitte an @maria[^\n]*\n```/)
  })

  it('carries the page and the browser context, never who sent it', () => {
    expect(draft.body).toContain('`/app/projects`')
    expect(draft.body).toContain('Viewport: 1440x900')
    expect(draft.body).toContain('Version: 2026.9.30')
    expect(draft.labels).toEqual(['bug', 'user-feedback'])
  })

  it('names the report by id when the deployment pins no origin', () => {
    expect(feedbackIssueDraft(report, null).body).toContain(`**Report:** \`${report.id}\``)
  })
})

describe('fileProductFeedbackIssue', () => {
  it('files a bug and reports the issue', async () => {
    process.env.WORKOS_REDIRECT_URI = 'https://app.piloti.at/api/auth/callback'
    const send = vi.fn(async () => ({ number: 12, url: 'https://github.com/o/r/issues/12' }))

    const result = await fileProductFeedbackIssue(report, sender(send))

    expect(result).toEqual({ status: 'filed', number: 12, url: 'https://github.com/o/r/issues/12' })
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('https://app.piloti.at/app/platform/feedback') }),
    )
  })

  it.each(['idea', 'praise', 'question'] as const)('leaves %s on the triage page', async (kind) => {
    const send = vi.fn()
    expect(await fileProductFeedbackIssue({ ...report, kind }, sender(send))).toEqual({
      status: 'skipped',
      reason: 'kind',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('files nothing when no sender is configured', async () => {
    expect(await fileProductFeedbackIssue(report, () => null)).toEqual({ status: 'skipped', reason: 'not-configured' })
  })

  it('swallows a GitHub failure: the report is already stored', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const send = vi.fn(async () => {
      throw new Error('GitHub refused an issue in o/r: 401')
    })

    expect(await fileProductFeedbackIssue(report, sender(send))).toEqual({ status: 'failed' })
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
