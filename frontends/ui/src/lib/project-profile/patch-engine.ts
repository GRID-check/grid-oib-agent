// Pure, isomorphic (client- and server-safe) JSON-pointer patch engine for the
// project profile. Kept free of any database / server-only imports so the intake
// wizard can build its profile through the exact same engine that chat-driven
// profile edits (ProjectProfilePatchCard) use — a single source of truth for how
// a ProjectProfile is shaped and validated.
import {
  ProjectPrimitiveValueSchema,
  ProjectProfilePatchOperationSchema,
  ProjectProfileSchema,
  safePatchPath,
} from './types'
import type { ProjectProfile, ProjectProfilePatchOperation } from './types'

const UNSAFE_POINTER_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

/** A fresh, schema-valid empty profile — the base every intake build patches onto. */
export function emptyProjectProfile(): ProjectProfile {
  return ProjectProfileSchema.parse({})
}

export function applyProjectProfilePatch(
  profile: ProjectProfile,
  patch: ProjectProfilePatchOperation[]
): ProjectProfile {
  const next = structuredClone(ProjectProfileSchema.parse(profile))

  for (const operation of patch) {
    assertSafePath(operation.path)
    const parsedOperation = ProjectProfilePatchOperationSchema.parse(operation)
    applyPatchOperation(next, parsedOperation)
  }

  return ProjectProfileSchema.parse(next)
}

function applyPatchOperation(
  profile: ProjectProfile,
  operation: ProjectProfilePatchOperation
): void {
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

function applyArrayOperation(
  parent: unknown[],
  key: string,
  operation: ProjectProfilePatchOperation
): void {
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

/**
 * Would applying `patch` still change anything that matters?
 *
 * This is what tells the two kinds of optimistic-lock conflict apart. A
 * collaborator who accepted the SAME patch card a moment earlier leaves the
 * profile already holding the change — the work is done, and refusing the loser
 * would re-offer a button whose job is finished. Any OTHER concurrent write (a
 * wizard save, a different patch) means these operations never landed, and the
 * caller must be told so it can retry.
 *
 * Provenance instants are ignored: {@link normalizeProfilePatchOperations}
 * stamps `updatedAt` at apply time, so the same value re-applied is a different
 * object yet semantically a no-op.
 */
export function isPatchAlreadyApplied(
  profile: ProjectProfile,
  patch: ProjectProfilePatchOperation[]
): boolean {
  const settle = (value: ProjectProfile) => pruneResolvedAssumptions(pruneResolvedUnknowns(value))
  return equalIgnoringInstants(
    settle(applyProjectProfilePatch(profile, patch)),
    // Through the same engine with no operations, so both sides are compared in
    // the schema's canonical shape rather than raw jsonb against parsed output.
    settle(applyProjectProfilePatch(profile, []))
  )
}

function equalIgnoringInstants(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => equalIgnoringInstants(item, b[index]))
    )
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysOf = (value: Record<string, unknown>) =>
      Object.keys(value)
        .filter((key) => key !== 'updatedAt')
        .sort()
    const keys = keysOf(a)
    const otherKeys = keysOf(b)
    return (
      keys.length === otherKeys.length &&
      keys.every((key, index) => key === otherKeys[index]) &&
      keys.every((key) => equalIgnoringInstants(a[key], b[key]))
    )
  }
  return a === b
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize agent/user-friendly patch operations into schema-valid ones.
 *
 * The agent's ProjectProfilePatchCard proposes bare values ("GK4") because the
 * model cannot know write-time provenance. On accept, a bare value written to
 * `/facts/<key>` is wrapped into a full {@link ProjectFact} with
 * `source: 'user_confirmed'` (accepting the card IS the confirmation), and a
 * bare value written to `/assumptions/<key>` becomes an unconfirmed
 * agent-suggested {@link ProjectAssumption}. Already-complete objects and every
 * other path pass through untouched.
 */
export function normalizeProfilePatchOperations(
  patch: ProjectProfilePatchOperation[],
  now: string = new Date().toISOString()
): ProjectProfilePatchOperation[] {
  return patch.map((operation) => {
    if (operation.op === 'remove') return operation

    const factKey = matchTopLevelKey(operation.path, 'facts')
    if (factKey && isBareValue(operation.value)) {
      return {
        ...operation,
        value: {
          value: operation.value,
          confidence: 'confirmed',
          source: 'user_confirmed',
          updatedAt: now,
        },
      }
    }

    const assumptionKey = matchTopLevelKey(operation.path, 'assumptions')
    if (assumptionKey && isBareValue(operation.value)) {
      return {
        ...operation,
        value: {
          value: operation.value,
          status: 'unconfirmed',
          reason: '',
          source: 'agent_suggested',
          updatedAt: now,
        },
      }
    }

    return operation
  })
}

/**
 * Drop unknowns that have since been answered: once a fact exists under the
 * same key, "Piloti still doesn't know X" is stale. Also dedupes the list.
 */
export function pruneResolvedUnknowns(profile: ProjectProfile): ProjectProfile {
  const unknowns = [...new Set(profile.unknowns)].filter((key) => !(key in profile.facts))
  if (unknowns.length === profile.unknowns.length) return profile
  return { ...profile, unknowns }
}

/**
 * Drop assumptions superseded by a confirmed fact under the same key: once the
 * user has answered (wizard, patch card, or Brief confirm), the unconfirmed
 * default must not linger next to the fact — a stale `bundesland=wien`
 * assumption beside a confirmed `bundesland=tirol` fact would feed the agent
 * two contradictory jurisdictions.
 */
export function pruneResolvedAssumptions(profile: ProjectProfile): ProjectProfile {
  const stale = Object.keys(profile.assumptions).filter((key) => key in profile.facts)
  if (stale.length === 0) return profile
  const assumptions = { ...profile.assumptions }
  for (const key of stale) delete assumptions[key]
  return { ...profile, assumptions }
}

/** `/facts/<key>` (exactly one segment below the section) → `<key>`, else null. */
function matchTopLevelKey(path: string, section: 'facts' | 'assumptions'): string | null {
  const parts = path.split('/')
  if (parts.length !== 3 || parts[1] !== section || !parts[2] || parts[2] === '-') return null
  return decodeJsonPointerSegment(parts[2])
}

/** A raw primitive/array value, as opposed to an already-shaped fact/assumption object. */
function isBareValue(value: unknown): boolean {
  return ProjectPrimitiveValueSchema.safeParse(value).success
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
