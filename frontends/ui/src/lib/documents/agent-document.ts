/**
 * The `agent_document` producer: a Markdown document a chat turn wrote.
 *
 * The fourth caller of `fileGeneratedDocument`, and the first whose output is
 * meant to be REVISED rather than handed over finished. It owns exactly two
 * things the filing service deliberately does not — the renderer, and the title
 * — and it reaches the lifecycle through `createDocumentVersion` like every
 * other entry into the version table.
 *
 * ## The marking is written into the text
 *
 * Markdown has no metadata, so the marking is part of the prose or it is not in
 * the file — `./agent-document-markdown` holds the renderer and the argument.
 * `fileGeneratedDocument` checks the BYTES (`markingIsInBytes`) rather than the
 * object that described them, because two of the three earlier producers
 * shipped unmarked while passing every test there was. The UPDATE path re-runs
 * the same render and the same check (`./version-content`): a revision that
 * wrote the model's raw Markdown would strip the marking off a file that
 * already carried it.
 *
 * ## Why the draft is not indexed, and cannot be
 *
 * Nothing here dispatches. A draft is not a published version, and only a
 * published version may ever be ingested (ADR-0054) — which slice 4 is what
 * turns on, at the lifecycle's `ingestPublished` slot and nowhere else.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { NotFoundError } from '@/lib/api/errors'
import type { DocumentVersion } from '@/lib/db/schema'
import { getOrganizationDisplayName } from '@/lib/organizations/service'
import { AGENT_DOCUMENT_MEDIA_TYPE, renderAgentDocumentMarkdown } from './agent-document-markdown'
import { resolveDocumentBranding } from './branding'
import { contentDigest } from './content-digest'
import { fileGeneratedDocument } from './generated'
import { createDocumentVersion } from './lifecycle'
import { findDocumentInOrg } from './repository'
import { findOpenVersion } from './version-repository'

/**
 * The renderer and its media type live in `./agent-document-markdown`, pure and
 * on their own, because the UPDATE path renders through them too and reaching
 * them from there would close an import cycle (see that module's header). They
 * are re-exported here because this is the producer they belong to, and every
 * existing caller — the spec, the filing seam below — names this module.
 */
export { AGENT_DOCUMENT_MEDIA_TYPE, renderAgentDocumentMarkdown }

export interface FileAgentDocumentDraftInput {
  /** The commissioning human, or the pinned requester the envelope named. */
  session: AuthorizedSession
  projectId: string
  /**
   * The idempotency key. `{conversationId}-{slug}` from the caller: two turns of
   * one conversation writing "Aktenvermerk" must land on ONE document with two
   * versions, not on two documents.
   */
  ref: string
  title: string
  /** The document, as the model wrote it. */
  content: string
  request?: Request
  /** False for the agent's internal route — see `TransitionInput.actingHuman`. */
  actingHuman?: boolean
  /**
   * The conversation this filing came out of, from the VERIFIED envelope
   * (migration 0084). Recorded on the version so a reviewer's decision reaches
   * the next turn of THAT conversation rather than a task nobody is waiting on.
   *
   * Deliberately not derived from {@link FileAgentDocumentDraftInput.ref}, even
   * though the reference starts with the conversation id: the ref is the
   * CALLER's string and a value this tier authorizes nothing on, while the
   * origin is a fact the route read out of a signature.
   */
  originConversationId?: string | null
}

export interface FiledAgentDocumentDraft {
  documentId: string
  version: DocumentVersion
  /** True when this reference was already filed and the draft was not created. */
  alreadyFiled: boolean
}

/**
 * File a new agent-written document as a draft.
 *
 * Two steps, in this order and no other: `fileGeneratedDocument` creates the
 * ITEM (folder, object, quota admission, provenance columns, the marking check
 * and the `document.generated` audit event), and `createDocumentVersion` records
 * version 1 as a `draft`. Reversing them would mean a version row pointing at a
 * document that may still be refused by the quota.
 *
 * When the reference has already been filed, the item comes back unchanged and
 * NO version is created — a re-run of the same turn must not fork a second
 * draft. Revising an existing document is `forkDraftVersion` plus
 * `replaceVersionContent`, which is a different gesture with a different route.
 */
export async function fileAgentDocumentDraft(
  input: FileAgentDocumentDraftInput,
): Promise<FiledAgentDocumentDraft> {
  // Resolved once, before the render, and every part of it fails soft: an
  // unreachable WorkOS gives a header line naming the product alone, and an
  // unreadable settings row gives the platform's own words. Neither costs the
  // filing.
  //
  // NO locale is passed, deliberately. This function's one caller is the
  // agent's internal route, and the agent sends no `grid-locale` cookie and no
  // `Accept-Language` — so `getLocale()` here would resolve to the APP default
  // for every tenant, and a German Aktenvermerk would carry an English header
  // line for no better reason than that. Leaving it out inherits
  // `organizations.default_locale` instead: the office's own language, which is
  // the language its documents are written in. See
  // `ResolveDocumentBrandingInput.locale`.
  const organizationName = await getOrganizationDisplayName(input.session.organizationId)
  const branding = await resolveDocumentBranding({
    organizationId: input.session.organizationId,
    organizationName,
  })

  const filed = await fileGeneratedDocument({
    session: input.session,
    projectId: input.projectId,
    producer: 'agent_document',
    ref: input.ref,
    title: input.title,
    request: input.request,
    render: ({ marking }) => renderAgentDocumentMarkdown(input.content, marking, branding),
  })

  const document = await findDocumentInOrg(filed.documentId, input.session.organizationId)
  // The row was written a moment ago by the call above; a miss means it was
  // deleted in between, and a version for a document that is gone helps nobody.
  if (!document) throw new NotFoundError('Document not found')

  if (filed.alreadyFiled) {
    // The open version of an already-filed reference, so a retried turn gets
    // the draft it wrote rather than a second one.
    const existing = await findOpenVersion(document.id, input.session.organizationId)
    if (existing) return { documentId: document.id, version: existing, alreadyFiled: true }
  }

  const version = await createDocumentVersion(input.session, {
    document,
    op: 'create',
    storageKey: document.storageKey,
    storageBucket: document.storageBucket,
    contentType: document.contentType,
    fileSize: document.fileSize,
    contentHash: document.contentHash ?? contentDigest(new TextEncoder().encode(input.content)),
    request: input.request,
    actingHuman: input.actingHuman,
    originConversationId: input.originConversationId,
  })
  return { documentId: document.id, version, alreadyFiled: false }
}
