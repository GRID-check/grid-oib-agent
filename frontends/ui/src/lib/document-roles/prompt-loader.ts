/**
 * Assemble the agent's `documents:` block for one project.
 *
 * Split from `prompt-section.ts` so the rendering stays pure and testable while
 * the I/O lives here. Fail-open throughout: project context is an enrichment,
 * and a failure to read role bindings must degrade the answer, never break the
 * WebSocket upgrade that carries it.
 */

import { findProjectProfile } from '@/lib/projects/repository'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import { answersFromProfile } from '@/lib/project-profile/intake-definition'
import { recommendedRoles } from '@/lib/project-profile/document-roles'
import type { DocumentRole } from '@/lib/project-profile/document-roles'
import { listProjectDocumentRoles } from './repository'
import { buildDocumentRolesSection } from './prompt-section'

export async function loadDocumentRolesPromptSection(
  projectId: string,
  organizationId: string | null | undefined
): Promise<string> {
  try {
    const [bindings, profile] = await Promise.all([
      listProjectDocumentRoles(projectId),
      findProjectProfile(projectId, organizationId),
    ])

    let recommended: DocumentRole[] = []
    const bauwerkNames: Record<string, string> = {}

    if (profile) {
      const { answers, bauwerke } = answersFromProfile(profile, projectIntakeDefinitionV1)
      // Project-scope recommendations once, then each building's own. A
      // `bauwerk` condition read without an instance resolves against the
      // project-global answer, which would recommend Bestandspläne for every
      // building the moment any one of them is a Bestand.
      const collected = new Set<DocumentRole>(recommendedRoles(answers))
      for (const bauwerk of bauwerke) {
        bauwerkNames[bauwerk.id] = bauwerk.name
        for (const role of recommendedRoles(answers, bauwerk.id)) collected.add(role)
      }
      recommended = [...collected]
    }

    return buildDocumentRolesSection(bindings, recommended, bauwerkNames)
  } catch {
    return ''
  }
}
