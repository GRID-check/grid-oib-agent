/**
 * The suggest job (`inbound_mail_suggest`, ADR-0134, DECISION §6 "Suggest"):
 * ask once where a held mail's parts belong, and store the answer on the parts
 * for the person who files it. The rules it applies are `./suggest`'s.
 *
 * Runs AS THE SYSTEM, one step, bulk. The receive job queues it with a job id
 * derived from the mail (`inboundMailJobId('suggest', mailId)`, uuid5), never
 * the mail's id itself, which is the receive job's: `insertJobIfAbsent` would
 * otherwise find the receive job and skip this one.
 *
 * In order, each a reason to ask nothing:
 *  1. Filing suggestions are switched off for the deployment
 *     (`GRID_FILING_SUGGESTIONS=off`, the same switch as an upload's).
 *  2. The mail is gone, decided or not this project's; its sender's domain is
 *     unconfirmed; it is list or bulk mail. The receive job does not queue the
 *     last two, and this re-checks them.
 *  3. The project is closed: nothing can be filed into it.
 *  4. Nothing to place: no attachment with a name that passed the check, and a
 *     text that already matched a Verlauf.
 *  5. The budget is spent, or cannot be read (`unaskedSpendAllowed`,
 *     fail-closed): nobody asked for this call.
 *
 * Then one `filing-fit` generation (`basis: mail`), and the placements stored
 * on the parts that still wait. It fails open: a model or backend failure is
 * logged and the mail simply has no suggestion; only a database failure throws,
 * so the queue retries it. It imports no filing code (`review-first.spec.ts`).
 */

import 'server-only'
import { folderTree, readableByEveryMember } from '@/lib/authz/folder-access-rule'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { unaskedSpendAllowed } from '@/lib/budgets/unasked-spend'
import { hasPassedScreening, SCREENED_ONLY } from '@/lib/documents/document-reader'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { projectShelf } from '@/lib/documents/shelf'
import { docTypesByFolder, officeConventions } from '@/lib/filing/conventions'
import { judgeMailFiling } from '@/lib/filing/judge'
import { listFiledDocuments, listProjectsFolders, type OfficeFolderRow } from '@/lib/filing/repository'
import { filingSuggestionsEnabled } from '@/lib/filing/trigger'
import { MAX_JUDGED_FOLDERS, type FilingConventionInput, type FilingFolderInput } from '@/lib/filing/types'
import type { InboundMailSuggestPayload } from '@/lib/jobs-queue/types'
import { folderPathKey } from '@/lib/projects/folders'
import { isProjectClosed } from '@/lib/projects/project-status'
import { findProjectInOrg, listProjectsInOrg } from '@/lib/projects/repository'
import { publishProjectChanged } from '@/lib/realtime/door-events'
import { chatScreeningRules, maskText } from '@/lib/upload-screening/content-screen'
import { gatePolicy } from '@/lib/upload-screening/service'
import { findMailForReceive, findMailParts, storePartSuggestions } from './repository'
import {
  hasSomethingToPlace,
  mailFilingInput,
  suggestionsFrom,
  suggestionSkipReason,
  type SuggestionSkipReason,
} from './suggest'

/** The language of the reasons a person reads. Product copy is German, as an upload's reasons are. */
const REASON_LOCALE = 'de'
/** How many of the office's most recent other projects lend their folders as conventions. */
const CONVENTION_PROJECTS = 20
/**
 * A folder of another project counts as the office's convention only when at
 * least this many of its projects keep it. The suggestion is shown to everyone
 * who reviews this project's mail, and a folder only one other project keeps
 * may name what that project's members alone should read; a path several keep
 * is how the office files, not one project's matter.
 */
const MIN_CONVENTION_PROJECTS = 2

/** What one run did, for the log line and the specs. */
export type SuggestOutcome =
  | { status: 'skipped'; reason: SuggestionSkipReason }
  | { status: 'failed'; reason: string }
  | { status: 'suggested'; parts: number; traceId: string | null }

const skipped = (reason: SuggestionSkipReason): SuggestOutcome => ({ status: 'skipped', reason })

/** The job's step (`systemHandler`). Throws only for what a retry can fix (the database). */
export async function runInboundMailSuggest(organizationId: string, payload: InboundMailSuggestPayload): Promise<void> {
  const outcome = await suggestForMail(organizationId, payload)
  // Ids and codes only: a mail's names and subject never reach a log line.
  const detail = outcome.status === 'suggested' ? `${outcome.parts} part(s)` : outcome.reason
  console.debug(`[inbound-mail] suggestion for mail ${payload.mailId}: ${outcome.status} (${detail})`)
}

