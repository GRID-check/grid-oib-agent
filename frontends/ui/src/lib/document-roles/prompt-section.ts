/**
 * What the agent is told about a project's document roles.
 *
 * Two halves, and the second is the one that earns its tokens. Knowing that
 * `bebauungsplan.pdf` IS the Bebauungsplan lets Piloti cite it by name instead
 * of hedging about "the uploaded documents". Knowing the Bebauungsplan is
 * MISSING lets it answer conditionally — "sobald der Bebauungsplan vorliegt" —
 * rather than answering as if the plan had been read.
 *
 * Pure: bindings in, one block of prompt text out. The caller supplies the live
 * bindings so this never has to decide when it is stale.
 */

import { documentRoleDefinition, DOCUMENT_ROLE_DEFINITIONS } from '@/lib/project-profile/document-roles'
import type { DocumentRole } from '@/lib/project-profile/document-roles'

export interface PromptRoleBinding {
  role: DocumentRole
  scopeInstanceId: string | null
  confidence: 'declared' | 'suggested'
  filename: string
  displayName: string | null
}

/** A building's display name, so a scoped role reads as more than an opaque id. */
export type BauwerkNames = Readonly<Record<string, string>>

function label(binding: PromptRoleBinding): string {
  return binding.displayName?.trim() || binding.filename
}

function scopeSuffix(binding: PromptRoleBinding, names: BauwerkNames): string {
  if (!binding.scopeInstanceId) return ''
  return ` (${names[binding.scopeInstanceId] ?? binding.scopeInstanceId})`
}

/**
 * Render the `documents:` section, or an empty string when there is nothing
 * worth saying.
 *
 * `recommended` is the set the intake answers say this project should have. A
 * role that is neither bound nor recommended is not reported: the checklist
 * offers every role, but telling the agent that a project with no demolition is
 * missing its Schadstoffgutachten is noise that costs tokens on every turn.
 */
export function buildDocumentRolesSection(
  bindings: readonly PromptRoleBinding[],
  recommended: readonly DocumentRole[] = [],
  bauwerkNames: BauwerkNames = {}
): string {
  if (bindings.length === 0 && recommended.length === 0) return ''

  const present: string[] = []
  const bound = new Set<DocumentRole>()

  // Registry order, not insertion order, so the block is stable across turns
  // and does not churn the prompt cache when a binding is added.
  for (const definition of DOCUMENT_ROLE_DEFINITIONS) {
    const forRole = bindings.filter((binding) => binding.role === definition.role)
    if (forRole.length === 0) continue
    bound.add(definition.role)
    for (const binding of forRole) {
      const unconfirmed = binding.confidence === 'suggested' ? ' [nicht bestätigt]' : ''
      present.push(`- ${definition.label}${scopeSuffix(binding, bauwerkNames)}: ${label(binding)}${unconfirmed}`)
    }
  }

  const missing = recommended
    .filter((role) => !bound.has(role))
    .map((role) => `- ${documentRoleDefinition(role).label}`)

  const lines: string[] = []
  if (present.length > 0) lines.push('documents:', ...present)
  if (missing.length > 0) {
    // Named explicitly rather than left to be inferred from the absence of a
    // line. An agent cannot notice something that is not there.
    lines.push('documents_missing:', ...missing)
  }
  return lines.join('\n')
}
