/**
 * Permitting memory's rows (docs/design/permitting-memory.md, ADR-0094): what a
 * Bescheid says, kept as one record per source document with its requirements,
 * and the search the cross-project lookup reads them through.
 *
 * Writing replaces: a document has at most one record, and re-extraction swaps
 * it whole, in one transaction, so a reader never sees a document with half of
 * its requirements or with two records.
 *
 * Ranked as recorded decisions are (`searchProjectDecisions`), over
 * requirements: the question's embedding against each requirement's stored one,
 * fused by reciprocal rank with a token-overlap channel that keeps identifiers
 * („§ 70 BO Wien", „Geschäftszahl") findable. The token channel reads the
 * requirement, the evidence it asks for, and the authority and Gemeinde of the
 * record it belongs to, so „Was verlangt die MA 37?" ranks by the issuer too.
 * No relevance floor: the best few are returned and the model judges which
 * matter. Without an embedder the token channel alone answers.
 *
 * What a reader may see is judged per project from the document's LIVE folder,
 * as the document hits beside it are (`live-access.ts`): a record from a
 * restricted folder only for a reader cleared for every folder restricting it
 * now. The restriction stored on a record is where the document was when read,
 * kept for the record's own history and never consulted for access.
 */

import 'server-only'
import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import { CROSS_PROJECT_MAX_PERMIT_REQUIREMENTS, CROSS_PROJECT_MAX_PERMITS } from '@/lib/cross-project/types'
import { getDb } from '@/lib/db'
import { documentVisibleTo, internalRead, SCREENED_ONLY } from '@/lib/documents/visibility'
import {
  documents,
  permitRecords,
  permitRequirements,
  type PermitRecordKind,
  projects,
  type PermitRequirementKind,
} from '@/lib/db/schema'
import { contentTokens, jaccardSimilarity, normalizeContentGerman } from '@/lib/knowledge/consolidation'
import { cosineSimilaritySql, embedNote, type EmbeddedNote } from '@/lib/knowledge/embeddings'
import { fuseHybridRelevance } from '@/lib/knowledge/recall-scoring'
import { memoryVisibleTo } from '@/lib/projects/memory-service'
import type { LiveFolderAccess } from './live-access'

/** How many records one search returns at most: the wire's bound, so the two cannot drift. */
export const PERMIT_MAX_RECORDS = CROSS_PROJECT_MAX_PERMITS

/** How many requirements of one record a search returns at most. */
export const PERMIT_MAX_REQUIREMENTS_PER_RECORD = CROSS_PROJECT_MAX_PERMIT_REQUIREMENTS

/** How many requirements one search ranks: its own bound, so a large office cannot widen it. */
const PERMIT_CANDIDATES = 300
/**
 * Without an embedder the rows cannot be ordered by meaning in SQL, so the cut
 * falls back to recency and would keep only the newest requirements: an older
 * Bescheid could never be found. The token channel then ranks a wider, still
 * bounded pool.
 */
const PERMIT_CANDIDATES_TOKENS_ONLY = 3000

export interface PermitRequirementInput {
  kind: PermitRequirementKind
  content: string
  evidence: string | null
  legalBasis: string | null
  page: number | null
  /** Of content + evidence; null when the embedder was down, and the token channel ranks it. */
  embedding: EmbeddedNote | null
}

/** One document's record, ready to store. The service resolved the project and the restriction. */
export interface PermitRecordInput {
  organizationId: string
  projectId: string
  documentId: string
  collectionName: string
  fileName: string
  /** Canonical (sorted, de-duplicated), null when the document is open. */
  restrictedFolderIds: string[] | null
  model: string
  kind: PermitRecordKind
  authority: string | null
  municipality: string | null
  bundesland: string | null
  /** `YYYY-MM-DD`. */
  issuedOn: string | null
  reference: string | null
  requirements: readonly PermitRequirementInput[]
}

/** A project to search, and the folders whose restricted records the reader may see (empty: open records only). */
export interface PermitScope {
  projectId: string
  /** The project's folders as this reader may be served from them, judged now (`liveFolderAccess`). */
  access: LiveFolderAccess
}

/** A document filed where the reader may be served from: the project root, or a folder the access lists. */
function servedFrom(visibleFolderIds: readonly string[] | null): SQL {
  if (visibleFolderIds === null) return sql`true`
  if (visibleFolderIds.length === 0) return isNull(documents.folderId)
  return or(isNull(documents.folderId), inArray(documents.folderId, [...visibleFolderIds])) as SQL
}

export interface FoundPermitRequirement {
  kind: PermitRequirementKind
  content: string
  evidence: string | null
  legalBasis: string | null
  page: number | null
}

