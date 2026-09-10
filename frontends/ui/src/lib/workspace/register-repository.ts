/**
 * The Projektregister's SQL — the four source reads, the upsert, the stale
 * stamp, the reconcile's work batch, and hybrid recall (ADR-0054).
 *
 * Repository rules apply (ADR-0017): every list is bounded, every raw
 * `sql<T>` result is coerced at this boundary, and nothing here decides
 * anything about authorization — readability is the service's job, computed
 * per caller, because it is an application fact this layer cannot see.
 */

import 'server-only'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { executeRows } from '@/lib/db/execute-rows'
import { withTenant } from '@/lib/db/tenant-context'
import { toVectorLiteral } from '@/lib/knowledge/embeddings'
import {
  documentRoles,
  documents,
  projectFolders,
  projectRegister,
  projects,
  type Project,
} from '@/lib/db/schema'
import type { SteckbriefDocument } from './steckbrief'

/**
 * How many document rows the inventory reads. More than the twenty lines a
 * Steckbrief renders, so the builder can drop unusable rows and still fill the
 * block; far less than a project's corpus, which can be thousands.
 */
const INVENTORY_SAMPLE = 40

/**
 * The recall candidate window PER CHANNEL. Each channel is served by its own
 * index — the dense one by a sequential scan over a small table, the lexical
 * one by `project_register_fts_idx` — and the two candidate sets are then
 * fused. Sized well above any sensible `limit * 3` over-fetch so fusion has
 * something to fuse.
 */
const RECALL_CANDIDATE_LIMIT = 60

export interface RegisterSources {
  project: Pick<Project, 'id' | 'name' | 'profile' | 'profilePromptView' | 'createdAt'>
  documents: SteckbriefDocument[]
  documentCount: number
  lastActivityAt: Date | null
}

/**
 * Everything the builder needs about one project, in one place.
 *
 * Returns null for a project that does not exist, belongs to another tenant or
 * is soft-deleted — all three mean "there is nothing to register", and the
 * caller upserts nothing rather than writing a Steckbrief for a project on its
 * way out.
 */
