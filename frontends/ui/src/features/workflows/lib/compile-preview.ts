/**
 * Client-side preview of the compiled research brief.
 *
 * The BFF's `compileWorkflowPrompt(definition)` (src/lib/workflows/compiler.ts)
 * is the AUTHORITATIVE compiler: it runs at save time and its output is stored
 * in `compiled_prompt` and submitted to the agent verbatim. This function is a
 * pure, deterministic MIRROR of that documented output
 * (docs/architecture/workflows.md — "Definition JSONB and the compiler")
 * used only to render the editor's live "What the agent receives" preview.
 *
 * The WYSIWYG contract is that what the preview shows equals what the agent
 * receives, so this must stay byte-for-byte aligned with the server compiler.
 * Markdown sections — Objective / Background & Context / Research questions /
 * Output requirements — are emitted in that fixed order, omitting any empty
 * section. Section headings are part of the compiled prompt (the agent's
 * brief) and are therefore intentionally NOT localized.
 */

import type { WorkflowDefinition } from '@/adapters/api/workflows-client'

/** Normalize a possibly-undefined free-text block to a trimmed string. */
const clean = (value: string | undefined | null): string => (value ?? '').trim()

/**
 * Compile a definition into the Markdown research brief. Pure and
 * deterministic: identical input always yields identical output, and empty
 * sections are omitted entirely (no dangling headings).
 */
export function compilePreview(definition: WorkflowDefinition): string {
  const blocks = definition.blocks ?? { objective: '' }
  const sections: string[] = []

  // Headings use `#` to match the server compiler (src/lib/workflows/compiler.ts)
  // byte-for-byte — the WYSIWYG contract depends on it.
  const objective = clean(blocks.objective)
  if (objective) sections.push(`# Objective\n\n${objective}`)

  const context = clean(blocks.context)
  if (context) sections.push(`# Background & Context\n\n${context}`)

  const questions = (blocks.questions ?? []).map((q) => clean(q)).filter(Boolean)
  if (questions.length > 0) {
    const list = questions.map((q, index) => `${index + 1}. ${q}`).join('\n')
    sections.push(`# Research questions\n\n${list}`)
  }

  const outputFormat = clean(blocks.outputFormat)
  if (outputFormat) sections.push(`# Output requirements\n\n${outputFormat}`)

  return sections.join('\n\n')
}

/**
 * Maximum compiled length accepted by the backend (JobSubmitRequest.input).
 * Kept as a local literal so this client chunk doesn't pull in
 * `@/lib/workflows/types` (and its cron-parser dependency); the spec asserts
 * it equals the server-side MAX_COMPILED_PROMPT_LENGTH, so drift fails CI.
 */
export const MAX_COMPILED_PROMPT_LENGTH = 32000
