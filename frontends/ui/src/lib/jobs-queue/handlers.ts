/**
 * What each kind of job does when a worker hands it a slice (ADR-0079).
 *
 * A handler reads the job's saved state, does one bounded step of the work and
 * returns the state to save. It never claims, heartbeats or finishes: the runner
 * owns the queue, this owns the work. That split is why a job survives a
 * restart: nothing a handler holds in memory matters, only what it returned.
 *
 * A walk (`reindex_project`, `reingest_failed`, `restore_folder_bin`) runs as
 * the person who asked, in the job's organization. The runner has no session,
 * so the session is built here, and built from what the identity provider says
 * NOW: the payload names who asked, but a job can wait in the queue and a walk
 * spans many slices, and a person who lost their role or left the organization
 * in the meantime must not have it carry on with the rights they had when they
 * clicked. The services the handlers call then check access per document
 * exactly as they do for a request. `purge_binned_chunks` and
 * `placement_reingest` walk as the system, `project_intake_read` and
 * `filing_review` are one step as the uploader, `revision_notice` one step as
 * the person who made the Fassung, and the other kinds are single
 * steps run as the system
 * (see `./types.ts`).
 */

import 'server-only'
import type { ZodType } from 'zod'
import { resolvePinnedRequesterSession, resolvePinnedRequesterSessionStrict } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  runBimExtractJob,
  runOfficeRenditionJob,
  runReindexSlice,
  runReingestFailedSlice,
} from '@/lib/documents/service'
import { runPurgeBinnedChunksSlice, runRestoreFolderSlice } from '@/lib/projects/folder-bin-jobs'
import { runPlacementReingestSlice } from '@/lib/projects/collection-placement'
import { runMailImportSlice } from '@/lib/mail-import/job'
import { runReportFilingJob } from '@/lib/tasks/service'
import { runPilotiWake } from '@/lib/annotations/wake-job'
import { runPilotiWakeStop } from '@/lib/annotations/wake-stop-job'
import { runIntakeReadSlice } from '@/lib/project-intake/service'
import { runFilingReviewSlice } from '@/lib/filing/job'
import { endRunOfDepartedRequester, runRootSortSlice } from '@/lib/filing/root-sort-run'
import { runInboxPush } from '@/lib/push/inbox-push-job'
import { runDueRemindersSlice } from '@/lib/annotations/due-reminders'
import { runDocumentCheckSlice } from '@/lib/document-check/job'
import { runRevisionNotice } from '@/lib/revision-notice/job'
import { runInboundMailFiling } from '@/lib/inbound-mail/file-job'
import { runInboundMailReceive } from '@/lib/inbound-mail/receive-job'
import { runInboundMailSuggest } from '@/lib/inbound-mail/suggest-job'
import { isLastAttempt } from './attempts'
import {
  annotationDueRemindersPayloadSchema,
  bimExtractPayloadSchema,
  fileResearchReportPayloadSchema,
  filingReviewPayloadSchema,
  inboxPushPayloadSchema,
  mailImportPayloadSchema,
  officeRenditionPayloadSchema,
  pilotiWakePayloadSchema,
  pilotiWakeStopPayloadSchema,
  placementReingestPayloadSchema,
  projectIntakeReadPayloadSchema,
  purgeBinnedChunksPayloadSchema,
  reindexProjectPayloadSchema,
  reingestFailedPayloadSchema,
  restoreFolderBinPayloadSchema,
  revisionNoticePayloadSchema,
  documentCheckPayloadSchema,
  inboundMailFilePayloadSchema,
  inboundMailFollowPayloadSchema,
  inboundMailReceivePayloadSchema,
  inboundMailSuggestPayloadSchema,
  rootSortPayloadSchema,
  type BffJobKind,
  type JobAttempt,
  type JobRequester,
  type JobSliceResult,
} from './types'

/**
 * One bounded step of a job: the state it was saved with in, the state to save out.
 * `attempts` is the claims spent so far, this one included.
 */
export type JobHandler = (job: {
  organizationId: string
  payload: unknown
  attempts: number
}) => Promise<JobSliceResult<object>>

/**
 * Tie a payload schema to its slice function, so the two cannot name different
 * payloads. A stored payload that does not parse throws: a row nobody can read
 * is a failed attempt, not something to guess at.
 *
 * The session is the requester's TODAY (`resolvePinnedRequesterSession`: their
 * membership and role now, no access token), resolved before every slice. A
 * requester who is no longer a member of the organization ends the job quietly,
 * as the slices end it for one who lost the project: nothing is retried, because
 * a retry would be refused the same way.
 */
function handler<TPayload extends { requester: JobRequester }>(
  schema: ZodType<TPayload>,
  slice: (session: AuthorizedSession, payload: TPayload) => Promise<JobSliceResult<TPayload>>
): JobHandler {
  return async ({ organizationId, payload }) => {
    const parsed = schema.parse(payload)
    const { userId, email } = parsed.requester
    const session = await resolvePinnedRequesterSession({ userId, email, organizationId })
    if (!session) {
      console.warn(`[jobs] ${userId} is no longer a member of ${organizationId}; ending a job they asked for`)
      return { done: true, payload: parsed }
    }
    return slice(session, parsed)
  }
}

/**
 * A kind that is one step and runs as the system: it takes no session, finishes
 * in the slice it is given, and throws to have the queue retry it. A step whose
 * failure a retry would not change says so itself and returns.
 */
function systemHandler<TPayload extends object>(
  schema: ZodType<TPayload>,
  step: (organizationId: string, payload: TPayload, attempt: JobAttempt) => Promise<void>
): JobHandler {
  return async ({ organizationId, payload, attempts }) => {
    const parsed = schema.parse(payload)
    await step(organizationId, parsed, { last: isLastAttempt(attempts) })
    return { done: true, payload: parsed }
  }
}

