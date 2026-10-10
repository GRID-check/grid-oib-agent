/**
 * Executed-step chips for the Herleitung basis area, and the one naming table
 * for a tool.
 *
 * "What actually ran": one compact chip per KIND of work, in run order, from
 * the turn's `tool` and `skill` steps (docs/design/chat-wire-v2.md §e.3). A
 * chip marked `running` belongs to a step still in progress.
 *
 * Two rules decide what gets a chip, and both are about the reader:
 *
 * 1. Only ACTIVITY. A skill earns a chip once it is `activated` or `loaded`;
 *    one that was merely `offered`, or is `hidden`, is availability.
 * 2. Only work we can NAME in the reader's own nouns. A tool basename with no
 *    entry in `TOOL_LABEL_KEYS` gets no chip; it stays visible in the opt-in
 *    technical panel, verbatim.
 */

import { skillActivityOf, skillLabel } from '@/features/skills/lib/skill-activity'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'

export interface ExecutedStep {
  /** Dedup key: the label for a tool chip, `skill:<id>` for a skill chip. */
  key: string
  /** Full chip text — `prefix` + `mono` when those are set. */
  label: string
  /** Leading, proportional part of the label (e.g. `Skill:`). Set only with `mono`. */
  prefix?: string
  /** Trailing machine identifier, rendered `font-mono`: a skill's bare id when it has no title. */
  mono?: string
  /** Whether this chip stands for a skill (they are live-only; see ChatThinking). */
  skill?: boolean
  running: boolean
}

/**
 * Tool basename → `chat.thinking.stepName.*` key. Exact names only: the wire
 * sends the basename the callback saw, so there is nothing to pattern-match.
 * Several tools share one chip because a chip is a kind of work, not a call
 * („RIS", not „RIS, RIS, RIS").
 */
const TOOL_LABEL_KEYS: Record<string, string> = {
  web_search_tool: 'webSearch',
  advanced_web_search_tool: 'webSearch',
  ris_search_tool: 'ris',
  ris_fetch_tool: 'ris',
  ris_lookup_tool: 'ris',
  ris_catalog_lookup_tool: 'ris',
  knowledge_search: 'corpus',
  // The office's other projects (ADR-0094): the live line says „in anderen
  // Projekten“, and the settled Herleitung must still say the chat left its own.
  project_lookup: 'otherProjects',
  read_passage: 'reading',
  ifc_query: 'model',
  ifc_measure: 'measure',
  view_knowledge_image: 'drawing',
  surface_documents: 'documents',
  list_files: 'documents',
  remember: 'note',
  emit_card: 'card',
  compliance_check: 'compliance',
  // The working directory: four verbs over a conversation's own scratch, and
  // ONE chip between them. Filing leaves it, so it has its own.
  write_file: 'draft',
  read_file: 'draft',
  edit_file: 'draft',
  ls: 'draft',
  file_draft: 'filing',
  // Merged into `file_draft` (its `submit` argument); the old name stays
  // because stored turns carry it.
  submit_draft: 'filing',
  create_task: 'task',
  // The file-operation tool proposes and never writes (ADR-0003). One tool
  // with an `operation` since the merge; the four old names stay because
  // stored turns carry them.
  propose_file_change: 'fileProposal',
  move_document: 'fileProposal',
  rename_document: 'fileProposal',
  create_folder: 'fileProposal',
  assign_document: 'fileProposal',
  set_doc_class: 'fileProposal',
}

/**
 * The reader-facing noun for a tool basename, or `null` when we have none.
 * The Herleitung's truncation line and fan captions use the same answer.
 */
export const stepNameLabel = (tool: string, t: (key: string) => string): string | null => {
  const key = TOOL_LABEL_KEYS[tool]
  return key ? t(`thinking.stepName.${key}`) : null
}

/** The skill chip for a `skill` step, or `null` to drop it. */
const skillChip = (
  step: Pick<StoredThinkingStep, 'kind' | 'skill' | 'detail' | 'turnEvent'>,
  t: (key: string) => string
): Pick<ExecutedStep, 'key' | 'label' | 'prefix' | 'mono'> | null => {
  const activity = skillActivityOf(step)
  if (!activity || activity.phase === 'offered' || activity.hidden) return null
  const named = skillLabel(activity)
  if (!named) return null
  const key = `skill:${activity.name ?? named.text}`
  const template = t('thinking.stepName.skill')
  const label = template.replace('{name}', named.text)
  if (!named.mono) return { key, label }
  return { key, label, prefix: template.split('{name}')[0].trim(), mono: named.text }
}

/** The chip for a `tool` step, keyed by its label so tools of one kind share it. */
const toolChip = (
  step: Pick<StoredThinkingStep, 'kind' | 'tool'>,
  t: (key: string) => string
): Pick<ExecutedStep, 'key' | 'label'> | null => {
  const label = step.kind === 'tool' && step.tool ? stepNameLabel(step.tool, t) : null
  return label ? { key: label, label } : null
}

/**
 * @param steps  the turn's steps (newest last)
 * @param t      a `chat`-namespace translator
 */
export const deriveExecutedSteps = (
  steps: readonly Pick<
    StoredThinkingStep,
    'kind' | 'tool' | 'skill' | 'detail' | 'turnEvent' | 'isComplete' | 'scope'
  >[],
  t: (key: string) => string
): ExecutedStep[] => {
  const seen = new Map<string, ExecutedStep>()
  for (const step of steps) {
    if (step.scope === 'deep') continue
    const chip = step.kind === 'skill' ? skillChip(step, t) : toolChip(step, t)
    if (!chip) continue
    const existing = seen.get(chip.key)
    // Steps are newest last, so a later step under the same chip decides
    // whether it is still running.
    if (existing) {
      existing.running = !step.isComplete
      continue
    }
    seen.set(chip.key, {
      ...chip,
      ...(step.kind === 'skill' ? { skill: true } : {}),
      running: !step.isComplete,
    })
  }
  return Array.from(seen.values())
}