export interface FoundPermitRecord {
  projectId: string
  collectionName: string
  fileName: string
  kind: PermitRecordKind
  authority: string | null
  municipality: string | null
  bundesland: string | null
  issuedOn: string | null
  reference: string | null
  /** Only the requirements that matched, best first. */
  requirements: FoundPermitRequirement[]
  /** The restricted folders the document sits in, for the hand-out record; null for an open one. */
  restrictedFolderIds: string[] | null
}

/** The document a record is about, and the project it hangs off. */
export interface PermitDocument {
  documentId: string
  projectId: string
  /** The project's own collection, to tell a restricted folder's from it. */
  projectCollection: string
  fileName: string
}

/** How the ingest names the document: by id, or, for a backfill that only knows the file, by its name in the collection. */
export interface PermitDocumentRef {
  collectionName: string
  documentId?: string
  fileName: string
}

/**
 * The project document the ingest means, or null: unknown, in another
 * organization or collection, outside any project (the Archiv and a chat's
 * files have no project to remember a permit for), or in a binned folder (as
 * `documentExistsInCollection` counts it: gone until restored).
 *
 * With an id, id AND collection. Without one, the collection and file name,
 * restricted to the rows `uniq_documents_live_name_per_collection` makes unique
 * (a person's upload, or a `piloti/` document), so the name names one row.
 *
 * The writer's read (ADR-0086): the ingest hook asks right after the upload
 * screen, before the pipeline's verdict reaches the row, so it sees every row.
 * Nothing it finds reaches a model from here; the search serves a record only
 * through `SCREENED_ONLY` ({@link documentServesItsRecord}).
 */
export async function findPermitDocument(organizationId: string, ref: PermitDocumentRef): Promise<PermitDocument | null> {
  const [row] = await getDb()
    .select({
      documentId: documents.id,
      projectId: documents.projectId,
      projectCollection: projects.collectionName,
      fileName: documents.filename,
    })
    .from(documents)
    .innerJoin(projects, and(eq(projects.id, documents.projectId), eq(projects.organizationId, documents.organizationId)))
    .where(
      and(
        eq(documents.organizationId, organizationId),
        eq(documents.collectionName, ref.collectionName),
        ref.documentId
          ? eq(documents.id, ref.documentId)
          : and(
              eq(documents.filename, ref.fileName),
              sql`(${documents.authoredBy} = 'user' OR ${documents.filename} LIKE 'piloti/%')`
            ),
        sql`NOT EXISTS (SELECT 1 FROM project_folders f WHERE f.id = ${documents.folderId} AND f.deleted_at IS NOT NULL)`,
        documentVisibleTo(internalRead('ingest'))
      )
    )
    .limit(1)
  if (!row?.projectId) return null
  return { ...row, projectId: row.projectId }
}

/**
 * Store this document's record, replacing the one it had. Delete and insert are
 * one transaction: the previous record's requirements go with it (cascade), and
 * a failure leaves the previous record in place.
 */
export async function replacePermitRecord(input: PermitRecordInput): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx
      .delete(permitRecords)
      .where(and(eq(permitRecords.organizationId, input.organizationId), eq(permitRecords.documentId, input.documentId)))
    const [record] = await tx
      .insert(permitRecords)
      .values({
        organizationId: input.organizationId,
        projectId: input.projectId,
        documentId: input.documentId,
        collectionName: input.collectionName,
        fileName: input.fileName,
        restrictedFolderIds: input.restrictedFolderIds,
        kind: input.kind,
        authority: input.authority,
        municipality: input.municipality,
        bundesland: input.bundesland,
        issuedOn: input.issuedOn,
        reference: input.reference,
        model: input.model,
      })
      .returning({ id: permitRecords.id })
    if (input.requirements.length === 0) return
    await tx.insert(permitRequirements).values(
      input.requirements.map((requirement, position) => ({
        organizationId: input.organizationId,
        recordId: record.id,
        projectId: input.projectId,
        restrictedFolderIds: input.restrictedFolderIds,
        position,
        kind: requirement.kind,
        content: requirement.content,
        evidence: requirement.evidence,
        legalBasis: requirement.legalBasis,
        page: requirement.page,
        embedding: requirement.embedding?.vector ?? null,
        embeddingModel: requirement.embedding?.fingerprint ?? null,
      }))
    )
  })
}

/** Remove this document's record, if it has one (its requirements go with it). */
export async function deletePermitRecord(organizationId: string, documentId: string): Promise<void> {
  await getDb()
    .delete(permitRecords)
    .where(and(eq(permitRecords.organizationId, organizationId), eq(permitRecords.documentId, documentId)))
}