/**
 * A walk that runs as the system: sliced like the person's walks, but with no
 * session, because what it finishes must not depend on who asked (see
 * `./types.ts`). It is told whether this is its last attempt, so it can leave
 * the truth behind before the queue gives up on it.
 */
function systemSliceHandler<TPayload extends object>(
  schema: ZodType<TPayload>,
  slice: (organizationId: string, payload: TPayload, attempt: JobAttempt) => Promise<JobSliceResult<TPayload>>
): JobHandler {
  return async ({ organizationId, payload, attempts }) =>
    slice(organizationId, schema.parse(payload), { last: isLastAttempt(attempts) })
}

/**
 * The mail import's walk. Not {@link handler}: a requester who left must END
 * the import with a reason, because it is a row the person sees, not a quiet
 * no-op. Its retries are its own (`lib/mail-import/job.ts`), not the queue's.
 */
const mailImportHandler: JobHandler = async ({ organizationId, payload }) => {
  const parsed = mailImportPayloadSchema.parse(payload)
  const { userId, email } = parsed.requester
  const session = await resolvePinnedRequesterSession({ userId, email, organizationId })
  return runMailImportSlice(session, parsed, organizationId)
}

/**
 * A wake of Piloti (ADR-0106). Not {@link handler}: it resolves the person
 * itself, because a person who left ends the wake WITH a record on its
 * `piloti_wakes` row, and it may answer „not yet" (`notBefore`) while another
 * turn of the person's thread runs.
 */
const pilotiWakeHandler: JobHandler = async ({ organizationId, payload, attempts }) =>
  runPilotiWake(organizationId, pilotiWakePayloadSchema.parse(payload), { last: isLastAttempt(attempts) })

/**
 * A root sort's slice (ADR-0121). Not {@link handler}: a membership lookup the
 * identity provider did not answer must be retried, not read as "they left",
 * which would end the slice quietly and leave the run working with nothing
 * working on it. So the strict lookup, which throws for the queue to retry;
 * a requester who really left ends their run, so the shelf is not locked.
 */
const rootSortHandler: JobHandler = async ({ organizationId, payload }) => {
  const parsed = rootSortPayloadSchema.parse(payload)
  const { userId, email } = parsed.requester
  const session = await resolvePinnedRequesterSessionStrict({ userId, email, organizationId })
  if (!session) {
    await endRunOfDepartedRequester(organizationId, parsed.runId)
    return { done: true, payload: parsed }
  }
  return runRootSortSlice(session, parsed)
}

/** One handler per kind; the record's type makes a kind without one a compile error. */
export const JOB_HANDLERS: Record<BffJobKind, JobHandler> = {
  reindex_project: handler(reindexProjectPayloadSchema, runReindexSlice),
  reingest_failed: handler(reingestFailedPayloadSchema, runReingestFailedSlice),
  placement_reingest: systemSliceHandler(placementReingestPayloadSchema, runPlacementReingestSlice),
  restore_folder_bin: handler(restoreFolderBinPayloadSchema, runRestoreFolderSlice),
  purge_binned_chunks: systemSliceHandler(purgeBinnedChunksPayloadSchema, runPurgeBinnedChunksSlice),
  bim_extract: systemHandler(bimExtractPayloadSchema, runBimExtractJob),
  office_rendition: systemHandler(officeRenditionPayloadSchema, runOfficeRenditionJob),
  file_research_report: systemHandler(fileResearchReportPayloadSchema, runReportFilingJob),
  mail_import: mailImportHandler,
  piloti_wake: pilotiWakeHandler,
  piloti_wake_stop: systemHandler(pilotiWakeStopPayloadSchema, runPilotiWakeStop),
  project_intake_read: handler(projectIntakeReadPayloadSchema, runIntakeReadSlice),
  filing_review: handler(filingReviewPayloadSchema, runFilingReviewSlice),
  root_sort: rootSortHandler,
  inbox_push: systemHandler(inboxPushPayloadSchema, async (organizationId, payload, attempt) => {
    await runInboxPush(organizationId, payload, attempt)
  }),
  annotation_due_reminders: systemSliceHandler(annotationDueRemindersPayloadSchema, runDueRemindersSlice),
  // Not `handler`: the payload names an actor, not a requester snapshot, and a
  // person who left ends the notice quietly in `runRevisionNotice` itself.
  revision_notice: systemHandler(revisionNoticePayloadSchema, runRevisionNotice),
  // Sliced: start the turn, then wait for its answer; the person is resolved in each slice.
  document_check: systemSliceHandler(documentCheckPayloadSchema, runDocumentCheckSlice),
  // As the system: it reads, scans, labels and holds; it never files (`review-first.spec.ts`).
  inbound_mail_receive: systemHandler(inboundMailReceivePayloadSchema, runInboundMailReceive),
  // As the system, metadata only (D21): it fails open, and it imports no filing code (`review-first.spec.ts`).
  inbound_mail_suggest: systemHandler(inboundMailSuggestPayloadSchema, runInboundMailSuggest),
  // As the person who decided: what a person decided, filed through their own
  // upload path; never anything a decision row does not name (`file-job.ts`).
  inbound_mail_file: handler(inboundMailFilePayloadSchema, runInboundMailFiling),
  // Registered before its work exists (PR-D assembles it from several
  // packages), ending without effect: the reply waits for a person, as it
  // would without a follow.
  inbound_mail_follow: handler(inboundMailFollowPayloadSchema, async (_session, payload) => {
    console.warn(`[jobs] inbound_mail_follow has no step yet; mail ${payload.mailId} waits for a person`)
    return { done: true, payload }
  }),
}
