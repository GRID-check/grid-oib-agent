/**
 * The research plan primitive (ADR-0065): propose, read, edit, hold, start,
 * and the worker's claim.
 *
 * One rule per transition, stated once here and nowhere else:
 *
 * - A plan is PROPOSED with a clock (`startsAt`) under `auto`, HELD without
 *   one under `ask`, and APPROVED outright when a person wrote it.
 * - Any touch by a person while the clock runs — an edit, „Anpassen" — holds
 *   the plan. A reader who is changing it has said "not yet".
 * - „Starten" approves; the worker's next claim starts.
 * - The worker's claim starts an approved plan or a proposed one whose clock
 *   has passed, and otherwise answers "not yet" as data, not as an error: a
 *   waiting run is the normal case, and the worker polls.
 * - Once STARTED the plan is read-only. The worker read it at that instant;
 *   an edit after it would describe a plan the run is not running.
 *
 * Documents are named by file name and resolved here against the plan's own
 * inventory, once, for every client — the same rule `plan_documents.py` kept
 * for the chat path: a name the inventory does not carry is dropped, and an
 * exclusion beats a Grundlage mark for the same name.
 */

import 'server-only'
import { ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { ResearchPlanRow } from '@/lib/db/schema'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import {
  EDITABLE_PLAN_STATUSES,
  MAX_PLAN_GRACE_SECONDS,
  MAX_PLAN_INVENTORY_ROWS,
  isEditablePlanStatus,
  type PlanAuthor,
  type PlanStartPolicy,
  type ResearchPlan,
  type ResearchPlanDraft,
  type ResearchPlanEdit,
} from '@/lib/plans/plan-types'
import { MAX_PLAN_DOCUMENTS, type PlanDocument } from '@/lib/runs/plan-documents'
import { COMMISSION_PERMISSIONS, commissionResearchRun, type CommissionedResearchRun } from '@/lib/tasks/delegation'
import * as repository from './repository'

/** How long a proposed plan waits before it starts on its own, unless a deployment says otherwise. */
export const DEFAULT_PLAN_GRACE_SECONDS = 45

/** How soon the worker should ask again when a plan is not ready. */
export const PLAN_START_RETRY_SECONDS = 3

export type PlanStart = { policy: PlanStartPolicy; graceSeconds?: number | null } | 'approved'

export interface ProposePlanInput {
  projectId: string
  conversationId: string | null
  draft: ResearchPlanDraft
  author: PlanAuthor
  start: PlanStart
  /** The clarifier's Q&A, handed to the worker beside the plan. */
  context?: string | null
}

export interface PlannedRun {
  plan: ResearchPlan
  run: CommissionedResearchRun
}

export interface PlanStartClaim {
  started: boolean
  plan: ResearchPlan
  retryAfterSeconds?: number
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null)

export function toWirePlan(row: ResearchPlanRow): ResearchPlan {
  return {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    runId: row.runId,
    author: row.author,
    status: row.status,
    question: row.question,
    title: row.title,
    sections: row.sections,
    genre: row.genre,
    depth: row.depth,
    grundlage: row.grundlage,
    ausgeschlossen: row.ausgeschlossen,
    nurGrundlage: row.nurGrundlage,
    dataSources: row.dataSources ?? null,
    unterlagen: row.unterlagen,
    startsAt: iso(row.startsAt),
    heldAt: iso(row.heldAt),
    approvedAt: iso(row.approvedAt),
    startedAt: iso(row.startedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

const fold = (name: string): string => name.trim().toLocaleLowerCase()

/**
 * The documents a list of names means, against the inventory. Matched on the
 * file name or the display title, case-folded; unknown names are dropped, so
 * a run is never told to read a file nobody can find.
 */
export function resolveNamedDocuments(names: readonly string[], inventory: readonly PlanDocument[]): PlanDocument[] {
  const byKey = new Map<string, PlanDocument>()
  for (const doc of inventory) {
    byKey.set(fold(doc.name), doc)
    if (doc.title) byKey.set(fold(doc.title), doc)
  }
  const out: PlanDocument[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const doc = byKey.get(fold(name))
    if (!doc || seen.has(fold(doc.name))) continue
    seen.add(fold(doc.name))
    out.push(doc)
    if (out.length >= MAX_PLAN_DOCUMENTS) break
  }
  return out
}

/**
 * The plan's inventory with the documents a reader brought from the project
 * listing. What the plan already names comes first and the additions next,
 * so neither is the row the cap drops.
 */
function mergeInventory(
  row: Pick<ResearchPlan, 'grundlage' | 'ausgeschlossen' | 'unterlagen'>,
  added: readonly PlanDocument[]
): PlanDocument[] {
  const seen = new Set<string>()
  const out: PlanDocument[] = []
  for (const doc of [...row.grundlage, ...row.ausgeschlossen, ...added, ...row.unterlagen]) {
    const key = fold(doc.name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(doc)
    if (out.length >= MAX_PLAN_INVENTORY_ROWS) break
  }
  return out
}

/** Both lists resolved; an exclusion beats a Grundlage mark for the same name. */
function resolveDocumentLists(
  grundlage: readonly string[],
  ausgeschlossen: readonly string[],
  inventory: readonly PlanDocument[]
): Pick<ResearchPlan, 'grundlage' | 'ausgeschlossen'> {
  const excluded = resolveNamedDocuments(ausgeschlossen, inventory)
  const excludedKeys = new Set(excluded.map((doc) => fold(doc.name)))
  const read = resolveNamedDocuments(grundlage, inventory).filter((doc) => !excludedKeys.has(fold(doc.name)))
  return { grundlage: read, ausgeschlossen: excluded }
}

function startColumns(start: PlanStart, now: Date): Pick<ResearchPlanRow, 'status' | 'startsAt' | 'heldAt' | 'approvedAt'> {
  if (start === 'approved') return { status: 'approved', startsAt: null, heldAt: null, approvedAt: now }
  if (start.policy === 'ask') return { status: 'held', startsAt: null, heldAt: now, approvedAt: null }
  const grace = Math.min(Math.max(start.graceSeconds ?? DEFAULT_PLAN_GRACE_SECONDS, 0), MAX_PLAN_GRACE_SECONDS)
  return { status: 'proposed', startsAt: new Date(now.getTime() + grace * 1000), heldAt: null, approvedAt: null }
}

/**
 * Propose a plan and commission its run in one step, so a plan without a
 * run and a run without a plan are both impossible. The run waits on the
 * plan from its first second; the block exists from its first second.
 */
export async function proposePlannedRun(session: AuthorizedSession, input: ProposePlanInput): Promise<PlannedRun> {
  await requireProjectAccess(session, input.projectId, [...COMMISSION_PERMISSIONS])
  if (!input.conversationId) throw new ConflictError('A planned run needs the thread it was asked in')
  const now = new Date()
  const { draft } = input
  const documents = resolveDocumentLists(draft.grundlage, draft.ausgeschlossen, draft.unterlagen)
  const inserted = await repository.insertPlan({
    organizationId: session.organizationId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    author: input.author,
    question: draft.question,
    title: draft.title ?? draft.question,
    sections: draft.sections,
    genre: draft.genre,
    depth: draft.depth,
    grundlage: documents.grundlage,
    ausgeschlossen: documents.ausgeschlossen,
    nurGrundlage: draft.nurGrundlage && documents.grundlage.length > 0,
    dataSources: draft.dataSources ?? null,
    unterlagen: draft.unterlagen,
    createdBy: session.userId,
    ...startColumns(input.start, now),
  })
  const plan = toWirePlan(inserted)
  const run = await commissionResearchRun(session, {
    projectId: input.projectId,
    conversationId: input.conversationId,
    question: plan.question,
    context: input.context ?? null,
    dataSources: plan.dataSources,
    documents: { grundlage: plan.grundlage, ausgeschlossen: plan.ausgeschlossen },
    plan: { planId: plan.id, title: plan.title, genre: plan.genre, depth: plan.depth, sections: plan.sections },
  })
  const bound = await repository.updatePlan(plan.id, session.organizationId, { runId: run.runId })
  return { plan: bound ? toWirePlan(bound) : { ...plan, runId: run.runId }, run }
}

async function loadPlan(session: AuthorizedSession, projectId: string, planId: string): Promise<ResearchPlanRow> {
  const row = await repository.findPlanInProject(planId, projectId, session.organizationId)
  if (!row) throw new NotFoundError('Unknown plan')
  return row
}

export async function getPlan(session: AuthorizedSession, projectId: string, planId: string): Promise<ResearchPlan> {
  await requireProjectAccess(session, projectId, 'project:view')
  return toWirePlan(await loadPlan(session, projectId, planId))
}

async function requireEditable(session: AuthorizedSession, projectId: string, planId: string): Promise<ResearchPlanRow> {
  await requireProjectAccess(session, projectId, 'project:view')
  await requireProjectAccess(session, projectId, CHAT_PERMISSIONS)
  const row = await loadPlan(session, projectId, planId)
  if (!isEditablePlanStatus(row.status)) {
    throw new ConflictError(row.status === 'started' ? 'This plan has already started' : 'This plan was replaced')
  }
  return row
}

/**
 * Change the plan. An edit while the clock runs holds it: a reader who is
 * changing the plan has said "not yet", and a run that started under their
 * hands would be running a plan they were still writing.
 */
export async function editPlan(
  session: AuthorizedSession,
  projectId: string,
  planId: string,
  edit: ResearchPlanEdit
): Promise<ResearchPlan> {
  const row = await requireEditable(session, projectId, planId)
  const names = {
    grundlage: edit.grundlage ?? row.grundlage.map((doc) => doc.name),
    ausgeschlossen: edit.ausgeschlossen ?? row.ausgeschlossen.map((doc) => doc.name),
  }
  const hold = row.status === 'proposed' ? { status: 'held' as const, startsAt: null, heldAt: new Date() } : {}
  const inventory = edit.unterlagen ? mergeInventory(row, edit.unterlagen) : row.unterlagen
  const documents = resolveDocumentLists(names.grundlage, names.ausgeschlossen, inventory)
  // „Nur diese" with nothing left to read is no confinement: the switch falls with its last document.
  const nurGrundlage = (edit.nurGrundlage ?? row.nurGrundlage) && documents.grundlage.length > 0
  const updated = await repository.updatePlan(planId, session.organizationId, {
    ...(edit.title !== undefined ? { title: edit.title } : {}),
    ...(edit.sections !== undefined ? { sections: edit.sections } : {}),
    ...(edit.genre !== undefined ? { genre: edit.genre } : {}),
    ...(edit.depth !== undefined ? { depth: edit.depth } : {}),
    ...(edit.unterlagen ? { unterlagen: inventory } : {}),
    ...documents,
    nurGrundlage,
    ...hold,
  }, EDITABLE_PLAN_STATUSES)
  if (!updated) throw new ConflictError('This plan has already started')
  return toWirePlan(updated)
}

/** Stop the clock. Idempotent: a held plan stays held. */
export async function holdPlan(session: AuthorizedSession, projectId: string, planId: string): Promise<ResearchPlan> {
  const row = await requireEditable(session, projectId, planId)
  if (row.status === 'held') return toWirePlan(row)
  const updated = await repository.updatePlan(
    planId,
    session.organizationId,
    { status: 'held', startsAt: null, heldAt: new Date(), approvedAt: null },
    ['proposed', 'approved']
  )
  if (!updated) throw new ConflictError('This plan has already started')
  return toWirePlan(updated)
}

/**
 * „Starten": the run may go at the worker's next claim.
 *
 * Gated like commissioning a run, not like chatting: under `ask` this press
 * IS the decision to spend the project's budget, and a softer gate here would
 * be a way around the one on the commission.
 */
export async function startPlan(session: AuthorizedSession, projectId: string, planId: string): Promise<ResearchPlan> {
  await requireProjectAccess(session, projectId, 'project:view')
  await requireProjectAccess(session, projectId, [...COMMISSION_PERMISSIONS])
  const row = await loadPlan(session, projectId, planId)
  if (row.status === 'started' || row.status === 'approved') return toWirePlan(row)
  if (row.status === 'superseded') throw new ConflictError('This plan was replaced')
  const updated = await repository.updatePlan(
    planId,
    session.organizationId,
    { status: 'approved', startsAt: null, approvedAt: new Date() },
    ['proposed', 'held']
  )
  // Lost a race with the worker, which is the outcome „Starten" asked for.
  return toWirePlan(updated ?? (await loadPlan(session, projectId, planId)))
}

/**
 * The worker's claim: may this run start, and with which plan?
 *
 * Identity comes from the row, never from the body — the worker holds a plan
 * id and nothing else, so the lookup runs under platform access and the
 * write re-enters the row's own tenant. "Not yet" is data (`started: false`
 * with a retry hint), because a waiting run is the normal case; a replaced
 * plan is the one refusal, since no run should start on it.
 */
export async function claimPlanStart(planId: string, now: Date = new Date()): Promise<PlanStartClaim> {
  const row = await withPlatformAccess(
    'plan start: the worker names a plan by id, before any organization is known',
    () => repository.findPlanById(planId)
  )
  if (!row) throw new NotFoundError('Unknown plan')
  return withTenant({ organizationId: row.organizationId }, async () => {
    if (row.status === 'started') return { started: true, plan: toWirePlan(row) }
    if (row.status === 'superseded') throw new ConflictError('This plan was replaced')
    const due = row.status === 'approved' || (row.status === 'proposed' && !!row.startsAt && row.startsAt <= now)
    if (!due) return { started: false, plan: toWirePlan(row), retryAfterSeconds: PLAN_START_RETRY_SECONDS }
    // Conditioned on the status that was read: a reader's hold that landed
    // between the read and this write wins, and the worker asks again.
    const updated = await repository.updatePlan(
      planId,
      row.organizationId,
      { status: 'started', startsAt: null, startedAt: now },
      [row.status]
    )
    if (!updated) return { started: false, plan: toWirePlan(row), retryAfterSeconds: PLAN_START_RETRY_SECONDS }
    return { started: true, plan: toWirePlan(updated) }
  })
}
