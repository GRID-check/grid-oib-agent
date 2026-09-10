/**
 * The `agent_document` producer: a Markdown document a chat turn wrote.
 *
 * The fourth caller of `fileGeneratedDocument`, and the first whose output is
 * meant to be REVISED rather than handed over finished. It owns exactly two
 * things the filing service deliberately does not — the renderer, and the title
 * — and it reaches the lifecycle through `createDocumentVersion` like every
 * other entry into the version table.
 *
 * ## Why the marking is written into the text
 *
 * A `.docx` carries the marking as a typed OOXML property and a `.pdf` in its
 * Info dictionary. **Markdown has no metadata at all.** There is no header, no
 * side-car and no place to hang a property that survives being pasted into a
 * Word document, mailed, or attached to an Einreichung — so the marking has to
 * be part of the prose, or it is not in the file.
 *
 * `fileGeneratedDocument` checks exactly that (`markingIsInBytes`), against the
 * bytes rather than against the object that described them, because two of the
 * three earlier producers shipped unmarked while passing every test there was.
 * A Markdown renderer that emitted the marking as an HTML comment would satisfy
 * the check and lose it on the first "paste as plain text"; a fenced block at
 * the END of the document survives that, and is the last thing a reader sees
 * before deciding whether to forward it.
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
import type { AiProvenanceMarking } from '@/lib/ai-provenance'
import type { DocumentVersion } from '@/lib/db/schema'
import { getOrganizationDisplayName } from '@/lib/organizations/service'
import { resolveDocumentBranding, type DocumentBranding } from './branding'
import { contentDigest } from './content-digest'
import { fileGeneratedDocument, type GeneratedRendering } from './generated'
import { createDocumentVersion } from './lifecycle'
import { findDocumentInOrg } from './repository'
import { findOpenVersion } from './version-repository'

/** The stored content type. Markdown, because the next turn edits it as text. */
export const AGENT_DOCUMENT_MEDIA_TYPE = 'text/markdown'

/**
 * The bytes of an agent-written document: the model's Markdown, wrapped in what
 * every file Piloti produces has to say about itself, plus the marking, as
 * text.
 *
 * Exported and pure so a test can assert on the STRING — the seam already
 * asserts the marking is in the bytes, and this is where a reader checks that
 * the branding and the marking are in a place a person will actually see.
 *
 * ## Where each piece goes, and why it is not all in one place
 *
 * ONE line above the title and a block below it, rather than a single block at
 * either end.
 *
 * The line is chrome: „Erstellt mit Piloti für …" is the Markdown equivalent of
 * the PDF's running header, it identifies the file at a glance in a preview
 * pane, and one line does not turn the document into an appendix to its own
 * front matter.
 *
 * The block is the disclaimer, and it stays at the FOOT for the reason this
 * renderer already gave about the marking: the first line of a filed document
 * is its title, and three sentences of liability above it turn every preview
 * and every paste into a disclaimer with a document underneath. It is also the
 * last thing a reader sees before deciding whether to forward the file, which
 * is the moment it is about.
 *
 * `branding` is a parameter and not an import, so this function stays pure and
 * so the resolution — which reads an organization's override — happens once, at
 * the filing seam, rather than inside a renderer that would then have to be
 * async to do it.
 */
export function renderAgentDocumentMarkdown(
  body: string,
  marking: AiProvenanceMarking,
  branding: DocumentBranding,
): GeneratedRendering {
  const footer = [
    `**${branding.productName} — ${branding.tagline}**`,
    branding.prose,
    branding.disclaimer,
    branding.footerLine,
  ].join('\n\n')
  const text =
    `${branding.headerLine}\n\n${body.trim()}\n\n---\n\n${footer}\n\n` +
    `<!-- ${branding.aiGeneratorName} -->\n\n\`\`\`\n${marking}\n\`\`\`\n`
  return {
    bytes: new TextEncoder().encode(text),
    contentType: AGENT_DOCUMENT_MEDIA_TYPE,
    marking,
  }
}

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
  })
  return { documentId: document.id, version, alreadyFiled: false }
}
