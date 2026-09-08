/**
 * The Projektregister's service: one rebuild, four write-through calls, one
 * bounded reconcile, and readable recall (ADR-0054, spec PR-5…PR-9, PR-16).
 *
 * ## The single writer
 *
 * The BFF is the only thing that writes a Steckbrief, exactly as it is the
 * only thing that writes memory (ADR-0008). Everything in here that changes a
 * row goes through {@link rebuildProjectRegisterRow} or
 * {@link markProjectRegisterStale}; the agent has no write path to the
 * register at all, so a hallucinated project fact cannot become a stored one.
 *
 * ## Why write-through is a stale stamp and not a rebuild
 *
 * A rebuild reads four tables, composes 3000 characters and embeds them. A
 * memory write happens several times in one turn. Doing the full rebuild
 * inline would put that on the agent's critical path for no benefit — the
 * office reads the register at turn START — so the writers stamp `stale_at`
 * and the bounded reconcile does the work (spec PR-6, PR-7). The one exception
 * is deliberate: nothing here rebuilds synchronously either, so the WORST case
 * is a Steckbrief one reconcile interval old, pointing at the right project
 * with slightly old facts. ADR-0054 names that as the accepted cost.
 *
 * ## Readability is computed per caller, never cached
 *
 * `recallSteckbriefe` ranks first and filters second, over-fetching so that a
 * member who may read three of forty projects gets three hits rather than
 * none. The filter itself is the SAME per-project FGA check the projects grid
 * uses (`lib/projects/service.ts`), so the office and the grid cannot disagree
 * about what a member may see (spec AC-3, AC-4, PR-16).
 */

import 'server-only'
import { embedNote } from '@/lib/knowledge/embeddings'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { checkResourcePermission } from '@/lib/authz/resource-check'
import { filterReadableProjects } from '@/lib/authz/projects'
import type { AuthorizedSession } from '@/lib/auth/types'
import { buildProjectSteckbrief } from './steckbrief'
import {
  listRegisterCandidates,
  listRegisterWorkBatch,
  loadRegisterSources,
  markRegisterRowStale,
  upsertProjectRegisterRow,
  type RegisterCandidate,
} from './register-repository'

/**
 * One reconcile call does at most this much work.
 *
 * Bounded like `api/internal/collaboration/prune`: a backlog is worked off
 * over several ticks rather than in one long transaction against a table the
 * office reads on every turn. Fifty rebuilds is a few seconds of embedding
 * calls, which is well inside a scheduler tick.
 */
export const REGISTER_RECONCILE_BATCH = 50

/** Default and ceiling for how many Steckbriefe one recall returns. */
export const RECALL_DEFAULT_LIMIT = 5
export const RECALL_MAX_LIMIT = 10

/**
 * Rank first, filter second — so over-fetch by this factor, or a member who
 * may read three projects out of forty gets nothing at all (spec PR-9's
 * intent, ADR-0054's "filter after ranking").
 */
const RECALL_OVERFETCH = 3

/** Reciprocal-rank fusion's smoothing constant, the standard k = 60. */
const RRF_K = 60

export interface SteckbriefHit {
  id: string
  name: string
  steckbrief: string
  score: number
}

/**
 * Rebuild one project's Steckbrief from its four sources and store it.
 *
 * Returns false when there is nothing to register — no such project, another
 * tenant's project, or one on its way out through the deletion queue. That is
 * not an error: the reconcile will simply not see it again, because the
 * composite foreign key takes the row with the project.
 *
 * The embedding rides the SAME path memory rows use (`embedNote`), including
 * its fail-open contract: no embedder means a row with no vector, which recall
 * still finds through its lexical channel. A Steckbrief without a vector is
 * worse than one with; a missing Steckbrief is worse than both.
 */
export async function rebuildProjectRegisterRow(
  projectId: string,
  organizationId: string
): Promise<boolean> {
  return withTenant({ organizationId }, async () => {
    const sources = await loadRegisterSources(projectId, organizationId)
    if (!sources) return false

    const memoryHeadline = await buildRegisterMemoryHeadline(projectId, organizationId)
    const steckbrief = buildProjectSteckbrief({
      project: sources.project,
      memoryHeadline,
      documents: sources.documents,
      lastActivityAt: sources.lastActivityAt,
    })

    const embedded = await embedNote(steckbrief.text)

    await upsertProjectRegisterRow({
      projectId,
      organizationId,
      projectName: sources.project.name,
      status: steckbrief.status,
      bundesland: steckbrief.bundesland,
      steckbrief: steckbrief.text,
      documentCount: sources.documentCount,
      lastActivityAt: sources.lastActivityAt,
      embedding: embedded?.vector ?? null,
      embeddingModel: embedded?.fingerprint ?? null,
    })
    return true
  })
}

