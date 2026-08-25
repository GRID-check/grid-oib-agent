/**
 * Declaring, listing and clearing a document's role in a project.
 *
 * This layer owns authorization and every rule the vocabulary states. The
 * repository below it only queries; the route above it only adapts transport.
 */

import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  documentRoleDefinition,
  isDocumentRole,
  isScopeInstanceValid,
} from '@/lib/project-profile/document-roles'
import type { DocumentRole, RoleConfidence, RoleSource } from '@/lib/project-profile/document-roles'
import { invalidateProjectPromptViewCache } from '@/lib/project-profile/prompt-view'
import {
  deleteBindings,
  documentBelongsToProject,
  findBindingsForRole,
  insertBinding,
  listProjectDocumentRoles,
} from './repository'
import type { DocumentRoleBinding } from './repository'

export type { DocumentRoleBinding } from './repository'

/**
 * Writing a role is a documents-write act, not a profile edit.
 *
 * The list form is the ADR-0038 split: a custom role provisioned before
 * `project:edit` was broken up may hold only the umbrella.
 */
const WRITE_PERMISSIONS = ['project:documents:write', 'project:edit'] as const

export async function listDocumentRoles(
  projectId: string,
  session: AuthorizedSession
): Promise<DocumentRoleBinding[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  return listProjectDocumentRoles(projectId)
}

export interface DeclareDocumentRoleInput {
  projectId: string
  documentId: string
  role: string
  scopeInstanceId?: string | null
  /** Defaults to a human declaration; a classifier passes `suggested`. */
  confidence?: RoleConfidence
  source?: RoleSource
}

export interface DeclareDocumentRoleResult {
  binding: DocumentRoleBinding
  /**
   * Bindings this declaration displaced, for a single-holder role.
   *
   * Returned rather than swallowed so the UI can say WHICH document stopped
   * being the Bebauungsplan. A silent replacement is the same event with the
   * evidence thrown away.
   */
  replaced: DocumentRoleBinding[]
}

/**
 * Bind a document to a role.
 *
 * Ordered so the cheap, caller-fixable rejections happen before any database
 * work, and so a `one` role's replacement and its insert cannot half-apply.
 */
export async function declareDocumentRole(
  input: DeclareDocumentRoleInput,
  session: AuthorizedSession
): Promise<DeclareDocumentRoleResult> {
  await requireProjectAccess(session, input.projectId, [...WRITE_PERMISSIONS])

  if (!isDocumentRole(input.role)) {
    throw new BadRequestError(`Unknown document role '${input.role}'.`)
  }
  const role: DocumentRole = input.role
  const definition = documentRoleDefinition(role)
  const scopeInstanceId = input.scopeInstanceId ?? null

  if (!isScopeInstanceValid(role, scopeInstanceId)) {
    throw new BadRequestError(
      definition.scope === 'bauwerk'
        ? `Role '${role}' belongs to one Bauwerk and needs its id.`
        : `Role '${role}' takes no scope instance.`
    )
  }

  // The composite foreign key would reject a foreign document anyway, but as a
  // constraint violation rather than an answer. Checking first turns "500" into
  // "that file is not in this project", and covers the soft-deleted case the FK
  // cannot see.
  if (!(await documentBelongsToProject(input.documentId, input.projectId))) {
    throw new NotFoundError('Document not found in this project.')
  }

  const existing = await findBindingsForRole(input.projectId, role, scopeInstanceId)
  const alreadyBound = existing.find((binding) => binding.documentId === input.documentId)
  if (alreadyBound) {
    // Declaring the same thing twice is not an error, it is a no-op. The unique
    // index would raise here, and a 500 for "yes, still true" helps nobody.
    return { binding: alreadyBound, replaced: [] }
  }

  const replaced = definition.cardinality === 'one' ? existing : []
  if (replaced.length > 0) {
    await deleteBindings(
      input.projectId,
      replaced.map((binding) => binding.id)
    )
  }

  await insertBinding({
    organizationId: session.organizationId,
    projectId: input.projectId,
    documentId: input.documentId,
    role,
    scopeInstanceId,
    confidence: input.confidence ?? 'declared',
    source: input.source ?? 'user',
    createdBy: session.userId,
  })

  // The agent's project context carries the bindings, and it is cached for five
  // minutes. Without this, a document declared now would not reach Piloti until
  // the cache expired — and the user would be told the Bebauungsplan is missing
  // in the same session they attached it.
  await invalidateProjectPromptViewCache(input.projectId, session.organizationId)

  const after = await findBindingsForRole(input.projectId, role, scopeInstanceId)
  const binding = after.find((row) => row.documentId === input.documentId)
  if (!binding) {
    // Unreachable unless the insert and the read disagree, which would mean the
    // tenant scope changed underneath us. Fail loudly rather than return a lie.
    throw new Error('Document role was written but could not be read back.')
  }
  return { binding, replaced }
}

export async function revokeDocumentRole(
  projectId: string,
  bindingId: string,
  session: AuthorizedSession
): Promise<void> {
  await requireProjectAccess(session, projectId, [...WRITE_PERMISSIONS])
  const removed = await deleteBindings(projectId, [bindingId])
  if (removed === 0) throw new NotFoundError('Document role binding not found.')
  await invalidateProjectPromptViewCache(projectId, session.organizationId)
}
