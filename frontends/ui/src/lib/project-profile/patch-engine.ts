// Pure, isomorphic (client- and server-safe) JSON-pointer patch engine for the
// project profile. Kept free of any database / server-only imports so the intake
// wizard can build its profile through the exact same engine that chat-driven
// profile edits (ProjectProfilePatchCard) use — a single source of truth for how
// a ProjectProfile is shaped and validated.
import { ProjectProfilePatchOperationSchema, ProjectProfileSchema, safePatchPath } from './types'
import type { ProjectProfile, ProjectProfilePatchOperation } from './types'

const UNSAFE_POINTER_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

/** A fresh, schema-valid empty profile — the base every intake build patches onto. */
export function emptyProjectProfile(): ProjectProfile {
  return ProjectProfileSchema.parse({})
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
  if (!safePatchPath.test(path)) {
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
