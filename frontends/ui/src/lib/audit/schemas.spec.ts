/**
 * The coverage gate for issues #255/#256: an action the app emits without a
 * registered WorkOS schema is a runtime 400 on every privileged mutation
 * ("event 'resource.shared', version '1' has not been configured in this
 * environment"), swallowed by the non-throwing emitter and visible only as an
 * ERROR log. Nine actions drifted that way while two hand-maintained lists
 * pretended to be one.
 *
 * Deriving `AUDIT_ACTIONS` from the schema keys already makes the gap
 * unrepresentable; this file is the belt to that suspenders, and it runs
 * offline — no WorkOS API key, no network. The `Record<AuditAction, …>`
 * annotation below is half the gate on its own: it makes `npm run type-check`
 * fail (the UI tsconfig includes specs) before vitest is ever reached.
 */
import { describe, expect, it } from 'vitest'

import { AUDIT_ACTIONS, AUDIT_SCHEMAS } from './schemas.mjs'

type AuditAction = keyof typeof AUDIT_SCHEMAS

/** What WorkOS accepts as a metadata property type — see schemas.mjs. */
const METADATA_TYPES = ['string', 'number', 'boolean'] as const
type MetadataType = (typeof METADATA_TYPES)[number]

interface AuditSchemaSpec {
  readonly targets: readonly { readonly type: string }[]
  readonly metadata?: Readonly<Record<string, MetadataType>>
}

/** Exhaustive by construction: a missing action is a compile error here. */
const REGISTRY: Record<AuditAction, AuditSchemaSpec> = AUDIT_SCHEMAS

describe('audit schema coverage', () => {
  it('registers a schema for every action the app may emit', () => {
    const withoutSchema = AUDIT_ACTIONS.filter((action) => !REGISTRY[action])
    expect(withoutSchema).toEqual([])
  })

  it('emits every action it registers a schema for — no orphan schemas', () => {
    const emitted = new Set<string>(AUDIT_ACTIONS)
    const orphans = Object.keys(REGISTRY).filter((action) => !emitted.has(action))
    expect(orphans).toEqual([])
  })

  it('lists each action exactly once', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length)
  })

  it('covers the actions reported by issues #255 and #256', () => {
    // The two that reached production unregistered. Named explicitly so a
    // future refactor that drops them fails with the issue number attached.
    expect(AUDIT_ACTIONS).toContain('resource.shared')
    expect(AUDIT_ACTIONS).toContain('resource.ownership.escalated')
  })

  it('names at least one target type per action — WorkOS requires one', () => {
    for (const [action, schema] of Object.entries(REGISTRY)) {
      expect(schema.targets.length, action).toBeGreaterThan(0)
      for (const target of schema.targets) expect(target.type, action).toBeTruthy()
    }
  })

  it('declares metadata as WorkOS TYPE NAMES, never example values', () => {
    // The regression this guards: the SDK passes each metadata value straight
    // through as `{ type: <value> }`, so `{ name: 'Example Org' }` registers a
    // property of type "Example Org" and every real event fails validation.
    for (const [action, schema] of Object.entries(REGISTRY)) {
      for (const [key, type] of Object.entries(schema.metadata ?? {})) {
        expect(METADATA_TYPES, `${action}.${key}`).toContain(type)
      }
    }
  })
})
