/**
 * Assemble the agent's `documents:` block for one project.
 *
 * Split from `prompt-section.ts` so the rendering stays pure and testable while
 * the I/O lives here. Fail-open throughout: project context is an enrichment,
 * and a failure to read role bindings must degrade the answer, never break the
 * WebSocket upgrade that carries it. The one thing that does not fail open is
 * folder access: a failure to decide it drops the whole block.
 */

import { findProjectProfile } from '@/lib/projects/repository'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import { answersFromProfile } from '@/lib/project-profile/intake-definition'
import { documentRoleDefinition, recommendedRoles } from '@/lib/project-profile/document-roles'
import type { DocumentRole } from '@/lib/project-profile/document-roles'
import { getRestrictedFolderIds } from '@/lib/authz/folder-access'
import { SCREENED_ONLY } from '@/lib/documents/document-reader'
import { listProjectDocumentRoles } from './repository'
import type { DocumentRoleReader } from './repository'
import { buildDocumentRolesSection, missingSlots } from './prompt-section'
import type { RecommendedSlot } from './prompt-section'

/**
 * Which bindings the block may name (ADR-0087). A binding carries its
 * document's filename into the agent's prompt, and listing is not use: a chat
 * draws on a restricted folder only through content it retrieves and admits,
 * never through a name in its prompt. So no document in a restricted folder is
 * named here, whoever asks; the view is one per project and cached.
 */
async function readerFor(
  projectId: string,
  organizationId: string | null | undefined
): Promise<DocumentRoleReader> {
  // Nor a held file (ADR-0086): its name reaches no model until it is screened.
  if (!organizationId) return { unfiledOnly: true, documents: SCREENED_ONLY }
  return { hiddenFolderIds: await getRestrictedFolderIds(organizationId, projectId), documents: SCREENED_ONLY }
}

/**
 * What the intake answers say this project should hold, per building, and the
 * buildings' names. Shared by the agent's block and the folder brief.
 */
export function recommendedSlotsFor(profile: Awaited<ReturnType<typeof findProjectProfile>>): {
  recommended: RecommendedSlot[]
  bauwerkNames: Record<string, string>
} {
  const bauwerkNames: Record<string, string> = {}
  if (!profile) return { recommended: [], bauwerkNames }
  const { answers, bauwerke } = answersFromProfile(profile, projectIntakeDefinitionV1)
  // Project-scope recommendations once, then each building's own. A
  // `bauwerk` condition read without an instance resolves against the
  // project-global answer, which would recommend Bestandspläne for every
  // building the moment any one of them is a Bestand.
  //
  // Each recommendation keeps the instance it was made for. Collapsing them
  // into a set of roles made two buildings' Bestandspläne indistinguishable,
  // so binding one silenced the other's missing entry.
  const collected = new Map<string, RecommendedSlot>()
  const add = (role: DocumentRole, scopeInstanceId: string | null) => {
    collected.set(`${role}@${scopeInstanceId ?? ''}`, { role, scopeInstanceId })
  }
  for (const role of recommendedRoles(answers)) add(role, null)
  for (const bauwerk of bauwerke) {
    bauwerkNames[bauwerk.id] = bauwerk.name
    for (const role of recommendedRoles(answers, bauwerk.id)) {
      add(role, documentRoleDefinition(role).scope === 'bauwerk' ? bauwerk.id : null)
    }
  }
  return { recommended: [...collected.values()], bauwerkNames }
}

export interface MissingDocument {
  role: DocumentRole
  /** The role's label, e.g. „Energieausweis". */
  label: string
  /** The building it is missing for, when the role is per building. */
  bauwerkName: string | null
}

/**
 * What Piloti expects this project to hold and does not — exactly the agent's
 * `documents_missing:` list, read through the same reader, so a person sees the
 * gaps the agent sees. Fail-open to an empty list, like the block.
 */
export async function loadMissingDocuments(
  projectId: string,
  organizationId: string | null | undefined
): Promise<MissingDocument[]> {
  try {
    const [bindings, profile] = await Promise.all([
      readerFor(projectId, organizationId).then((reader) => listProjectDocumentRoles(projectId, reader)),
      findProjectProfile(projectId, organizationId),
    ])
    const { recommended, bauwerkNames } = recommendedSlotsFor(profile)
    return missingSlots(bindings, recommended).map((slot) => ({
      role: slot.role,
      label: documentRoleDefinition(slot.role).label,
      bauwerkName: slot.scopeInstanceId ? (bauwerkNames[slot.scopeInstanceId] ?? null) : null,
    }))
  } catch {
    return []
  }
}

export async function loadDocumentRolesPromptSection(
  projectId: string,
  organizationId: string | null | undefined
): Promise<string> {
  try {
    const [bindings, profile] = await Promise.all([
      readerFor(projectId, organizationId).then((reader) => listProjectDocumentRoles(projectId, reader)),
      findProjectProfile(projectId, organizationId),
    ])

    const { recommended, bauwerkNames } = recommendedSlotsFor(profile)
    return buildDocumentRolesSection(bindings, recommended, bauwerkNames)
  } catch {
    return ''
  }
}