/**
 * A record is served only while its document is live: past the upload screen
 * as a model may read it (`SCREENED_ONLY`, ADR-0086: not quarantined, not held,
 * its verdict about the bytes it holds now), not archived, and not in the
 * Papierkorb (every folder of a binned subtree carries `deleted_at`, migration
 * 0115), so deleting through the bin removes what was derived from it at once,
 * not when the purge cascades. WHO may be served it is
 * decided apart, from the document's live folder (`live-access.ts`): the stored
 * restriction is a snapshot of where the document was read, and nothing here
 * trusts it.
 */
const documentServesItsRecord = and(
  eq(documents.organizationId, permitRecords.organizationId),
  eq(documents.projectId, permitRecords.projectId),
  // What a record says reaches the agent: nobody's own held upload counts.
  documentVisibleTo(SCREENED_ONLY),
  eq(documents.lifecycle, 'active'),
  sql`NOT EXISTS (SELECT 1 FROM project_folders f WHERE f.id = ${documents.folderId} AND f.deleted_at IS NOT NULL)`
)

/**
 * The records of these projects whose requirements are most relevant to the
 * question, best first (a record ranks by its best requirement), each with the
 * requirements that matched; none for an empty scope or question.
 */
export async function searchPermitRequirements(
  organizationId: string,
  scopes: readonly PermitScope[],
  question: string,
  { maxRecords = PERMIT_MAX_RECORDS, maxPerRecord = PERMIT_MAX_REQUIREMENTS_PER_RECORD } = {}
): Promise<FoundPermitRecord[]> {
  if (scopes.length === 0 || !question.trim()) return []
  // Fail-open: no embedder means the token channel alone ranks.
  const embedded = await embedNote(question, { timeoutMs: 1500 })
  const relevance = embedded
    ? cosineSimilaritySql(permitRequirements.embedding, embedded.vector)
    : sql<number | null>`null::double precision`
  const visible = or(
    ...scopes.map((scope) =>
      and(eq(permitRequirements.projectId, scope.projectId), servedFrom(scope.access.visibleFolderIds))
    )
  )
  const rows = await getDb()
    .select({
      recordId: permitRequirements.recordId,
      projectId: permitRequirements.projectId,
      position: permitRequirements.position,
      kind: permitRequirements.kind,
      content: permitRequirements.content,
      evidence: permitRequirements.evidence,
      legalBasis: permitRequirements.legalBasis,
      page: permitRequirements.page,
      embeddingModel: permitRequirements.embeddingModel,
      relevance,
      // The document's, not the record's: after placement the record's names the collection it left.
      collectionName: documents.collectionName,
      fileName: documents.filename,
      folderId: documents.folderId,
      recordKind: permitRecords.kind,
      authority: permitRecords.authority,
      municipality: permitRecords.municipality,
      bundesland: permitRecords.bundesland,
      issuedOn: permitRecords.issuedOn,
      reference: permitRecords.reference,
    })
    .from(permitRequirements)
    .innerJoin(permitRecords, eq(permitRecords.id, permitRequirements.recordId))
    .innerJoin(documents, eq(documents.id, permitRecords.documentId))
    .where(and(eq(permitRequirements.organizationId, organizationId), visible, documentServesItsRecord))
    .orderBy(...(embedded ? [sql`${relevance} desc nulls last`] : []), desc(permitRequirements.createdAt))
    .limit(embedded ? PERMIT_CANDIDATES : PERMIT_CANDIDATES_TOKENS_ONLY)

  // A vector from another model is noise of the right shape: only the current one counts.
  const dense = rows.map((row) =>
    embedded && row.embeddingModel === embedded.fingerprint && row.relevance !== null ? Number(row.relevance) : null
  )
  // German-preserving: the ASCII fold splits „Mödling" into „m" and „dling", and names
  // are what this channel exists for. Both sides are tokenized here, so no index binds it.
  const asked = contentTokens(question, normalizeContentGerman)
  const lexical = rows.map((row) =>
    jaccardSimilarity(
      asked,
      contentTokens([row.content, row.evidence, row.authority, row.municipality].filter(Boolean).join(' '), normalizeContentGerman)
    )
  )
  const fused = fuseHybridRelevance(dense, lexical)

  const matched = rows
    .map((row, index) => ({ row, score: fused[index] }))
    .filter((entry): entry is { row: (typeof rows)[number]; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)

  // Sorted best first, so the first requirement met for a record is its best one: the record's rank.
  const byRecord = new Map<string, typeof matched>()
  for (const entry of matched) {
    const entries = byRecord.get(entry.row.recordId)
    if (entries) entries.push(entry)
    else byRecord.set(entry.row.recordId, [entry])
  }

  const accessOf = new Map(scopes.map((scope) => [scope.projectId, scope.access]))
  // Raw values are not runtime-validated: coerced at the boundary.
  return [...byRecord.values()].slice(0, maxRecords).map((entries) => {
    const { row } = entries[0]
    return {
      projectId: String(row.projectId),
      collectionName: row.collectionName,
      fileName: row.fileName,
      kind: row.recordKind,
      authority: row.authority,
      municipality: row.municipality,
      bundesland: row.bundesland,
      issuedOn: row.issuedOn === null ? null : String(row.issuedOn),
      reference: row.reference,
      // Where the document is now, not where it was when read: the hand-out records this.
      restrictedFolderIds: accessOf.get(String(row.projectId))?.restrictionOf(row.folderId) ?? null,
      requirements: entries.slice(0, maxPerRecord).map(({ row: requirement }) => ({
        kind: requirement.kind,
        content: requirement.content,
        evidence: requirement.evidence,
        legalBasis: requirement.legalBasis,
        page: requirement.page === null ? null : Number(requirement.page),
      })),
    }
  })
}

/** One permit record as a reader of the project may see it, with its first requirements in document order. */
export interface ListedPermitRecord {
  id: string
  fileName: string
  kind: PermitRecordKind
  authority: string | null
  /** `YYYY-MM-DD`, or null. */
  issuedOn: string | null
  requirements: FoundPermitRequirement[]
}

/**
 * The newest permit records of one project a reader may see (the restricted
 * ones only for `readableFolderIds`, judged as memory is), each with its first
 * `maxPerRecord` requirements in document order. Both bounds are applied in SQL:
 * the requirements are ranked per record, so a long Bescheid cannot widen the read.
 */
export async function listPermitRecordsForProject(
  organizationId: string,
  projectId: string,
  readableFolderIds: readonly string[],
  { maxRecords, maxPerRecord }: { maxRecords: number; maxPerRecord: number }
): Promise<ListedPermitRecord[]> {
  const db = getDb()
  const records = await db
    .select({
      id: permitRecords.id,
      fileName: permitRecords.fileName,
      kind: permitRecords.kind,
      authority: permitRecords.authority,
      issuedOn: permitRecords.issuedOn,
    })
    .from(permitRecords)
    // As the search: a record answers only while its document still stands where it was read from.
    .innerJoin(documents, eq(documents.id, permitRecords.documentId))
    .where(
      and(
        eq(permitRecords.organizationId, organizationId),
        eq(permitRecords.projectId, projectId),
        memoryVisibleTo(readableFolderIds, permitRecords.restrictedFolderIds),
        documentServesItsRecord
      )
    )
    .orderBy(desc(permitRecords.issuedOn), desc(permitRecords.createdAt))
    .limit(maxRecords)
  if (records.length === 0) return []

  const ranked = db.$with('ranked_requirements').as(
    db
      .select({
        recordId: permitRequirements.recordId,
        position: permitRequirements.position,
        kind: permitRequirements.kind,
        content: permitRequirements.content,
        evidence: permitRequirements.evidence,
        legalBasis: permitRequirements.legalBasis,
        page: permitRequirements.page,
        rank: sql<number>`row_number() over (partition by ${permitRequirements.recordId} order by ${permitRequirements.position})`.as(
          'rank'
        ),
      })
      .from(permitRequirements)
      .where(
        and(
          eq(permitRequirements.organizationId, organizationId),
          inArray(
            permitRequirements.recordId,
            records.map((record) => record.id)
          ),
          memoryVisibleTo(readableFolderIds, permitRequirements.restrictedFolderIds)
        )
      )
  )
  const rows = await db
    .with(ranked)
    .select()
    .from(ranked)
    .where(lte(ranked.rank, maxPerRecord))
    .orderBy(asc(ranked.position))

  const byRecord = new Map<string, FoundPermitRequirement[]>()
  for (const row of rows) {
    const requirement: FoundPermitRequirement = {
      kind: row.kind,
      content: row.content,
      evidence: row.evidence,
      legalBasis: row.legalBasis,
      page: row.page === null ? null : Number(row.page),
    }
    byRecord.set(row.recordId, [...(byRecord.get(row.recordId) ?? []), requirement])
  }
  // Raw values are not runtime-validated: coerced at the boundary.
  return records.map((record) => ({
    id: record.id,
    fileName: record.fileName,
    kind: record.kind,
    authority: record.authority,
    issuedOn: record.issuedOn === null ? null : String(record.issuedOn),
    requirements: byRecord.get(record.id) ?? [],
  }))
}
