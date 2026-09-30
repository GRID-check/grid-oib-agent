/**
 * Filing GitHub issues from the BFF: the one place this tier writes to GitHub.
 *
 * A {@link GitHubIssueSender} is bound to one repository and does one thing,
 * open an issue. Anything that wants a GitHub issue (product feedback today)
 * builds a {@link GitHubIssueDraft} and hands it to a sender; it never talks to
 * the API itself. The seam has the same shape as the inbox's email sender
 * (`@/lib/inbox/delivery`): the caller decides WHAT is said, the sender decides
 * HOW it leaves.
 *
 * ## The token
 *
 * `GRID_GITHUB_TOKEN` is the PAT err2issue already files error issues with
 * (ADR-0031). Pulumi hands it to the frontend from the same stack secret, so
 * there is one credential with Issues read/write on the repo, not two. Each use
 * names its own repository variable (`GRID_FEEDBACK_ISSUES_REPO`, …): that
 * variable is the per-use switch, and a use whose variable is unset gets no
 * sender and files nothing.
 *
 * ## Why a fetch and not Octokit
 *
 * One endpoint, one POST. `@octokit/rest` would bring the whole REST surface
 * and its plugin system into the server bundle for a call that is five headers
 * and a JSON body. Reach for it when a second endpoint arrives.
 */

import 'server-only'

/** The token every sender authenticates with. */
export const GITHUB_TOKEN_ENV = 'GRID_GITHUB_TOKEN'

const GITHUB_API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
/** GitHub refuses a longer title with a 422. */
export const GITHUB_ISSUE_TITLE_MAX = 256
/** GitHub refuses a longer body with a 422. */
export const GITHUB_ISSUE_BODY_MAX = 65_536
/** A submit path waits on this, so a slow GitHub must not hold a request open. */
const REQUEST_TIMEOUT_MS = 10_000

/** `owner/repo`, as GitHub spells them. */
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

export interface GitHubIssueDraft {
  title: string
  /** GitHub-flavoured markdown. The caller is responsible for what it quotes. */
  body: string
  /** Created on the repository if missing; silently dropped if the token lacks push access. */
  labels?: readonly string[]
}

export interface FiledGitHubIssue {
  number: number
  url: string
}

export interface GitHubIssueSender {
  /** `owner/repo` the sender files into. */
  readonly repo: string
  /** Open one issue. Throws on any non-2xx answer or a timeout. */
  send(draft: GitHubIssueDraft): Promise<FiledGitHubIssue>
}

export interface GitHubIssueSenderOptions {
  token: string
  repo: string
  /** Injected in tests. */
  fetch?: typeof fetch
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A sender for one repository. Throws if the repository is not `owner/repo`. */
export function createGitHubIssueSender(options: GitHubIssueSenderOptions): GitHubIssueSender {
  const { token, repo } = options
  const doFetch = options.fetch ?? fetch
  if (!REPO_PATTERN.test(repo)) throw new Error(`GitHub repository must be "owner/repo", got "${repo}"`)
  if (!token) throw new Error('GitHub token is empty')

  return {
    repo,
    async send(draft) {
      const response = await doFetch(`${GITHUB_API}/repos/${repo}/issues`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'piloti-bff',
          'X-GitHub-Api-Version': API_VERSION,
        },
        body: JSON.stringify({
          title: clip(draft.title.trim(), GITHUB_ISSUE_TITLE_MAX),
          body: clip(draft.body, GITHUB_ISSUE_BODY_MAX),
          ...(draft.labels?.length ? { labels: [...draft.labels] } : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        // GitHub's error body names the problem ("Bad credentials", "Not
        // Found" for a token without access); it never echoes the token.
        const detail = (await response.text().catch(() => '')).slice(0, 300)
        throw new Error(`GitHub refused an issue in ${repo}: ${response.status} ${detail}`)
      }
      const issue = (await response.json()) as { number?: unknown; html_url?: unknown }
      if (typeof issue.number !== 'number' || typeof issue.html_url !== 'string') {
        throw new Error(`GitHub answered an issue in ${repo} without a number or URL`)
      }
      return { number: issue.number, url: issue.html_url }
    },
  }
}

/**
 * The sender for the repository named by `repoEnv`, or null when the token or
 * that variable is unset. Null is the off state, not an error: a deployment
 * without the token files nothing and says nothing.
 *
 * A set but malformed repository throws, so a typo in the stack surfaces on the
 * first use instead of looking like "off".
 */
export function githubIssueSenderFromEnv(repoEnv: string): GitHubIssueSender | null {
  const token = process.env[GITHUB_TOKEN_ENV]?.trim()
  const repo = process.env[repoEnv]?.trim()
  if (!token || !repo) return null
  return createGitHubIssueSender({ token, repo })
}
