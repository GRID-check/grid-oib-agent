/**
 * Permitting memory's rows (docs/design/permitting-memory.md, ADR-0086): what a
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
 * What a reader may see is judged per project exactly as restricted memory is
 * (`memoryVisibleTo`): open rows, and restricted ones only for a reader cleared
 * for every folder the document sits in.
 */

import 'server-only'
import { and, desc, eq, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
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

/** How many records one search returns at most, across every project it searched. */
export const PERMIT_MAX_RECORDS = 8

/** How many requirements of one record a search returns at most. */
export const PERMIT_MAX_REQUIREMENTS_PER_RECORD = 6

/** How many requirements one search ranks: its own bound, so a large office cannot widen it. */
const PERMIT_CANDIDATES = 300

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
  authority: string
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
  readableFolderIds: readonly string[]
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
  authority: string
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
        sql`NOT EXISTS (SELECT 1 FROM project_folders f WHERE f.id = ${documents.folderId} AND f.deleted_at IS NOT NULL)`
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
      and(
        eq(permitRequirements.projectId, scope.projectId),
        memoryVisibleTo(scope.readableFolderIds, permitRequirements.restrictedFolderIds)
      )
    )
  )
  const rows = await getDb()
    .select({
      recordId: permitRequirements.recordId,
      projectId: permitRequirements.projectId,
      restrictedFolderIds: permitRequirements.restrictedFolderIds,
      position: permitRequirements.position,
      kind: permitRequirements.kind,
      content: permitRequirements.content,
      evidence: permitRequirements.evidence,
      legalBasis: permitRequirements.legalBasis,
      page: permitRequirements.page,
      embeddingModel: permitRequirements.embeddingModel,
      relevance,
      collectionName: permitRecords.collectionName,
      fileName: permitRecords.fileName,
      recordKind: permitRecords.kind,
      authority: permitRecords.authority,
      municipality: permitRecords.municipality,
      bundesland: permitRecords.bundesland,
      issuedOn: permitRecords.issuedOn,
      reference: permitRecords.reference,
    })
    .from(permitRequirements)
    .innerJoin(permitRecords, eq(permitRecords.id, permitRequirements.recordId))
    .where(and(eq(permitRequirements.organizationId, organizationId), visible))
    .orderBy(...(embedded ? [sql`${relevance} desc nulls last`] : []), desc(permitRequirements.createdAt))
    .limit(PERMIT_CANDIDATES)

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
      restrictedFolderIds: row.restrictedFolderIds && row.restrictedFolderIds.length > 0 ? [...row.restrictedFolderIds] : null,
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