export async function loadRegisterSources(
  projectId: string,
  organizationId: string
): Promise<RegisterSources | null> {
  const db = getDb()

  const [project] = await db
    .select({
      id: projects.id,
      name: projects.name,
      profile: projects.profile,
      profilePromptView: projects.profilePromptView,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.deletedAt)
      )
    )
    .limit(1)

  if (!project) return null

  const [inventory, counted, activity] = await Promise.all([
    // The middle field of an inventory line is the document's declared ROLE,
    // not a `doc_class`: project documents carry no doc_class column — that
    // vocabulary is the base corpus's, store-authoritative in the Python tier
    // (`lib/knowledge/doc-class.ts`). `document_roles` is what a person or the
    // intake wizard actually said this file is, which is the human-set
    // classification the repo's rule means, and it beats any filename guess.
    db
      .select({
        filename: documents.filename,
        displayName: documents.displayName,
        role: documentRoles.role,
        folderPath: projectFolders.path,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .leftJoin(
        documentRoles,
        and(
          eq(documentRoles.documentId, documents.id),
          eq(documentRoles.organizationId, organizationId)
        )
      )
      .leftJoin(projectFolders, eq(projectFolders.id, documents.folderId))
      .where(
        and(eq(documents.projectId, projectId), eq(documents.organizationId, organizationId))
      )
      .orderBy(desc(documents.updatedAt))
      .limit(INVENTORY_SAMPLE),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .where(
        and(eq(documents.projectId, projectId), eq(documents.organizationId, organizationId))
      ),
    // "Last activity" is the newest thing that happened ANYWHERE in the
    // project, which is what an office reader means by it. Asked as one
    // statement so the four sources cannot be read at four different instants.
    db.execute(sql`
      select greatest(
        (select max(d.updated_at) from documents d
          where d.project_id = ${projectId} and d.organization_id = ${organizationId}),
        (select max(c.updated_at) from conversations c
          where c.project_id = ${projectId} and c.organization_id = ${organizationId}),
        (select max(m.updated_at) from project_memory m
          where m.project_id = ${projectId} and m.organization_id = ${organizationId}),
        (select p.profile_updated_at from projects p where p.id = ${projectId}),
        (select p.created_at from projects p where p.id = ${projectId})
      ) as last_activity_at
    `),
  ])

  // One inventory line per DOCUMENT: the role join fans out a file that fills
  // two roles, and a Steckbrief listing "Lageplan.pdf" twice wastes a line of a
  // budget that only has twenty.
  const seen = new Set<string>()
  const inventoryRows: SteckbriefDocument[] = []
  for (const row of inventory) {
    const filename = row.displayName ?? row.filename
    if (seen.has(filename)) continue
    seen.add(filename)
    inventoryRows.push({ filename, docClass: row.role, folderPath: row.folderPath })
  }

  const [activityRow] = executeRows<{ last_activity_at: string | Date | null }>(activity)
  const rawActivity = activityRow?.last_activity_at ?? null

  return {
    project,
    documents: inventoryRows,
    // Raw sql<T> results are not runtime-validated — coerce at this boundary.
    documentCount: Number(counted[0]?.count ?? 0),
    lastActivityAt: rawActivity ? new Date(rawActivity) : null,
  }
}

export interface RegisterRowValues {
  projectId: string
  organizationId: string
  projectName: string
  status: string | null
  bundesland: string | null
  steckbrief: string
  documentCount: number
  lastActivityAt: Date | null
  embedding: number[] | null
  embeddingModel: string | null
}

/**
 * Write one Steckbrief, clearing `stale_at` — the build IS the repair, so a
 * row that has just been rebuilt is by definition no longer stale.
 *
 * The three embedding columns are written together or all nulled together;
 * `project_register_embedding_complete` rejects any other combination, which
 * is why they are not three independent assignments here either.
 */
export async function upsertProjectRegisterRow(values: RegisterRowValues): Promise<void> {
  const db = getDb()
  const embedded = values.embedding
    ? { embedding: values.embedding, embeddingModel: values.embeddingModel, embeddedAt: new Date() }
    : { embedding: null, embeddingModel: null, embeddedAt: null }
  const now = new Date()
  const row = {
    projectId: values.projectId,
    organizationId: values.organizationId,
    projectName: values.projectName,
    status: values.status,
    bundesland: values.bundesland,
    steckbrief: values.steckbrief,
    documentCount: values.documentCount,
    lastActivityAt: values.lastActivityAt,
    ...embedded,
    staleAt: null,
    builtAt: now,
    updatedAt: now,
  }

  await db
    .insert(projectRegister)
    .values(row)
    .onConflictDoUpdate({ target: projectRegister.projectId, set: row })
}

/**
 * Stamp a project's Steckbrief as needing a rebuild.
 *
 * The cheap half of the write-through (spec PR-6, PR-7): a memory write
 * happens several times a turn and rebuilding inline would embed a 3000-
 * character block on the agent's critical path. An UPDATE that touches no row
 * — a project with no Steckbrief yet — is not an error: the reconcile picks
 * such a project up as missing work anyway.
 */
export async function markRegisterRowStale(
  projectId: string,
  organizationId: string
): Promise<void> {
  const db = getDb()
  await db
    .update(projectRegister)
    .set({ staleAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(projectRegister.projectId, projectId),
        eq(projectRegister.organizationId, organizationId)
      )
    )
}

export interface RegisterWorkItem {
  projectId: string
  organizationId: string
}

/**
 * The reconcile's batch: projects whose Steckbrief is missing or stale, oldest
 * first, across every tenant.
 *
 * MISSING and STALE in one query on purpose (spec MG-2): the backfill for
 * projects that existed before the register and the repair of a missed
 * write-through are the same work, so they share one code path and one set of
 * bugs. Missing rows sort first — a project with no Steckbrief is invisible to
 * the office, which is worse than one whose Steckbrief is a day old.
 *
 * Cross-tenant by construction, so the CALLER must hold platform access; the
 * per-project rebuild then re-enters that project's own tenant scope.
 */
export async function listRegisterWorkBatch(limit: number): Promise<RegisterWorkItem[]> {
  const db = getDb()
  const rows = await db.execute(sql`
    select p.id as project_id, p.organization_id
    from projects p
    left join project_register r on r.project_id = p.id
    where p.deleted_at is null
      and (r.project_id is null or r.stale_at is not null)
    order by coalesce(r.stale_at, to_timestamp(0)) asc, p.created_at asc
    limit ${limit}
  `)
  return executeRows<{ project_id: string; organization_id: string }>(rows).map((row) => ({
    projectId: String(row.project_id),
    organizationId: String(row.organization_id),
  }))
}

/** One register row as recall returns it, before readability filtering. */
export interface RegisterCandidate {
  projectId: string
  projectName: string
  steckbrief: string
  status: string | null
  bundesland: string | null
  lastActivityAt: Date | null
  /** Rank within the dense channel, 1-based; null when the channel missed it. */
  denseRank: number | null
  /** Rank within the lexical channel, 1-based; null when it missed it. */
  lexicalRank: number | null
}

/**
 * Hybrid candidates for one organization: the top of the dense channel and the
 * top of the lexical channel, unioned (spec PR-9).
 *
 * Two channels rather than one score, because they miss different things.
 * Dense alone misses exactly the queries this product lives on — a project
 * NAME, "GK5", "OIB-RL 2" — and lexical alone misses the paraphrase that makes
 * "Holzbau" match "Massivholzkonstruktion". Each is asked for its own top
 * {@link RECALL_CANDIDATE_LIMIT}, so a row that is strong in one channel and
 * absent from the other still reaches fusion.
 *
 * Only vectors from the CURRENT embedder take part in the dense channel: a
 * same-size vector from another model is noise wearing the right shape.
 *
 * The organization filter is written out even though RLS enforces it —
 * ADR-0041's rule is that RLS is the backstop, never the plan.
 */
export async function listRegisterCandidates(input: {
  organizationId: string
  query: string | null
  embedding: { vector: number[]; fingerprint: string } | null
  limit: number
}): Promise<RegisterCandidate[]> {
  const db = getDb()
  const { organizationId, query, embedding } = input
  const candidateLimit = Math.min(RECALL_CANDIDATE_LIMIT, Math.max(input.limit, 1))

  // No question, so no ranking to do: the office asked "which projects are
  // there", and the honest order for that is what happened most recently.
  if (!query && !embedding) {
    const rows = await withTenant({ organizationId }, () =>
      db
        .select({
          projectId: projectRegister.projectId,
          projectName: projectRegister.projectName,
          steckbrief: projectRegister.steckbrief,
          status: projectRegister.status,
          bundesland: projectRegister.bundesland,
          lastActivityAt: projectRegister.lastActivityAt,
        })
        .from(projectRegister)
        .where(eq(projectRegister.organizationId, organizationId))
        .orderBy(desc(projectRegister.lastActivityAt), asc(projectRegister.projectName))
        .limit(candidateLimit)
    )
    return rows.map((row, index) => ({
      ...row,
      lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt) : null,
      denseRank: null,
      // One channel, one order: recency IS the ranking here, so it rides in as
      // the lexical rank and fusion degenerates to it.
      lexicalRank: index + 1,
    }))
  }

  const dense = embedding
    ? sql`
        select project_id,
               row_number() over (
                 order by grid_cosine_similarity(embedding, ${toVectorLiteral(embedding.vector)}::real[]) desc
               ) as rank
        from project_register
        where organization_id = ${organizationId}
          and embedding is not null
          and embedding_model = ${embedding.fingerprint}
        limit ${candidateLimit}
      `
    : sql`select null::uuid as project_id, null::bigint as rank where false`

  const lexical = query
    ? sql`
        select project_id,
               row_number() over (
                 order by ts_rank(to_tsvector('german', steckbrief), q.query) desc
               ) as rank
        from project_register, plainto_tsquery('german', ${query}) as q(query)
        where organization_id = ${organizationId}
          and to_tsvector('german', steckbrief) @@ q.query
        limit ${candidateLimit}
      `
    : sql`select null::uuid as project_id, null::bigint as rank where false`

  const rows = await withTenant({ organizationId }, () =>
    db.execute(sql`
      with dense as (${dense}), lexical as (${lexical})
      select r.project_id, r.project_name, r.steckbrief, r.status, r.bundesland,
             r.last_activity_at, d.rank as dense_rank, l.rank as lexical_rank
      from project_register r
      left join dense d on d.project_id = r.project_id
      left join lexical l on l.project_id = r.project_id
      where r.organization_id = ${organizationId}
        and (d.project_id is not null or l.project_id is not null)
    `)
  )

  return executeRows<{
    project_id: string
    project_name: string
    steckbrief: string
    status: string | null
    bundesland: string | null
    last_activity_at: string | Date | null
    dense_rank: string | number | null
    lexical_rank: string | number | null
  }>(rows).map((row) => ({
    projectId: String(row.project_id),
    projectName: String(row.project_name),
    steckbrief: String(row.steckbrief),
    status: row.status,
    bundesland: row.bundesland,
    lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at) : null,
    denseRank: row.dense_rank === null ? null : Number(row.dense_rank),
    lexicalRank: row.lexical_rank === null ? null : Number(row.lexical_rank),
  }))
}
