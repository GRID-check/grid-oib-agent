/**
 * GRID-authored default workflow templates.
 *
 * These are visible to every user in the Workflows tab and pre-fill the builder
 * on selection — they NEVER auto-create a workflow (the user always reviews the
 * pre-filled brief and saves it themselves). The product decision that
 * `knowledge_layer` is always included server-side means templates only declare
 * their ADDITIONAL data sources here.
 *
 * The typed template defs below carry structure (id, i18n key prefix, question
 * count, additional data sources, suggested schedule). The human-readable
 * content (name/description/objective/context/questions/outputFormat) lives in
 * the en/de dictionaries under `workflows.templates.<i18nKey>` so it stays
 * localized; `resolveTemplate(t, id)` stitches the two together into a shape the
 * builder can consume directly.
 */

import type { Translator } from '@/i18n'
import type { WorkflowDefinition } from '@/adapters/api/workflows-client'

/** Structural definition of a default template (content is in the dictionaries). */
export interface WorkflowTemplate {
  /** Stable id (also the value passed around the UI). */
  readonly id: string
  /** Key under `workflows.templates` holding this template's localized content. */
  readonly i18nKey: string
  /** How many `questions.qN` keys the dictionary provides for this template. */
  readonly questionCount: number
  /** Additional data sources beyond the always-included knowledge layer. */
  readonly dataSources: readonly string[]
  /** Suggested 5-field cron; omitted = manual-only template. */
  readonly scheduleCron?: string
  /** IANA timezone for the suggested schedule. */
  readonly scheduleTimezone?: string
}

/** The GRID default templates, in display order. */
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: 'regulatory-watch',
    i18nKey: 'regulatoryWatch',
    questionCount: 5,
    dataSources: ['ris', 'web_search'],
    scheduleCron: '0 6 * * 1',
    scheduleTimezone: 'Europe/Vienna',
  },
  {
    id: 'compliance-gap-check',
    i18nKey: 'complianceGapCheck',
    questionCount: 5,
    dataSources: [],
  },
]

/** A template with its localized content resolved, ready to pre-fill the builder. */
export interface ResolvedTemplate {
  id: string
  name: string
  description: string
  definition: WorkflowDefinition
  /** Additional data sources (knowledge layer is always included server-side). */
  dataSources: string[]
  scheduleCron?: string
  scheduleTimezone?: string
}

/** Look up a template def by id. */
export function getTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((template) => template.id === id)
}

/**
 * Resolve a template's localized content via the (workflows-scoped) translator
 * into a shape the builder can pre-fill from. Returns `null` for an unknown id.
 */
export function resolveTemplate(t: Translator, id: string): ResolvedTemplate | null {
  const template = getTemplate(id)
  if (!template) return null

  const base = `templates.${template.i18nKey}`
  const questions = Array.from({ length: template.questionCount }, (_, index) =>
    t(`${base}.questions.q${index + 1}`),
  ).filter(Boolean)
  const context = t(`${base}.context`)
  const outputFormat = t(`${base}.outputFormat`)

  const definition: WorkflowDefinition = {
    version: 1,
    blocks: {
      objective: t(`${base}.objective`),
      context: context || undefined,
      questions: questions.length > 0 ? questions : undefined,
      outputFormat: outputFormat || undefined,
    },
  }

  return {
    id: template.id,
    name: t(`${base}.name`),
    description: t(`${base}.description`),
    definition,
    dataSources: [...template.dataSources],
    scheduleCron: template.scheduleCron,
    scheduleTimezone: template.scheduleTimezone,
  }
}

/** Resolve every default template, dropping any that fail to resolve. */
export function resolveAllTemplates(t: Translator): ResolvedTemplate[] {
  return WORKFLOW_TEMPLATES.map((template) => resolveTemplate(t, template.id)).filter(
    (resolved): resolved is ResolvedTemplate => resolved !== null,
  )
}
