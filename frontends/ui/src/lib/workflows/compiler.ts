/**
 * Workflow prompt compiler (ADR-0023, docs/architecture/workflows.md).
 *
 * `compileWorkflowPrompt` is a PURE, DETERMINISTIC function: the same definition
 * always yields byte-for-byte the same Markdown brief. It runs once at save time
 * (stored on `workflows.compiled_prompt`), and the editor preview renders the
 * identical output — that is the WYSIWYG contract: the preview IS what the agent
 * receives. Empty sections are omitted; the compiled length is capped.
 */

import { BadRequestError } from '@/lib/api/errors'
import { MAX_COMPILED_PROMPT_LENGTH, type WorkflowDefinition } from './types'

/**
 * Compile a version-1 definition into a structured research brief.
 * Sections, in fixed order: Objective / Background & Context / Research
 * questions / Output requirements. Only Objective is mandatory; any section
 * whose block is empty is omitted entirely (no empty headings).
 */
export function compileWorkflowPrompt(definition: WorkflowDefinition): string {
  const { blocks } = definition
  const sections: string[] = []

  const objective = (blocks.objective ?? '').trim()
  if (!objective) {
    throw new BadRequestError('Workflow objective is required.')
  }
  sections.push(`# Objective\n\n${objective}`)

  const context = (blocks.context ?? '').trim()
  if (context) {
    sections.push(`# Background & Context\n\n${context}`)
  }

  const questions = (blocks.questions ?? []).map((q) => q.trim()).filter((q) => q.length > 0)
  if (questions.length > 0) {
    const list = questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
    sections.push(`# Research questions\n\n${list}`)
  }

  const outputFormat = (blocks.outputFormat ?? '').trim()
  if (outputFormat) {
    sections.push(`# Output requirements\n\n${outputFormat}`)
  }

  const compiled = sections.join('\n\n')

  if (compiled.length > MAX_COMPILED_PROMPT_LENGTH) {
    throw new BadRequestError(
      `Compiled workflow prompt is ${compiled.length} characters, exceeding the ${MAX_COMPILED_PROMPT_LENGTH}-character limit. Shorten the brief.`,
    )
  }

  return compiled
}
