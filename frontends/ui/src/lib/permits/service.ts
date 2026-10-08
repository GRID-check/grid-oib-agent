/**
 * Permitting memory's write (docs/design/permitting-memory.md): the ingest
 * pipeline sends what a model read out of a Bescheid, and this decides what is
 * stored for the document: its project and its restricting folders come from
 * the document's own row, never from the body, and the requirements are
 * embedded so the cross-project search can rank them by meaning.
 *
 * Service-token caller (`POST /api/internal/permit-records`): there is no
 * session to authorize, the document's unguessable id and collection are the
 * address, and the organization the ingest was dispatched for is the tenant.
 */

import 'server-only'
import { sourceFoldersOfCollections } from '@/lib/authz/folder-access'
import { withTenant } from '@/lib/db/tenant-context'
import { embedNotes } from '@/lib/knowledge/embeddings'
import { isForeignKeyViolation } from '@/lib/db/errors'
import { canonicalRestriction } from '@/lib/projects/memory-service'
import {
  deletePermitRecord,
  findPermitDocument,
  replacePermitRecord,
  type PermitDocument,
  type PermitRequirementInput,
} from './repository'
import type { StorePermitRecordRequest, StorePermitRecordResponse } from './types'

const NOT_STORED: StorePermitRecordResponse = { stored: false, requirements: 0 }

/** What a requirement's vector is of: the demand and the proof it asks for. */
function embeddingText(requirement: { content: string; evidence: string | null }): string {
  return [requirement.content, requirement.evidence].filter(Boolean).join('\n')
}

/**
 * The folders restricting the document, from the collection it sits in: a
 * restricted folder has its own collection, the project's own is open.
 */
async function restrictionOf(organizationId: string, document: PermitDocument, collection: string): Promise<string[] | null> {
  const sources = await sourceFoldersOfCollections(organizationId, document.projectId, document.projectCollection, [collection])
  return canonicalRestriction([...sources.values()])
}

/** Store, replace or delete the record of one document. */
export async function storePermitRecord(body: StorePermitRecordRequest): Promise<StorePermitRecordResponse> {
  const { organizationId, collection, record } = body
  return withTenant({ organizationId }, async () => {
    const document = await findPermitDocument(organizationId, {
      collectionName: collection,
      documentId: body.documentId,
      fileName: body.fileName,
    })
    if (!document) return NOT_STORED
    // From here on the row's id, whichever way it was found.
    const { documentId } = document
    if (!record) {
      await deletePermitRecord(organizationId, documentId)
      return NOT_STORED
    }

    const restrictedFolderIds = await restrictionOf(organizationId, document, collection)
    // Fail-open: without vectors the token channel still ranks the requirements.
    const embedded = await embedNotes(record.requirements.map(embeddingText))
    const requirements: PermitRequirementInput[] = record.requirements.map((requirement, index) => ({
      ...requirement,
      embedding: embedded?.[index] ?? null,
    }))

    try {
      await replacePermitRecord({
        organizationId,
        projectId: document.projectId,
        documentId,
        collectionName: collection,
        // As indexed: the name the document row carries, not the one the body repeats.
        fileName: document.fileName,
        restrictedFolderIds,
        model: body.model,
        kind: record.kind,
        authority: record.authority,
        municipality: record.municipality,
        bundesland: record.bundesland,
        issuedOn: record.issuedOn,
        reference: record.reference,
        requirements,
      })
    } catch (error) {
      // The document (or its project) was deleted between the lookup and the insert: nothing to remember a permit for.
      if (isForeignKeyViolation(error)) return NOT_STORED
      throw error
    }
    return { stored: true, requirements: requirements.length }
  })
}
