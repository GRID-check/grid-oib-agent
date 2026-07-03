import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { ProjectProfileSchema } from './types'
import type { ProjectPrimitiveValue, ProjectProfile, ProjectProfileDisplay } from './types'

// Re-exported so existing server-side importers (profile / patches routes, tests)
// keep a single import surface; the engine itself now lives in the isomorphic
// patch-engine module so the intake wizard can share it.
export { applyProjectProfilePatch, emptyProjectProfile } from './patch-engine'

const promptViewCache = new Map<string, { data: string | null; timestamp: number }>()
const PROMPT_VIEW_CACHE_TTL_MS = 5 * 60 * 1000

export async function loadProjectPromptView(projectId: string | undefined): Promise<string | null> {
  if (!projectId) return null

  const cached = promptViewCache.get(projectId)
  if (cached && Date.now() - cached.timestamp < PROMPT_VIEW_CACHE_TTL_MS) {
    return cached.data
  }

  const db = getDb()
  const [project] = await db
    .select({ profilePromptView: projects.profilePromptView })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  const promptView = project?.profilePromptView?.trim()
  const result = promptView || null

  promptViewCache.set(projectId, { data: result, timestamp: Date.now() })
  return result
}

export function invalidateProjectPromptViewCache(projectId: string): void {
  promptViewCache.delete(projectId)
}

export function buildProjectPromptView(profile: ProjectProfile): string {
  const normalized = ProjectProfileSchema.parse(profile)
  const sections: string[][] = [['PROJECT_CONTEXT v1']]

  const factKeys = Object.keys(normalized.facts).sort()
  if (factKeys.length > 0) {
    sections.push([
      'confirmed:',
      ...factKeys.map((key) => `- ${formatPromptToken(key)}=${formatPromptValue(normalized.facts[key].value)}`),
    ])
  }

  const goalKeys = Object.keys(normalized.goals).sort()
  if (goalKeys.length > 0) {
    sections.push([
      'goals:',
      ...goalKeys.map((key) => `- ${formatPromptToken(key)}=${formatPromptValue(normalized.goals[key])}`),
    ])
  }

  const unknowns = [...normalized.unknowns].sort()
  if (unknowns.length > 0) {
    sections.push(['unknown:', ...unknowns.map((unknown) => `- ${formatPromptToken(unknown)}`)])
  }

  const assumptionKeys = Object.keys(normalized.assumptions).sort()
  if (assumptionKeys.length > 0) {
    sections.push([
      'assumptions:',
      ...assumptionKeys.map((key) => `- ${formatPromptToken(key)}=${formatPromptValue(normalized.assumptions[key].value)}`),
    ])
  }

  return sections.map((section) => section.join('\n')).join('\n\n')
}

export function buildProjectProfileDisplay(profile: ProjectProfile): ProjectProfileDisplay {
  const normalized = ProjectProfileSchema.parse(profile)

  return {
    title: 'Project profile',
    summary: '',
    keyFacts: Object.keys(normalized.facts)
      .sort()
      .map((key) => ({
        label: key.replaceAll('_', ' '),
        value: formatDisplayValue(normalized.facts[key].value),
      })),
    missingInfo: [...normalized.unknowns].sort(),
  }
}

function formatPromptToken(value: string): string {
  return isSafePromptToken(value) ? value : JSON.stringify(value).replace(/[\u0080-\u009f\u2028\u2029]/g, escapeLineSeparator)
}

function formatPromptValue(value: ProjectPrimitiveValue): string {
  if (typeof value === 'string') {
    return formatPromptToken(value)
  }

  return String(value)
}

function isSafePromptToken(value: string): boolean {
  return !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
}

function escapeLineSeparator(value: string): string {
  return `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`
}

function formatDisplayValue(value: ProjectPrimitiveValue): string {
  if (value === null) return ''

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No'
  }

  return String(value)
}
