/**
 * @vitest-environment node
 */
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
 *
 * ## Both directions, and why one of them needed real evidence
 *
 * The relationship has two sides and they fail differently:
 *
 *   - **union ⊆ schemas** — an action the app emits with no registered schema.
 *     That is #255/#256: WorkOS rejects the event, the non-throwing emitter
 *     swallows it, and one ERROR log per privileged mutation is the only sign.
 *     This side is CLOSED BY CONSTRUCTION — `AUDIT_ACTIONS` is
 *     `Object.keys(AUDIT_SCHEMAS)` and `tsc` confines every `recordAuditEvent`
 *     call site to that union — so an emit with no schema does not compile.
 *   - **schemas ⊆ union** — a schema registered for an action nothing emits.
 *     Harmless in production and corrosive in the registry: a dead entry is one
 *     more thing the next reader has to decide is deliberate, and the entries
 *     around it are the only documentation of what a call site really sends.
 *
 * The second side was NOT actually checked. The test that claimed to check it
 * compared `Object.keys(AUDIT_SCHEMAS)` against `AUDIT_ACTIONS`, which IS
 * `Object.keys(AUDIT_SCHEMAS)` — a set against itself, green for any registry
 * including one full of actions nobody emits. So the emitted side is now read
 * off the CALL SITES: the files that call `recordAuditEvent` (or the throwing
 * variant), and the action literals in them.
 *
 * That scan deliberately OVER-collects — it takes every quoted string on an
 * `action:` line, so a ternary picking between two actions contributes both —
 * which is exactly the right bias for the direction it is used in. It can prove
 * an action IS emitted somewhere; it can never be used to argue one is not, and
 * it is not used that way. The other direction stays where it belongs: with the
 * compiler.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { AUDIT_ACTIONS, AUDIT_SCHEMAS } from './schemas.mjs'
import { AUTHORED_REF_KINDS } from '@/lib/documents/document-authors'

/** `src/`, from this file's own location rather than from the process cwd. */
const SOURCE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Every non-spec TypeScript file under `src/`. */
function sourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path))
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    // A spec asserting on an action is not an emit of it. Including them would
    // make a schema look emitted because a test mentions it.
    if (/\.(spec|test)\.tsx?$/.test(entry.name)) continue
    found.push(path)
  }
  return found
}

/**
 * The actions the code actually hands to the emitter.
 *
 * Read from the files that CALL it, so this set is evidence about the app
 * rather than a second reading of the registry — which is the whole point, and
 * the reason the test below is no longer a set compared with itself.
 */
const EMITTED_ACTIONS: ReadonlySet<string> = new Set(
  sourceFiles(SOURCE_ROOT)
    .map((path) => readFileSync(path, 'utf8'))
    .filter((text) => text.includes('recordAuditEvent'))
    .flatMap((text) =>
      [...text.matchAll(/\baction:\s*(.+)/g)].flatMap(([, expression]) =>
        [...expression.matchAll(/'([a-z_.]+)'/g)].map(([, action]) => action),
      ),
    ),
)

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
    // The OTHER direction, and the one that was never really tested: this used
    // to compare `Object.keys(AUDIT_SCHEMAS)` with `AUDIT_ACTIONS`, which is the
    // same array, so it was green for a registry containing an action no call
    // site has ever passed. `EMITTED_ACTIONS` comes from the call sites.
    const orphans = Object.keys(REGISTRY).filter((action) => !EMITTED_ACTIONS.has(action))
    expect(orphans).toEqual([])
  })

  it('finds the emitters at all — the scan is evidence, not an empty set', () => {
    // Without this, the guard above passes for the worst possible reason: a
    // `sourceFiles` that returns nothing, or a regex that matches nothing, makes
    // EVERY schema an orphan — which fails loudly — but a scan that collects
    // every string in the repository would make every schema look emitted and
    // fail silently. Naming a handful of call sites is what tells the two apart.
    expect(EMITTED_ACTIONS.size).toBeGreaterThanOrEqual(AUDIT_ACTIONS.length)
    expect(EMITTED_ACTIONS).toContain('document.generated')
    // Picked by a ternary at one call site each, which is why the scan reads the
    // whole `action:` expression rather than a literal immediately after it.
    expect(EMITTED_ACTIONS).toContain('llm_credential.created')
    expect(EMITTED_ACTIONS).toContain('llm_credential.rotated')
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

  it('gives document.generated its own action, with what produced it as a target', () => {
    // Its own action rather than a flag on `document.uploaded`: the provenance
    // question is different, and the reference must be a structured identity
    // rather than an optional metadata key that is absent on almost every
    // event of the action it would be bolted onto.
    const generated = REGISTRY['document.generated']
    expect(generated.targets.map((target) => target.type)).toEqual([
      'document',
      'agent_run',
      'answer_artifact',
    ])
    // The reference rides as a target, so it must NOT also be a metadata key —
    // two carriers for one fact is how the two lists behind #255/#256 drifted.
    expect(Object.keys(generated.metadata ?? {})).not.toContain('runId')
  })

  it('registers EVERY reference kind an agent-authored event can carry, and no other', () => {
    // `eventTargets` uses the reference's own kind as the target type, so this
    // list and `AUTHORED_REF_KINDS` are one vocabulary in two files. A kind
    // added there and missing here is not a lost audit line: `document.generated`
    // uses the THROWING emitter, so WorkOS rejecting the event unfiles the
    // document the event was about, and the user sees a report with no file and
    // no error. That exact failure has shipped once already, from a single
    // unregistered metadata key.
    const registered = REGISTRY['document.generated'].targets.map((target) => target.type)
    for (const kind of AUTHORED_REF_KINDS) expect(registered, kind).toContain(kind)

    // And back the other way, for the same reason the action guard now runs in
    // both directions: a target type registered here that no reference kind can
    // produce is a dead entry in the one list a reader consults to find out what
    // this event really carries. `document` is the event's own subject and is
    // not a reference kind, so it is the one member named here.
    const emittable = new Set<string>(['document', ...AUTHORED_REF_KINDS])
    expect(registered.filter((type) => !emittable.has(type))).toEqual([])
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
