import 'server-only'
/**
 * Getting a sent-back document ready to be written again.
 *
 * One question, answered in one place: when a `revision` task finishes and has
 * new bytes for a document a reviewer refused, WHICH version do those bytes go
 * into? The lifecycle already holds both halves — `changes_requested` has an
 * `update` row back to `draft`, and `forkDraftVersion` starts a draft from the
 * published bytes — and this module is the choice between them, so the task
 * service does not grow an `if` about version states.
 *
 * The rule is the database's own: **one open version per document**
 * (`uniq_document_versions_open_per_document`, migration 0082). So a refused
 * version IS the open one and is written into directly; only when nothing is
 * open — the reviewer rejected the draft outright, or a person has since
 * published over it — does a fork happen.
 *
 * The reviewer who sent it back comes back with it, because the submission that
 * follows has to reach somebody and the person waiting is the one who asked for
 * the change. Naming them is not a permission: `transitionDocumentVersion`
 * checks the acting session exactly as it does for a person's own submit.
 */

import type { AuthorizedSession } from '@/lib/auth/types'
import type { DocumentVersion } from '@/lib/db/schema'
import { getAccessibleDocument } from './access'
import { documentDisplayName } from './display-name'
import { forkDraftVersion } from './lifecycle'
import { findOpenVersion, listDocumentVersions } from './version-repository'

export interface RevisionDraft {
  /** The version the revised bytes belong in. Always replaceable. */
  version: DocumentVersion
  /** What the document is called, for the inbox row and the task's filing record. */
  filename: string
  /**
   * Who to ask when the revision is submitted: whoever refused a version of this
   * document most recently. Empty when nobody did, in which case the lifecycle
   * falls back to the document's assignees exactly as a person's submit does.
   */
  reviewers: string[]
}

/**
 * The open draft a revision writes into, forking one when there is none.
 *
 * Runs entirely in the caller's session — the pinned requester, for a task —
 * so `getAccessibleDocument` and the fork's own permission check are the gates,
 * unchanged.
 */
export async function openDraftForRevision(
  session: AuthorizedSession,
  documentId: string,
): Promise<RevisionDraft> {
  const document = await getAccessibleDocument(session, documentId, 'write')
  const open = await findOpenVersion(documentId, session.organizationId)
  // `in_review` is open and NOT replaceable: a version somebody is looking at
  // right now must not be rewritten under them. Nothing here forces it — the
  // caller gets the row and `replaceVersionContent` refuses with a 409, which is
  // the honest answer ("a person has it") rather than a silent second draft.
  const version = open ?? (await forkDraftVersion(session, documentId))

  return {
    version,
    filename: documentDisplayName(document),
    reviewers: await lastRefusers(documentId, session.organizationId),
  }
}

/**
 * Who most recently refused a version of this document.
 *
 * The whole version list is bounded already (`DOCUMENT_VERSION_LIST_LIMIT`), so
 * this is one query rather than a second index: a document with two hundred
 * versions is not a shape this product produces, and a dedicated query would be
 * a second definition of "refused" beside the one the review-decisions block
 * uses.
 */
async function lastRefusers(documentId: string, organizationId: string): Promise<string[]> {
  const versions = await listDocumentVersions(documentId, organizationId)
  for (const version of [...versions].reverse()) {
    if ((version.state === 'changes_requested' || version.state === 'rejected') && version.reviewedBy) {
      return [version.reviewedBy]
    }
  }
  return []
}
