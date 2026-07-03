import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { ProjectProfilePatchOperationSchema, ProjectProfileSchema } from './types'
import type { ProjectPrimitiveValue, ProjectProfile, ProjectProfileDisplay, ProjectProfilePatchOperation } from './types'

const SAFE_PATCH_PATH = /^\/(facts|goals|unknowns|assumptions)(\/.*)?$/
const UNSAFE_POINTER_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

export async function loadProjectPromptView(projectId: string | undefined): Promise<string | null> {
  if (!projectId) return null
  const db = getDb()
  const [project] = await db
    .select({ profilePromptView: projects.profilePromptView })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  const promptView = project?.profilePromptView?.trim()
  return promptView || null
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

export function applyProjectProfilePatch(
  profile: ProjectProfile,
  patch: ProjectProfilePatchOperation[],
): ProjectProfile {
  const next = structuredClone(ProjectProfileSchema.parse(profile))

  for (const operation of patch) {
    assertSafePath(operation.path)
    const parsedOperation = ProjectProfilePatchOperationSchema.parse(operation)
    applyPatchOperation(next, parsedOperation)
  }

  return ProjectProfileSchema.parse(next)
}

function applyPatchOperation(profile: ProjectProfile, operation: ProjectProfilePatchOperation): void {
  const parts = operation.path.split('/').slice(1).map(decodeJsonPointerSegment)
  parts.forEach((part) => assertSafePointerSegment(part, operation.path))
  const key = parts.at(-1)
  if (!key) {
    throw new Error(`Unsafe project profile patch path: ${operation.path}`)
  }

  const parent = parts.slice(0, -1).reduce<unknown>((target, part) => {
    if (!isObjectLike(target)) {
      throw new Error(`Unsafe project profile patch path: ${operation.path}`)
    }

    if (Array.isArray(target)) {
      const index = Number(part)
      if (!Number.isInteger(index) || index < 0 || index >= target.length) {
        throw new Error(`Unsafe project profile patch path: ${operation.path}`)
      }
      return target[index]
    }

    if (!Object.prototype.hasOwnProperty.call(target, part)) {
      throw new Error(`Unsafe project profile patch path: ${operation.path}`)
    }

    return target[part]
  }, profile)

  if (!isObjectLike(parent)) {
    throw new Error(`Unsafe project profile patch path: ${operation.path}`)
  }

  if (Array.isArray(parent)) {
    applyArrayOperation(parent, key, operation)
    return
  }

  if (operation.op === 'remove') {
    delete parent[key]
    return
  }

  parent[key] = operation.value
}

function applyArrayOperation(parent: unknown[], key: string, operation: ProjectProfilePatchOperation): void {
  if (operation.op === 'add' && key === '-') {
    parent.push(operation.value)
    return
  }

  const index = Number(key)
  if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
    throw new Error(`Unsafe project profile patch path: ${operation.path}`)
  }

  if (operation.op === 'remove') {
    parent.splice(index, 1)
    return
  }

  parent[index] = operation.value
}

function assertSafePath(path: string): void {
  if (!SAFE_PATCH_PATH.test(path)) {
    throw new Error(`Unsafe project profile patch path: ${path}`)
  }
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~')
}

function assertSafePointerSegment(segment: string, path: string): void {
  if (UNSAFE_POINTER_SEGMENTS.has(segment)) {
    throw new Error(`Unsafe project profile patch path: ${path}`)
  }
}

function isObjectLike(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null
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
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No'
  }

  return String(value)
}