/** Ask once where the mail's parts belong and store the answer. See the module header for the order. */
export async function suggestForMail(organizationId: string, payload: InboundMailSuggestPayload): Promise<SuggestOutcome> {
  if (!filingSuggestionsEnabled()) return skipped('switched_off')
  const mail = await findMailForReceive(payload.mailId)
  if (!mail || mail.projectId !== payload.projectId || mail.organizationId !== organizationId) return skipped('not_waiting')
  const skip = suggestionSkipReason(mail)
  if (skip) return skipped(skip)
  const project = await findProjectInOrg(mail.projectId, organizationId)
  if (!project || isProjectClosed(project)) return skipped('project_closed')

  const parts = await findMailParts([mail.id])
  if (!hasSomethingToPlace(mail, parts)) return skipped('nothing_to_place')
  // Nobody asked for this call: a spent budget, or one nobody can read, ends it.
  if (!(await unaskedSpendAllowed({ organizationId, userId: null }, mail.projectId))) return skipped('budget')

  const folders = await memberReadableFolders(organizationId, mail.projectId)
  const [folderInputs, conventions, maskedSubject] = await Promise.all([
    folderInputsOf(organizationId, mail.projectId, folders),
    conventionsFor(organizationId, mail.projectId, folders.map((folder) => folder.path)),
    maskedSubjectOf(organizationId, mail.projectId, mail.subject),
  ])
  const input = mailFilingInput(mail, parts, { maskedSubject, folders: folderInputs, conventions, locale: REASON_LOCALE })
  if (!input) return skipped('nothing_to_place')
  const judgement = await judgeMailFiling(organizationId, input)
  if (judgement.error) return { status: 'failed', reason: judgement.error }

  const suggestions = suggestionsFrom(judgement.placements, folders)
  const stored = await storePartSuggestions(mail.id, suggestions, judgement.traceId)
  if (stored > 0) publishProjectChanged(organizationId, mail.projectId)
  return { status: 'suggested', parts: stored, traceId: judgement.traceId }
}

/**
 * The project's living folders every member reads (ADR-0087): a folder under
 * its own access list, and everything below it, is never named to the model,
 * since the suggestion is shown to every reviewer of the mail.
 */
async function memberReadableFolders(organizationId: string, projectId: string): Promise<OfficeFolderRow[]> {
  const [rows, tree] = await Promise.all([
    listProjectsFolders(organizationId, [projectId]),
    listProjectFolderTree(organizationId, projectId).then(folderTree),
  ])
  return rows.filter((row) => readableByEveryMember(tree, row.id)).slice(0, MAX_JUDGED_FOLDERS)
}

/** The folders as the judgement reads them, each with the Dokumentarten its screened documents carry. */
async function folderInputsOf(
  organizationId: string,
  projectId: string,
  folders: readonly OfficeFolderRow[],
): Promise<FilingFolderInput[]> {
  const paths = new Map(folders.map((folder) => [folder.id, folder.path]))
  const filed = await listFiledDocuments(organizationId, projectShelf(projectId), SCREENED_ONLY)
  const read = await reconcileDocumentStatuses(filed, organizationId)
  const docTypes = docTypesByFolder(
    read
      // A document in a folder not every member reads lends nothing: its folder is not offered.
      .filter((row) => hasPassedScreening(row) && row.folderId !== null && paths.has(row.folderId))
      .map((row) => ({ folderPath: paths.get(row.folderId as string) ?? '', tags: row.tags })),
  )
  return folders.map((folder) => ({
    path: folder.path,
    description: folder.description,
    docTypes: docTypes.get(folderPathKey(folder.path)) ?? [],
  }))
}

/**
 * The office's conventions: the folders its other recent projects keep, each
 * kept by at least {@link MIN_CONVENTION_PROJECTS}, or the Austrian default
 * when there are none. Run as the system there is no person whose projects
 * could bound it, so the bound is that a convention is shared.
 */
async function conventionsFor(
  organizationId: string,
  projectId: string,
  existingPaths: readonly string[],
): Promise<FilingConventionInput[]> {
  const recent = (await listProjectsInOrg(organizationId, { limit: CONVENTION_PROJECTS + 1 }))
    .filter((project) => project.id !== projectId)
    .slice(0, CONVENTION_PROJECTS)
  const rows = await listProjectsFolders(
    organizationId,
    recent.map((project) => project.id),
  )
  const conventions = officeConventions(rows, existingPaths)
  const shared = conventions.filter((convention) => convention.projects === 0 || convention.projects >= MIN_CONVENTION_PROJECTS)
  // Nothing shared to learn from: the default, as for an office with no other project.
  return shared.length > 0 ? shared : officeConventions([], existingPaths)
}

/** The subject as every reader of the mail sees it: through the office's content check. */
async function maskedSubjectOf(organizationId: string, projectId: string, subject: string | null): Promise<string | null> {
  if (!subject) return null
  return maskText(subject, chatScreeningRules(await gatePolicy(organizationId, projectId))).text
}
