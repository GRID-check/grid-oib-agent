/**
 * Which audit events may name a document, and where a document is filed.
 *
 * Its own module, free of `server-only` and WorkOS, so a call site can build
 * `filedIn` with {@link filedInOf} while a spec mocks `./service` whole.
 */

import type { AuditAction } from './service'

/**
 * The actions that carry a project document's name (`filename`, a rename's
 * `previousName` and `displayName`, and the name-gate `terms` that matched it). Each must say where the document is filed
 * (`AuditEventInput.filedIn` (`./service`)), because the name of a document in a folder
 * not every project member may read is withheld from the trail.
 *
 * Why: the trail is read in the WorkOS audit portal, which `org:audit:view`
 * opens, and that permission is held by roles that are not organization admins
 * (`org-auditor`, `org-compliance-officer`). A restricted folder's file names
 * are not theirs to read (ADR-0084). The target id still says which document,
 * and someone cleared for the folder resolves it in Piloti.
 *
 * `audit/service.spec.ts` fails when an action registers a name key and is in
 * neither this list nor {@link UNRESTRICTED_NAME_ACTIONS}.
 */
export const DOCUMENT_NAME_ACTIONS = [
  'document.uploaded',
  'document.screening_overridden',
  'document.quarantine_released',
  'document.deleted',
  'document.archived',
  'document.generated',
  'document.renamed',
] as const satisfies readonly AuditAction[]
export type DocumentNameAction = (typeof DOCUMENT_NAME_ACTIONS)[number]

/**
 * The actions that carry a name and never need `AuditEventInput.filedIn` (`./service`),
 * each with the reason: no folder on its shelf can be restricted.
 */
export const UNRESTRICTED_NAME_ACTIONS: Partial<Record<AuditAction, string>> = {
  'org.created': 'an organization name; nothing above a folder is restricted',
  'project.created': 'a project name; projects are not folder-restricted',
  'project.deleted': 'a project name; projects are not folder-restricted',
  'project.closed': 'a project name; projects are not folder-restricted',
  'project.reopened': 'a project name; projects are not folder-restricted',
  'archiv.document.uploaded': 'the Büroablage has no per-role folder access',
  'archiv.document.deleted': 'the Büroablage has no per-role folder access',
  'archiv.document.renamed': 'the Büroablage has no per-role folder access',
  'session.document.uploaded': 'a chat attachment is filed in no folder',
  'session.document.deleted': 'a chat attachment is filed in no folder',
  'download_log.viewed':
    'sends nameFiltered, never the typed text; documentName stays registered only for a previous release mid-rollout',
}

/**
 * The metadata keys that carry a document's name, or a piece of it: `terms` are
 * the office's name-gate words that matched a segment of the file's name or its
 * folder path (`document.screening_overridden`), so „gehalt" says what the
 * withheld name holds as plainly as the name would.
 */
export const DOCUMENT_NAME_KEYS = ['filename', 'previousName', 'displayName', 'terms'] as const

/**
 * Where a project document is filed. `null`: on no project shelf (the
 * Büroablage, a chat), where no folder can be restricted.
 */
export type AuditDocumentPlacement = { projectId: string; folderId: string | null } | null

/** Where a document row is filed, for `AuditEventInput.filedIn` (`./service`). */
export function filedInOf(document: { projectId: string | null; folderId: string | null }): AuditDocumentPlacement {
  return document.projectId === null ? null : { projectId: document.projectId, folderId: document.folderId }
}