/**
 * The project's memory in one bounded block, for the Steckbrief's middle.
 *
 * It reuses the memory digest builder rather than re-ranking memory here: the
 * office and the project chat then describe a project's memory the same way,
 * and the salience/recency machinery has one implementation. Fail-open — a
 * memory read that throws costs the Steckbrief its headline, never its row.
 */
async function buildRegisterMemoryHeadline(
  projectId: string,
  organizationId: string
): Promise<string | null> {
  try {
    // Imported lazily: `memory-service` is a writer that calls back into this
    // module (a memory write stamps the register stale), and a top-level
    // import in both directions is a cycle.
    const { buildProjectMemoryDigest } = await import('@/lib/projects/memory-service')
    return await buildProjectMemoryDigest(projectId, organizationId)
  } catch (error) {
    console.warn('[register] memory headline unavailable (non-fatal):', error)
    return null
  }
}

/**
 * Mark a project's Steckbrief as needing a rebuild. **Never throws.**
 *
 * This is the one-line call every write-through makes, from inside paths that
 * are doing something else entirely — saving a profile, storing a memory note,
 * finishing an ingest, renaming a project. None of those may fail because the
 * register is unavailable: the Steckbrief being a day old is a cosmetic
 * degradation, a profile save that 500s is not.
 */
export async function markProjectRegisterStale(
  projectId: string | null | undefined,
  organizationId: string | null | undefined
): Promise<void> {
  if (!projectId || !organizationId) return
  try {
    await withTenant({ organizationId }, () => markRegisterRowStale(projectId, organizationId))
  } catch (error) {
    console.warn('[register] failed to mark Steckbrief stale (non-fatal):', error)
  }
}

export interface ReconcileResult {
  /** Rows the batch attempted. */
  claimed: number
  /** Rows rebuilt and written. */
  rebuilt: number
  /** Projects that vanished between claim and rebuild, or whose build failed. */
  skipped: number
}

/**
 * Rebuild one bounded batch of missing or stale Steckbriefe, across tenants.
 *
 * Idempotent by construction: a rebuild clears `stale_at`, so a second call
 * with nothing left to do claims zero rows. Sequential rather than concurrent
 * — each rebuild embeds, and fifty concurrent embed calls would be a thundering
 * herd against the one backend endpoint memory writes also use.
 *
 * One project's failure never stops the batch. A project whose sources cannot
 * be read stays stale and is retried on the next tick, which is the correct
 * outcome for a transient fault and a bounded, logged loop for a permanent one.
 */
export async function reconcileProjectRegister(
  limit: number = REGISTER_RECONCILE_BATCH
): Promise<ReconcileResult> {
  const batch = await withPlatformAccess(
    'workspace register reconcile — finds stale and missing Steckbriefe across every organization',
    () => listRegisterWorkBatch(Math.max(1, Math.min(limit, REGISTER_RECONCILE_BATCH)))
  )

  let rebuilt = 0
  let skipped = 0
  for (const item of batch) {
    try {
      if (await rebuildProjectRegisterRow(item.projectId, item.organizationId)) rebuilt += 1
      else skipped += 1
    } catch (error) {
      skipped += 1
      console.warn(`[register] rebuild failed for project ${item.projectId} (non-fatal):`, error)
    }
  }
  return { claimed: batch.length, rebuilt, skipped }
}

/** Fuse the two channels by reciprocal rank and order by the fused score. */
function fuseCandidates(candidates: RegisterCandidate[]): Array<RegisterCandidate & { score: number }> {
  return candidates
    .map((candidate) => ({
      ...candidate,
      score:
        (candidate.denseRank ? 1 / (RRF_K + candidate.denseRank) : 0) +
        (candidate.lexicalRank ? 1 / (RRF_K + candidate.lexicalRank) : 0),
    }))
    .sort((a, b) => b.score - a.score || a.projectName.localeCompare(b.projectName))
}

