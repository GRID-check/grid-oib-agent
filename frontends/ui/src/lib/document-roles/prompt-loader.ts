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
import { listProjectDocumentRoles } from './repository'
import type { DocumentRoleReader } from './repository'
import { buildDocumentRolesSection } from './prompt-section'
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
  if (!organizationId) return { unfiledOnly: true }
  return { hiddenFolderIds: await getRestrictedFolderIds(organizationId, projectId) }
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

    let recommended: RecommendedSlot[] = []
    const bauwerkNames: Record<string, string> = {}

    if (profile) {
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
      for (const role of recommendedRoles(answers)) {
        add(role, documentRoleDefinition(role).scope === 'bauwerk' ? null : null)
      }
      for (const bauwerk of bauwerke) {
        bauwerkNames[bauwerk.id] = bauwerk.name
        for (const role of recommendedRoles(answers, bauwerk.id)) {
          add(role, documentRoleDefinition(role).scope === 'bauwerk' ? bauwerk.id : null)
        }
      }
      recommended = [...collected.values()]
    }

    return buildDocumentRolesSection(bindings, recommended, bauwerkNames)
  } catch {
    return ''
  }
}
