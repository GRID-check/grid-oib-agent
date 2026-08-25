/**
 * What the agent is told about a project's document roles.
 *
 * The block carries the SHAPE of the project's evidence, never the list. That
 * distinction is the whole design:
 *
 *   - Knowing that a Bebauungsplan exists, that there are 47 Bestandspläne for
 *     the Hoftrakt, and that no Schadstoffgutachten was ever attached, is small,
 *     bounded, and worth its tokens on every turn. It is what lets Piloti cite a
 *     document by name and answer conditionally about one it has not got.
 *   - Knowing WHICH 47 sheets is worth nothing until the agent is actually
 *     working with them, and it costs 47 lines × ~5 prompt templates × every
 *     turn, including chit-chat.
 *
 * So a filled slot is ONE line whatever it holds: the document's name when it
 * holds one, a count when it holds more. The block is therefore O(roles ×
 * scope instances) and independent of how many files the project has — a
 * 1000-file project and a 3-file project produce blocks of the same order.
 *
 * The first version of this emitted a line per BINDING, which is exactly the
 * unbounded growth `_available_documents_limit` in the chat researcher already
 * exists to prevent ("per-turn LLM cost grew linearly with the corpus, paid
 * even on chit-chat"). Same mistake, one directory over.
 *
 * Pure: bindings in, one block of prompt text out.
 */

import {
  documentRoleDefinition,
  DOCUMENT_ROLE_DEFINITIONS,
} from '@/lib/project-profile/document-roles'
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

/**
 * Backstop, not the mechanism. The per-slot collapse above is what bounds this
 * block; the cap only catches a project with an implausible number of buildings
 * (each one adds two slots). Following the repo's own rule about caps, a
 * truncation says so rather than silently shortening the list.
 */
const MAX_SLOT_LINES = 60

function label(binding: PromptRoleBinding): string {
  return binding.displayName?.trim() || binding.filename
}

function scopeSuffix(scopeInstanceId: string | null, names: BauwerkNames): string {
  if (!scopeInstanceId) return ''
  return ` (${names[scopeInstanceId] ?? scopeInstanceId})`
}

/** One filled slot: a role at one scope instance, and everything bound to it. */
interface Slot {
  role: DocumentRole
  scopeInstanceId: string | null
  bindings: PromptRoleBinding[]
}

function groupIntoSlots(bindings: readonly PromptRoleBinding[]): Slot[] {
  const byKey = new Map<string, Slot>()
  // Registry order, not insertion order, so the block is stable across turns and
  // does not churn the prompt cache when a binding is added.
  for (const definition of DOCUMENT_ROLE_DEFINITIONS) {
    for (const binding of bindings) {
      if (binding.role !== definition.role) continue
      const key = `${binding.role}@${binding.scopeInstanceId ?? ''}`
      const existing = byKey.get(key)
      if (existing) existing.bindings.push(binding)
      else
        byKey.set(key, {
          role: binding.role,
          scopeInstanceId: binding.scopeInstanceId,
          bindings: [binding],
        })
    }
  }
  return [...byKey.values()]
}

function renderSlot(slot: Slot, names: BauwerkNames): string {
  const definition = documentRoleDefinition(slot.role)
  const head = `- ${definition.label}${scopeSuffix(slot.scopeInstanceId, names)}`

  if (slot.bindings.length === 1) {
    const only = slot.bindings[0]
    const unconfirmed = only.confidence === 'suggested' ? ' [nicht bestätigt]' : ''
    return `${head}: ${label(only)}${unconfirmed}`
  }

  // More than one: the count is the fact worth carrying. Which documents they
  // are is a question the agent can ask when it has a reason to.
  const unconfirmed = slot.bindings.filter((binding) => binding.confidence === 'suggested').length
  const suffix = unconfirmed > 0 ? `, ${unconfirmed} davon nicht bestätigt` : ''
  return `${head}: ${slot.bindings.length} Dokumente${suffix}`
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

  const slots = groupIntoSlots(bindings)
  const shown = slots.slice(0, MAX_SLOT_LINES)
  const present = shown.map((slot) => renderSlot(slot, bauwerkNames))

  const bound = new Set(slots.map((slot) => slot.role))
  const missing = recommended
    .filter((role) => !bound.has(role))
    .map((role) => `- ${documentRoleDefinition(role).label}`)

  const lines: string[] = []
  if (present.length > 0) {
    lines.push('documents:', ...present)
    const dropped = slots.length - shown.length
    // Never a silent cap: an agent told "these are the documents" when some were
    // withheld will reason as though the withheld ones do not exist.
    if (dropped > 0) lines.push(`- (${dropped} weitere Dokumentarten nicht aufgeführt)`)
  }
  if (missing.length > 0) {
    // Named explicitly rather than left to be inferred from the absence of a
    // line. An agent cannot notice something that is not there.
    lines.push('documents_missing:', ...missing)
  }
  return lines.join('\n')
}