/**
 * How a caller's readability is decided. Either a full session — the office UI
 * and every session-authenticated route — or the bare organization membership
 * the signed request envelope carries, which is all an internal per-turn
 * caller has (`checkResourcePermission` keys on the membership, not the user).
 */
export type RecallCaller =
  | { session: AuthorizedSession }
  | { organizationId: string; organizationMembershipId: string | null }

async function readableProjectIds(
  caller: RecallCaller,
  candidates: RegisterCandidate[]
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set()

  if ('session' in caller) {
    // The one readability computation in the product, asked about the
    // candidates rather than about every project in the tenant. Same function,
    // same org-admin bypass, same fail-closed per project.
    const readable = await filterReadableProjects(
      caller.session,
      candidates.map((candidate) => ({ id: candidate.projectId }))
    )
    return new Set(readable.map((project) => project.id))
  }

  // No membership, no readable project. A turn whose envelope carries no
  // membership id cannot be shown a project list — "we could not tell" is a
  // denial here, not a reason to widen (spec PR-16). The digest itself is
  // still served; only the project half goes empty.
  if (!caller.organizationMembershipId) return new Set()

  const membershipId = caller.organizationMembershipId
  // Per-project FGA, concurrently, each failing closed on its own. There is no
  // org-admin bypass on this path: the bypass is a PERMISSION
  // (`org:projects:administer`) that arrives in the session's JWT claim, and a
  // membership id alone cannot be turned into permissions without asking
  // WorkOS for a ROLE — and a role-name check is the exact thing ADR-0038
  // forbids. So an administrator holding no per-project grant sees fewer
  // projects here than on the grid, which is the fail-closed direction.
  const decisions = await Promise.all(
    candidates.map(async (candidate) => ({
      id: candidate.projectId,
      allowed: await checkResourcePermission({
        organizationMembershipId: membershipId,
        permissionSlug: 'project:view',
        resourceExternalId: candidate.projectId,
        resourceTypeSlug: 'project',
      }),
    }))
  )
  return new Set(decisions.filter((decision) => decision.allowed).map((decision) => decision.id))
}

/**
 * The top Steckbriefe for a question, filtered to what this caller may read.
 *
 * Ranking runs over the whole organization's register and the readable filter
 * runs after it, over-fetching {@link RECALL_OVERFETCH}× the limit. Filtering
 * inside the query is not possible — readability is a WorkOS FGA fact, not a
 * column — and filtering a limit-sized page would hand a member who may read
 * three of forty projects an empty answer for a question their three projects
 * would have answered.
 *
 * An empty or absent query is not an error: the office asked "which projects
 * do we have", and the honest ranking for that is last activity.
 */
export async function recallSteckbriefe(
  caller: RecallCaller,
  query: string | null | undefined,
  limit: number = RECALL_DEFAULT_LIMIT
): Promise<SteckbriefHit[]> {
  const organizationId = 'session' in caller ? caller.session.organizationId : caller.organizationId
  const bounded = Math.max(1, Math.min(Math.trunc(limit) || RECALL_DEFAULT_LIMIT, RECALL_MAX_LIMIT))
  const questionText = query?.trim() || null

  // ~1s, the same budget the memory digest gives its query embed: this sits on
  // the turn's critical path ahead of the agent's own answer, and a slower
  // embed is worth less than nothing here. Null simply means the dense channel
  // contributes nothing and the lexical one decides.
  const embedded = questionText ? await embedNote(questionText, { timeoutMs: 1000 }) : null

  const candidates = await listRegisterCandidates({
    organizationId,
    query: questionText,
    embedding: embedded ? { vector: embedded.vector, fingerprint: embedded.fingerprint } : null,
    limit: bounded * RECALL_OVERFETCH,
  })
  if (candidates.length === 0) return []

  const ranked = fuseCandidates(candidates).slice(0, bounded * RECALL_OVERFETCH)
  const readable = await readableProjectIds(caller, ranked)

  return ranked
    .filter((candidate) => readable.has(candidate.projectId))
    .slice(0, bounded)
    .map((candidate) => ({
      id: candidate.projectId,
      name: candidate.projectName,
      steckbrief: candidate.steckbrief,
      score: candidate.score,
    }))
}
