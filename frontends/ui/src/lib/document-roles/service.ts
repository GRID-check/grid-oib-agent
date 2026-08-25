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
import { findProjectProfile } from '@/lib/projects/repository'
import {
  answersFromProfile,
  defaultBauwerke,
  projectIntakeDefinitionV1,
} from '@/lib/project-profile/intake-definition'
import {
  confirmBinding,
  deleteBindings,
  documentBelongsToProject,
  findBindingsForRole,
  listProjectDocumentRoles,
  replaceSlotBinding,
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

/**
 * Does this project have a building with this id?
 *
 * Read from the stored profile the wizard writes, which is the only place the
 * building list lives. A project with no profile yet still has the implicit
 * first building (`defaultBauwerke`), so declaring against it before the intake
 * is saved keeps working.
 */
async function projectHasBauwerk(
  projectId: string,
  session: AuthorizedSession,
  bauwerkId: string
): Promise<boolean> {
  const profile = await findProjectProfile(projectId, session.organizationId)
  const bauwerke = profile
    ? answersFromProfile(profile, projectIntakeDefinitionV1).bauwerke
    : defaultBauwerke()
  return bauwerke.some((bauwerk) => bauwerk.id === bauwerkId)
}

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

  // The vocabulary can only check the SHAPE of an instance id — that one is
  // present for a `bauwerk` role and absent otherwise. Whether the building
  // exists is a fact about this project, so it is checked here, against the
  // project's own list.
  //
  // Without it any non-empty string was accepted, and the resulting binding
  // matched no generated slot: invisible in the Modul I checklist, invisible in
  // the agent's context, and impossible for the user to find and remove. A
  // silent write to nowhere is worse than a rejection.
  if (
    scopeInstanceId !== null &&
    !(await projectHasBauwerk(input.projectId, session, scopeInstanceId))
  ) {
    throw new BadRequestError(`Bauwerk '${scopeInstanceId}' does not exist in this project.`)
  }

  // The composite foreign key would reject a foreign document anyway, but as a
  // constraint violation rather than an answer. Checking first turns "500" into
  // "that file is not in this project", and covers the soft-deleted case the FK
  // cannot see.
  if (!(await documentBelongsToProject(input.documentId, input.projectId))) {
    throw new NotFoundError('Document not found in this project.')
  }

  const existing = await findBindingsForRole(input.projectId, role, scopeInstanceId)
  const confidence = input.confidence ?? 'declared'
  const source = input.source ?? 'user'

  const alreadyPresent = existing.find((binding) => binding.documentId === input.documentId)
  if (alreadyPresent) {
    // Declaring the same thing twice is not an error. It is not always a no-op
    // either: a classifier's `suggested` binding that the user now confirms
    // must become `declared`, or the prompt keeps marking it unbestätigt no
    // matter how often the user confirms it. Only ever upgrades — a repeat that
    // says nothing new leaves the row alone.
    const upgrades = alreadyPresent.confidence === 'suggested' && confidence === 'declared'
    if (!upgrades) return { binding: alreadyPresent, replaced: [] }

    await confirmBinding(input.projectId, alreadyPresent.id, confidence, source)
    await invalidateProjectPromptViewCache(input.projectId, session.organizationId)
    return {
      binding: { ...alreadyPresent, confidence, source },
      replaced: [],
    }
  }

  const replaced = definition.cardinality === 'one' ? existing : []

  // One statement, not two. Separately, a failing insert left the slot EMPTY —
  // the user's existing Bebauungsplan deleted and nothing put back.
  await replaceSlotBinding(
    {
      organizationId: session.organizationId,
      projectId: input.projectId,
      documentId: input.documentId,
      role,
      scopeInstanceId,
      confidence,
      source,
      createdBy: session.userId,
    },
    replaced.map((binding) => binding.id)
  )

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
  // Invalidate BEFORE reporting the miss. Throwing first meant a retry after a
  // failed invalidation deleted nothing, took this branch, and returned without
  // touching the cache again — so the removed binding stayed in the agent's
  // prompt view until the five-minute TTL expired.
  await invalidateProjectPromptViewCache(projectId, session.organizationId)
  if (removed === 0) throw new NotFoundError('Document role binding not found.')
}
