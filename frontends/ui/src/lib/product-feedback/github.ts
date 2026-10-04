/**
 * Filing a member's bug report as a GitHub issue.
 *
 * The second place a stored report goes, beside the inbox announcement
 * (`announce.ts`): the platform owners hear about it in the app, and the bug
 * lands where the fix will be tracked. Only bug reports go; an idea, praise
 * or a question is triaged on the platform page and has no business in the
 * issue tracker until someone decides it does.
 *
 * ## What leaves the tier
 *
 * The issue repository is not the tenant boundary, so the issue carries what a
 * developer needs to reproduce the bug and nothing that says who sent it:
 *
 *   - the message, PII-scrubbed (`redactPii`) and quoted in a fence, so a
 *     stray `@name` pings nobody and a pasted image link loads nothing;
 *   - the page, and the browser context the reporter was shown before sending;
 *   - a link to the report on the triage page, which is where the reporter, the
 *     organization and the unscrubbed text are, behind platform access.
 *
 * No name, no email, no organization. The link is the join.
 *
 * ## Fail-open, like the announcement
 *
 * The report is stored before this runs and the triage page lists it either
 * way. GitHub being down, or the token being revoked, must not turn the
 * reporter's "thank you" into an error, so failures are logged and swallowed.
 */

import 'server-only'
import { configuredAppOrigin } from '@/lib/app-origin'
import type { ProductFeedback } from '@/lib/db/schema'
import { githubIssueSenderFromEnv, type GitHubIssueDraft, type GitHubIssueSender } from '@/lib/github/issues'
import { fencedBlock } from '@/lib/text/code-fence'
import { redactPii } from '@/lib/text/redact-pii'
import type { ProductFeedbackContext, ProductFeedbackKind } from './types'

/** The variable naming the repository bug reports are filed into. Unset: filing is off. */
export const FEEDBACK_ISSUES_REPO_ENV = 'GRID_FEEDBACK_ISSUES_REPO'

/** The kinds that become an issue. */
export const FEEDBACK_ISSUE_KINDS: ReadonlySet<ProductFeedbackKind> = new Set(['bug'])

/** `bug` is GitHub's default label; `user-feedback` tells these apart from err2issue's. */
export const FEEDBACK_ISSUE_LABELS = ['bug', 'user-feedback'] as const

const TITLE_EXCERPT_MAX = 80

const CONTEXT_LABELS: ReadonlyArray<[keyof ProductFeedbackContext, string]> = [
  ['appVersion', 'Version'],
  ['userAgent', 'Browser'],
  ['viewport', 'Viewport'],
  ['locale', 'Locale'],
  ['timeZone', 'Time zone'],
]

type ReportFacts = Pick<ProductFeedback, 'id' | 'kind' | 'message' | 'pagePath' | 'context' | 'createdAt'>

/** The first line of the scrubbed message, short enough for a title. */
function titleExcerpt(scrubbed: string): string {
  const firstLine = scrubbed.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
  const flat = firstLine.replace(/\s+/g, ' ')
  return flat.length > TITLE_EXCERPT_MAX ? `${flat.slice(0, TITLE_EXCERPT_MAX - 1)}…` : flat
}

/** The issue for one report. Pure; exported for tests. */
export function feedbackIssueDraft(report: ReportFacts, appOrigin: string | null): GitHubIssueDraft {
  const scrubbed = redactPii(report.message.trim())
  const triagePath = `/app/platform/feedback?report=${encodeURIComponent(report.id)}`
  const triageLink = appOrigin ? `[${report.id}](${appOrigin}${triagePath})` : `\`${report.id}\``

  const context = CONTEXT_LABELS.flatMap(([key, label]) => {
    const value = report.context?.[key]
    return value ? [`${label}: ${value}`] : []
  })

  const body = [
    'Reported by a member through the in-app feedback form.',
    '',
    `**Report:** ${triageLink} (reporter and organization are on the triage page)`,
    // A path cannot hold whitespace (the schema drops it), but it can hold a
    // backtick, which would close the code span early.
    `**Page:** ${report.pagePath ? `\`${report.pagePath.replaceAll('`', '')}\`` : 'unknown'}`,
    `**Sent:** ${new Date(report.createdAt).toISOString()}`,
    '',
    fencedBlock(scrubbed),
    ...(context.length ? ['', '**Browser**', '', fencedBlock(context.join('\n'))] : []),
  ].join('\n')

  return {
    title: `Feedback: ${titleExcerpt(scrubbed) || 'bug report'}`,
    body,
    labels: FEEDBACK_ISSUE_LABELS,
  }
}

export type FeedbackIssueFiling =
  | { status: 'filed'; number: number; url: string }
  | { status: 'skipped'; reason: 'kind' | 'not-configured' }
  | { status: 'failed' }

/**
 * File one stored report as a GitHub issue when its kind calls for one and a
 * sender is configured. Never throws.
 *
 * `sender` is resolved from the environment by default; tests pass one.
 */
export async function fileProductFeedbackIssue(
  report: ReportFacts,
  sender: () => GitHubIssueSender | null = () => githubIssueSenderFromEnv(FEEDBACK_ISSUES_REPO_ENV)
): Promise<FeedbackIssueFiling> {
  if (!FEEDBACK_ISSUE_KINDS.has(report.kind)) return { status: 'skipped', reason: 'kind' }
  try {
    const github = sender()
    if (!github) return { status: 'skipped', reason: 'not-configured' }
    const issue = await github.send(feedbackIssueDraft(report, configuredAppOrigin()))
    return { status: 'filed', ...issue }
  } catch (error) {
    console.error(`[product-feedback] filing report ${report.id} as a GitHub issue failed:`, error)
    return { status: 'failed' }
  }
}
