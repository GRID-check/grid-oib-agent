/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { createGitHubIssueSender, GITHUB_ISSUE_TITLE_MAX, githubIssueSenderFromEnv } from './issues'

function answering(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

afterEach(() => {
  delete process.env.GRID_GITHUB_TOKEN
  delete process.env.GRID_TEST_ISSUES_REPO
})

describe('createGitHubIssueSender', () => {
  it('posts the draft to the repository and returns the issue', async () => {
    const fetch = answering(201, { number: 42, html_url: 'https://github.com/o/r/issues/42' })
    const sender = createGitHubIssueSender({ token: 'tok', repo: 'GRID-check/grid-oib-agent', fetch })

    const issue = await sender.send({ title: '  Upload hangs  ', body: 'body', labels: ['bug'] })

    expect(issue).toEqual({ number: 42, url: 'https://github.com/o/r/issues/42' })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/GRID-check/grid-oib-agent/issues')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Upload hangs', body: 'body', labels: ['bug'] })
  })

  it('clips a title GitHub would refuse', async () => {
    const fetch = answering(201, { number: 1, html_url: 'u' })
    await createGitHubIssueSender({ token: 't', repo: 'o/r', fetch }).send({ title: 'x'.repeat(400), body: '' })

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).title).toHaveLength(GITHUB_ISSUE_TITLE_MAX)
  })

  it('omits labels when there are none', async () => {
    const fetch = answering(201, { number: 1, html_url: 'u' })
    await createGitHubIssueSender({ token: 't', repo: 'o/r', fetch }).send({ title: 't', body: 'b' })

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).not.toHaveProperty('labels')
  })

  it('throws with GitHub’s status on a refusal', async () => {
    const fetch = answering(401, { message: 'Bad credentials' })
    const sender = createGitHubIssueSender({ token: 't', repo: 'o/r', fetch })

    await expect(sender.send({ title: 't', body: 'b' })).rejects.toThrow(/401.*Bad credentials/)
  })

  it('refuses a repository that is not owner/repo', () => {
    expect(() => createGitHubIssueSender({ token: 't', repo: 'https://github.com/o/r' })).toThrow('owner/repo')
    expect(() => createGitHubIssueSender({ token: 't', repo: 'o/r/../x' })).toThrow('owner/repo')
  })
})

describe('githubIssueSenderFromEnv', () => {
  it('is off without the token', () => {
    process.env.GRID_TEST_ISSUES_REPO = 'o/r'
    expect(githubIssueSenderFromEnv('GRID_TEST_ISSUES_REPO')).toBeNull()
  })

  it('is off without the repository variable', () => {
    process.env.GRID_GITHUB_TOKEN = 'tok'
    expect(githubIssueSenderFromEnv('GRID_TEST_ISSUES_REPO')).toBeNull()
  })

  it('files into the repository the variable names', () => {
    process.env.GRID_GITHUB_TOKEN = 'tok'
    process.env.GRID_TEST_ISSUES_REPO = ' o/r '
    expect(githubIssueSenderFromEnv('GRID_TEST_ISSUES_REPO')?.repo).toBe('o/r')
  })
})
